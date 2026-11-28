import { copyFileToSCloud, selectDriveCopyAccount, selectDriveMetadataAccount } from "./drive-handler.js";
import {
    ensureScloudJobTables,
    newMirrorJobStatements,
    hasCronMirrorJobs,
    healScloudMirrorJobs,
    executeScloudMirrorJob,
    reconcileScloudJobs,
    executeScloudCleanupJob
} from "./scloud-job-core.js";
import {
    uploadToDrivetot,
    extractLinksFromDrivetot
} from "./drivetot-scraper.js";
import { bypassGDFlix } from "./gdflix-scraper.js";
import {
    queuePDLinkFile,
    getPDLinkMirrorLinks
} from "./pdlink.js";
import { uploadToToxCloud } from "./toxcloud.js";


// ==================================================
// DOWNLOAD WORKER METADATA SYNC
// ==================================================
// Explicitly configured secondary; no new traffic until enabled.
function getDownloadTargets(env, includeDisabled = false) {
    const make = (id, url, syncSecret, signSecret) => {
        try {
            const parsed = new URL(String(url || ""));
            if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
                parsed.pathname !== "/" || parsed.search || parsed.hash ||
                !syncSecret || !signSecret) return null;
            return { id, base: parsed.origin, syncSecret, signSecret };
        } catch { return null; }
    };
    const first = make("1", env.DOWNLOAD_WORKER_URL ||
        "https://scloud-download.scloud-download1.workers.dev", env.DOWNLOAD_SYNC_SECRET, env.SYNC_SECRET);
    const second = make("2", env.DOWNLOAD_WORKER_URL_2, env.DOWNLOAD_SYNC_SECRET_2, env.DOWNLOAD_SYNC_SECRET_2);
    const enabled = String(env.DOWNLOAD_WORKER_2_ENABLED || "false").toLowerCase() === "true";
    const distinct = first && second && first.base !== second.base &&
        first.syncSecret !== second.syncSecret && first.signSecret !== second.signSecret;
    return [first, (enabled || includeDisabled) && distinct ? second : null].filter(Boolean);
}

// Per-account download permission, independent of global API-key locks.
const DOWNLOAD_LOCK_COLUMNS = Object.freeze({
    gofile: "gofile_download_locked",
    pixeldrain: "pixeldrain_download_locked"
});
const controlledDownloadProvider = provider => Object.prototype.hasOwnProperty.call(DOWNLOAD_LOCK_COLUMNS, provider);
const accountDownloadLocked = (row, provider) => row?.[DOWNLOAD_LOCK_COLUMNS[provider]] !== 0;

async function getAccountMirrorVisibility(userId, env) {
    const visibility = {instant:true, toxcloud:true, gofile:false, pixeldrain:false, hubcloud:true, gdflix:true};
    const locked = {gofile:true,pixeldrain:true};
    if (userId == null) return {visibility, locked, ownerFound:false, failed:false};
    try {
        const result = await env.DB.prepare(`SELECT u.gofile_download_locked, u.pixeldrain_download_locked,
            m.provider, m.show_on_download FROM users u LEFT JOIN user_mirror_sites m ON m.user_id=u.id
            WHERE u.id=?`).bind(userId).all();
        const rows = result.results || [];
        if (!rows.length) return {visibility, locked, ownerFound:false, failed:false};
        for (const provider of Object.keys(DOWNLOAD_LOCK_COLUMNS)) {
            locked[provider] = accountDownloadLocked(rows[0], provider);
            visibility[provider] = !locked[provider];
        }
        for (const row of rows) {
            if (!Object.prototype.hasOwnProperty.call(visibility,row.provider)) continue;
            if (controlledDownloadProvider(row.provider) && accountDownloadLocked(row,row.provider)) continue;
            visibility[row.provider] = Number(row.show_on_download) !== 0;
        }
        return {visibility, locked, ownerFound:true, failed:false};
    } catch (error) {
        // Never unlock a paid mirror because its permission lookup failed.
        console.error("[DOWNLOAD POLICY] Account visibility lookup failed", error?.name || "Error");
        return {visibility, locked, ownerFound:false, failed:true};
    }
}

async function syncDownloadMetadata(record, env, selectedTargets = null) {
    const targets = selectedTargets || getDownloadTargets(env, record?.status === "deleted" || Number(record?.sharing_enabled ?? 1) === 0);
    if (!record || !targets.length) {
        console.error("[DOWNLOAD SYNC] Missing configuration");
        return false;
    }
    // For ordinary sync, refresh the authoritative row before building metadata.
    // The deletion path intentionally sends a tombstone before removing the row.
    const snapshotTime = Date.now();
    if (record.status !== "deleted") {
        try {
            const fresh = await env.DB.prepare("SELECT * FROM files WHERE short_id = ? LIMIT 1")
                .bind(String(record.short_id || record.id)).first();
            if (!fresh) return false;
            record = fresh;
        } catch (error) {
            console.error("[DOWNLOAD SYNC] Source refresh failed", error?.name || "Error");
            return false;
        }
    }

    // Shared By settings belong to the users table, not files.
    // Hydrate them here so every sync path (upload, /d/:id, mirror
    // updates, rename, sharing changes and self-healing) sends the
    // correct publisher settings to the Download Worker.
    let sharedByEnabled = record.shared_by_enabled;
    let sharedByName = record.shared_by;
    let sharedByUrl = record.shared_by_url;

    if (
        record.user_id != null &&
        (
            sharedByEnabled === undefined ||
            sharedByName === undefined ||
            sharedByUrl === undefined
        )
    ) {
        try {
            const publisherSettings = await env.DB
                .prepare(
                    `SELECT shared_by, shared_by_enabled, shared_by_url
                     FROM users
                     WHERE id = ?
                     LIMIT 1`
                )
                .bind(record.user_id)
                .first();

            if (publisherSettings) {
                sharedByEnabled ??= publisherSettings.shared_by_enabled;
                sharedByName ??= publisherSettings.shared_by;
                sharedByUrl ??= publisherSettings.shared_by_url;
            }
        } catch (sharedByError) {
            console.error(
                "[DOWNLOAD SYNC] Could not load Shared By settings:",
                sharedByError?.message || sharedByError
            );
        }
    }

    const status = record.status === "deleted"
        ? "deleted"
        : Number(record.sharing_enabled ?? 1) === 0
            ? "private"
            : "active";


    // Account admin locks override the user's display preference.
    const {visibility: mirrorVisibility} = await getAccountMirrorVisibility(record.user_id, env);

    const metadata = {
        short_id: String(record.short_id || record.id),
        file_name: String(record.file_name || "Download"),
        file_size: record.file_size ?? null,
        mime_type: record.mime_type || record.file_type || null,
        created_at: record.created_at || record.last_updated || null,
        shared_by_enabled: Number(sharedByEnabled ?? 0),
        shared_by: sharedByName || null,
        shared_by_url: sharedByUrl || null,
        mirror_visibility: mirrorVisibility,
        drive_url: record.drive_url || null,
        hubcloud_url: record.hubcloud_url || null,
        gdflix_url: record.gdflix_url || null,
        drivetot_url: record.drivetot_url || null,
        pdlink_share_id: record.pdlink_share_id || null,
        toxcloud_url: record.toxcloud_url || null,
        fast_links: record.fast_links || null,
        fast_links_expires_at: record.fast_links_expires_at || null,
        updated_at: record.updated_at || record.last_updated || null
    };

    // Capture version before reading the snapshot, not after network/DB work.
    const version = Math.max(snapshotTime, Number(record.download_sync_version || 0) + 1);
    const fileId = String(record.short_id || record.id);
    const payload = JSON.stringify({file_id: fileId, metadata: status === "active" ? metadata : {}, version, status});
    const results = await Promise.all(targets.map(async target => {
        try {
            const response = await fetch(`${target.base}/internal/sync`, {
                method: "POST", redirect: "manual", signal: AbortSignal.timeout(4500),
                headers: {"Content-Type": "application/json", "X-Sync-Secret": target.syncSecret},
                body: payload
            });
            const ack = response.ok ? await response.json() : null;
            // Existing receivers can report ignored stale writes without a status.
            // Do not treat these as confirmation of a private/deleted state.
            const confirmed = !!(ack?.ok && ack.file_id === fileId && ack.status === status &&
                (!ack.ignored ? ack.version === version : Number(ack.current_version) >= version));
            if (!confirmed) console.warn("[DOWNLOAD SYNC] Unconfirmed", {worker:target.id,fileId,status:response.status});
            return confirmed;
        } catch (error) {
            console.warn("[DOWNLOAD SYNC] Failed", {worker:target.id,fileId,error:error?.name || "Error"});
            return false;
        }
    }));
    return results.every(Boolean);
}

// ==================================================
// PER-USER UPLOAD POLICY (Manage Sites visibility)
// GoFile + Pixeldrain are a single shared PDLink upload:
//   either visible => PDLink runs; both hidden => skip.
// TOXCloud runs only while visible. Drivetot is independent.
// ==================================================
async function getMirrorUploadPolicy(userId, env) {
    const {visibility, ownerFound, failed} = await getAccountMirrorVisibility(userId, env);
    if (!ownerFound || failed) return {pdlink:false, toxcloud:false};
    return {pdlink:visibility.gofile || visibility.pixeldrain, toxcloud:visibility.toxcloud};
}

// ==================================================
// RANDOM SHORT ID GENERATOR
// ==================================================

function generateFileId(length = 8) {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    let result = "";

    for (
        let i = 0;
        i < length;
        i++
    ) {
        result += chars.charAt(
            Math.floor(
                Math.random() *
                chars.length
            )
        );
    }

    return result;
}


// ==================================================
// GOOGLE DRIVE FOLDER ID EXTRACTOR
// ==================================================

function extractFolderId(url) {
    const match =
        url.match(
            /\/folders\/([a-zA-Z0-9_-]+)/
        );

    return match
        ? match[1]
        : null;
}


// ==================================================
// GOOGLE OAUTH ACCESS TOKEN
// ==================================================

async function getAccessToken(
    clientId,
    clientSecret,
    refreshToken
) {
    const response =
        await fetch(
            "https://oauth2.googleapis.com/token",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                },
                body:
                    `client_id=${encodeURIComponent(clientId)}` +
                    `&client_secret=${encodeURIComponent(clientSecret)}` +
                    `&refresh_token=${encodeURIComponent(refreshToken)}` +
                    `&grant_type=refresh_token`
            }
        );

    const data =
        await response.json();

    if (
        !response.ok ||
        !data.access_token
    ) {
        throw new Error(
            "Access Token error: " +
            JSON.stringify(data)
        );
    }

    return data.access_token;
}


// ==================================================
// HEX HELPERS
// ==================================================

function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(
            byte =>
                byte
                    .toString(16)
                    .padStart(2, "0")
        )
        .join("");
}


function hexToBytes(hex) {
    if (
        !hex ||
        hex.length % 2 !== 0
    ) {
        throw new Error(
            "Invalid hex string"
        );
    }

    const bytes =
        new Uint8Array(
            hex.length / 2
        );

    for (
        let i = 0;
        i < hex.length;
        i += 2
    ) {
        bytes[i / 2] =
            parseInt(
                hex.slice(i, i + 2),
                16
            );
    }

    return bytes;
}


// ==================================================
// SHA-256 HASH
// ==================================================

async function sha256Hex(
    value
) {
    const data =
        new TextEncoder().encode(
            value
        );

    const hash =
        await crypto.subtle.digest(
            "SHA-256",
            data
        );

    return bytesToHex(
        new Uint8Array(hash)
    );
}


// ==================================================
// FIRST-PARTY VISITOR COOKIE
// ==================================================

function readCookie(request, name) {
    const cookieHeader =
        request.headers.get("Cookie") || "";

    for (const part of cookieHeader.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 0) continue;

        const key = part.slice(0, separator).trim();
        if (key !== name) continue;

        return part.slice(separator + 1).trim();
    }

    return null;
}

function createVisitorId() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(
        bytes,
        byte => byte.toString(16).padStart(2, "0")
    ).join("");
}


// ==================================================
// API KEY ENCRYPTION
// ==================================================

const API_KEY_ENCRYPTION_IV_BYTES =
    12;


async function getApiKeyEncryptionKey(
    env
) {
    const secret =
        String(
            env.API_KEY_ENCRYPTION_SECRET || ""
        );

    if (
        !secret
    ) {
        throw new Error(
            "API_KEY_ENCRYPTION_SECRET is not configured"
        );
    }

    const secretHash =
        await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
                secret
            )
        );

    return await crypto.subtle.importKey(
        "raw",
        secretHash,
        {
            name: "AES-GCM"
        },
        false,
        [
            "encrypt",
            "decrypt"
        ]
    );
}


async function encryptApiKey(
    apiKey,
    env
) {
    const iv =
        new Uint8Array(
            API_KEY_ENCRYPTION_IV_BYTES
        );

    crypto.getRandomValues(
        iv
    );

    const key =
        await getApiKeyEncryptionKey(
            env
        );

    const encrypted =
        await crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv
            },
            key,
            new TextEncoder().encode(
                apiKey
            )
        );

    return (
        bytesToHex(iv) +
        "." +
        bytesToHex(
            new Uint8Array(
                encrypted
            )
        )
    );
}


async function decryptApiKey(
    encryptedKey,
    env
) {
    if (
        !encryptedKey ||
        typeof encryptedKey !== "string"
    ) {
        return null;
    }

    const parts =
        encryptedKey.split(
            "."
        );

    if (
        parts.length !== 2
    ) {
        throw new Error(
            "Invalid encrypted API key format"
        );
    }

    const iv =
        hexToBytes(
            parts[0]
        );

    const encryptedBytes =
        hexToBytes(
            parts[1]
        );

    if (
        iv.length !==
        API_KEY_ENCRYPTION_IV_BYTES
    ) {
        throw new Error(
            "Invalid API key encryption IV"
        );
    }

    const key =
        await getApiKeyEncryptionKey(
            env
        );

    const decrypted =
        await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv
            },
            key,
            encryptedBytes
        );

    return new TextDecoder().decode(
        decrypted
    );
}


// ==================================================
// CONSTANT-TIME STRING COMPARE
// ==================================================

function safeEqual(
    a,
    b
) {
    if (
        typeof a !== "string" ||
        typeof b !== "string"
    ) {
        return false;
    }

    if (
        a.length !==
        b.length
    ) {
        return false;
    }

    let result = 0;

    for (
        let i = 0;
        i < a.length;
        i++
    ) {
        result |=
            a.charCodeAt(i) ^
            b.charCodeAt(i);
    }

    return result === 0;
}


// ==================================================
// PBKDF2 PASSWORD HASH
// ==================================================

const PBKDF2_ITERATIONS =
    100000;

const PBKDF2_SALT_BYTES =
    16;

const PBKDF2_KEY_BITS =
    256;


async function hashPassword(
    password
) {
    const salt =
        new Uint8Array(
            PBKDF2_SALT_BYTES
        );

    crypto.getRandomValues(
        salt
    );

    const passwordKey =
        await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(
                password
            ),
            {
                name: "PBKDF2"
            },
            false,
            [
                "deriveBits"
            ]
        );

    const derivedBits =
        await crypto.subtle.deriveBits(
            {
                name: "PBKDF2",
                salt: salt,
                iterations:
                    PBKDF2_ITERATIONS,
                hash: "SHA-256"
            },
            passwordKey,
            PBKDF2_KEY_BITS
        );

    const hashHex =
        bytesToHex(
            new Uint8Array(
                derivedBits
            )
        );

    const saltHex =
        bytesToHex(
            salt
        );

    return (
        "pbkdf2$" +
        PBKDF2_ITERATIONS +
        "$" +
        saltHex +
        "$" +
        hashHex
    );
}


// ==================================================
// VERIFY PASSWORD
// Supports:
// 1. PBKDF2
// 2. Old SHA-256
// ==================================================

async function verifyPassword(
    password,
    storedHash
) {
    if (
        !storedHash
    ) {
        return {
            valid: false,
            legacy: false
        };
    }


    // ----------------------------------------------
    // NEW PBKDF2 FORMAT
    // ----------------------------------------------

    if (
        storedHash.startsWith(
            "pbkdf2$"
        )
    ) {
        try {

            const parts =
                storedHash.split(
                    "$"
                );

            if (
                parts.length !== 4
            ) {
                return {
                    valid: false,
                    legacy: false
                };
            }

            const iterations =
                Number(
                    parts[1]
                );

            const saltHex =
                parts[2];

            const expectedHash =
                parts[3];

            if (
                !Number.isInteger(
                    iterations
                ) ||
                iterations < 1 ||
                !saltHex ||
                !expectedHash
            ) {
                return {
                    valid: false,
                    legacy: false
                };
            }

            const salt =
                hexToBytes(
                    saltHex
                );

            const passwordKey =
                await crypto.subtle.importKey(
                    "raw",
                    new TextEncoder().encode(
                        password
                    ),
                    {
                        name: "PBKDF2"
                    },
                    false,
                    [
                        "deriveBits"
                    ]
                );

            const derivedBits =
                await crypto.subtle.deriveBits(
                    {
                        name: "PBKDF2",
                        salt: salt,
                        iterations:
                            iterations,
                        hash: "SHA-256"
                    },
                    passwordKey,
                    PBKDF2_KEY_BITS
                );

            const actualHash =
                bytesToHex(
                    new Uint8Array(
                        derivedBits
                    )
                );

            return {
                valid:
                    safeEqual(
                        actualHash,
                        expectedHash
                    ),
                legacy: false
            };

        } catch (
            error
        ) {

            console.error(
                "PBKDF2 verification error:",
                error
            );

            return {
                valid: false,
                legacy: false
            };
        }
    }


    // ----------------------------------------------
    // OLD SHA-256 FORMAT
    // ----------------------------------------------

    if (
        /^[a-fA-F0-9]{64}$/.test(
            storedHash
        )
    ) {
        const oldHash =
            await sha256Hex(
                password
            );

        return {
            valid:
                safeEqual(
                    oldHash.toLowerCase(),
                    storedHash.toLowerCase()
                ),
            legacy: true
        };
    }


    return {
        valid: false,
        legacy: false
    };
}


// ==================================================
// SESSION TOKEN
// ==================================================

const SESSION_MAX_AGE =
    24 *
    60 *
    60;

const SESSION_MAX_AGE_MS =
    SESSION_MAX_AGE *
    1000;


function generateSessionToken() {
    const bytes =
        new Uint8Array(
            32
        );

    crypto.getRandomValues(
        bytes
    );

    return bytesToHex(
        bytes
    );
}


// ==================================================
// COOKIE PARSER
// ==================================================

function getCookie(
    request,
    cookieName
) {
    const cookieHeader =
        request.headers.get(
            "Cookie"
        );

    if (
        !cookieHeader
    ) {
        return null;
    }

    const cookies =
        cookieHeader.split(
            ";"
        );

    for (
        const cookie of cookies
    ) {
        const index =
            cookie.indexOf("=");

        if (
            index === -1
        ) {
            continue;
        }

        const name =
            cookie
                .slice(
                    0,
                    index
                )
                .trim();

        const value =
            cookie
                .slice(
                    index + 1
                )
                .trim();

        if (
            name ===
            cookieName
        ) {
            return value;
        }
    }

    return null;
}


// ==================================================
// SESSION COOKIE
// ==================================================

function createSessionCookie(
    token
) {
    return (
        "scloud_session=" +
        token +
        "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" +
        SESSION_MAX_AGE
    );
}


function clearSessionCookie() {
    return (
        "scloud_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    );
}


// ==================================================
// CREATE SESSION
// ==================================================

async function createSession(
    userId,
    env
) {
    const rawToken =
        generateSessionToken();

    const tokenHash =
        await sha256Hex(
            rawToken
        );

    const expiresAt =
        Date.now() +
        SESSION_MAX_AGE_MS;

    await env.DB
        .prepare(
            `INSERT INTO sessions
            (
                session_token_hash,
                user_id,
                expires_at
            )
            VALUES (?, ?, ?)`
        )
        .bind(
            tokenHash,
            userId,
            expiresAt
        )
        .run();

    return {
        rawToken,
        expiresAt
    };
}


// V4 folder settings: separate per-user cap, existing daily quota remains authoritative.
async function ensureV4Limits(env) {
    await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_folder_upload_limits (user_id INTEGER PRIMARY KEY, folder_limit INTEGER NOT NULL CHECK(folder_limit BETWEEN 0 AND 1000))`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_upload_limits (user_id INTEGER PRIMARY KEY, daily_limit INTEGER NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_daily_upload_usage (user_id INTEGER NOT NULL, usage_date TEXT NOT NULL, uploads_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,usage_date))`)
    ]);
}
async function v4UploadLimits(env, userId) {
    await ensureV4Limits(env);
    const row = await env.DB.prepare(`SELECT NULLIF(COALESCE((SELECT COALESCE(daily_limit,-1) FROM user_upload_limits WHERE user_id=?),20),-1) AS daily_limit, COALESCE((SELECT uploads_count FROM user_daily_upload_usage WHERE user_id=? AND usage_date=date('now')),0) AS uploads_today, COALESCE((SELECT folder_limit FROM user_folder_upload_limits WHERE user_id=?),20) AS folder_limit`).bind(userId,userId,userId).first();
    return {...row, remaining: row.daily_limit == null ? null : Math.max(0,Number(row.daily_limit)-Number(row.uploads_today))};
}
function v4DriveId(value, folder=false) {
    try {
        const u=new URL(String(value));
        if (u.protocol!=="https:" || u.hostname!=="drive.google.com" || u.username || u.password || u.port) return null;
        const id=folder ? u.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,200})(?:\/|$)/)?.[1] : (u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/|$)/)?.[1] || (['/open','/uc'].includes(u.pathname) ? u.searchParams.get('id') : null));
        return /^[A-Za-z0-9_-]{10,200}$/.test(id||'') ? id : null;
    } catch { return null; }
}
async function v4ListFolder(folderId, env, limit) {
    const {token}=await selectDriveMetadataAccount(folderId,env);
    const files=[]; let pageToken; let pages=0;
    do {
        const params=new URLSearchParams({q:`'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,supportsAllDrives:'true',includeItemsFromAllDrives:'true',pageSize:'100',fields:'nextPageToken,files(id,name,mimeType)',orderBy:'name'});
        if(pageToken) params.set('pageToken',pageToken);
        const res=await fetch('https://www.googleapis.com/drive/v3/files?'+params,{headers:{Authorization:`Bearer ${token}`}});
        const data=await res.json(); if(!res.ok) throw new Error('Google Drive folder listing failed');
        for(const f of data.files||[]) if(f.id && f.mimeType!=='application/vnd.google-apps.folder') files.push({id:f.id,name:f.name||'Unnamed file'});
        pageToken=data.nextPageToken;
        if(++pages>=20) break;
    } while(pageToken && files.length<=limit);
    return {files:files.slice(0,limit),truncated:files.length>limit||!!pageToken};
}
const V4_SUPPORT_COOKIE='scloud_support';
const V4_OWNER_EMAIL="sagarmajethiya444@gmail.com";
const v4SupportClear=()=>`${V4_SUPPORT_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
async function v4SupportUser(request,env,admin) {
    const token=getCookie(request,V4_SUPPORT_COOKIE);
    if(!token || !admin || String(admin.email).toLowerCase()!==V4_OWNER_EMAIL) return null;
    const tokenHash=await sha256Hex(token), adminHash=await sha256Hex(getCookie(request,'scloud_session')||'');
    const row=await env.DB.prepare(`SELECT u.id,u.name,u.email,u.shared_by,u.shared_by_enabled,u.shared_by_url,u.role,u.balance,u.custom_cpm,u.status,u.last_login_ip,u.created_at FROM scloud_admin_support s JOIN users u ON u.id=s.target_id WHERE s.token_hash=? AND s.admin_id=? AND s.admin_session_hash=? AND s.expires_at>? AND s.ended_at IS NULL`).bind(tokenHash,admin.id,adminHash,Date.now()).first();
    return row ? {...row,support_read_only:true} : null;
}

// ==================================================
// GET CURRENT USER
// ==================================================

async function getActualSessionUser(
    request,
    env
) {
    const token =
        getCookie(
            request,
            "scloud_session"
        );

    if (
        !token
    ) {
        return null;
    }

    let tokenHash;

    try {
        tokenHash =
            await sha256Hex(
                token
            );
    } catch (
        error
    ) {
        return null;
    }

    const session =
        await env.DB
            .prepare(
                `SELECT
                    s.id AS session_id,
                    s.user_id AS session_user_id,
                    s.expires_at,
                    u.id,
                    u.name,
                    u.email,
                    u.shared_by,
                    u.shared_by_enabled,
                    u.shared_by_url,
                    u.role,
                    u.balance,
                    u.custom_cpm,
                    u.status,
                    u.last_login_ip,
                    u.created_at
                 FROM sessions s
                 INNER JOIN users u
                    ON u.id = s.user_id
                 WHERE
                    s.session_token_hash = ?
                 LIMIT 1`
            )
            .bind(
                tokenHash
            )
            .first();

    if (
        !session
    ) {
        return null;
    }

    const currentTime =
        Date.now();

    if (
        Number(
            session.expires_at
        ) <= currentTime
    ) {

        await env.DB
            .prepare(
                "DELETE FROM sessions WHERE id = ?"
            )
            .bind(
                session.session_id
            )
            .run();

        return null;
    }

    if (
        session.status ===
        "banned"
    ) {
        return null;
    }

    return {
        id: session.id,
        name: session.name,
        email: session.email,
        shared_by: session.shared_by,
        shared_by_enabled: session.shared_by_enabled,
        shared_by_url: session.shared_by_url,
        role: session.role,
        balance: session.balance,
        custom_cpm: session.custom_cpm,
        status: session.status,
        last_login_ip:
            session.last_login_ip,
        created_at:
            session.created_at
    };
}


async function getCurrentUser(request,env) {
    const admin=await getActualSessionUser(request,env);
    if(!getCookie(request,V4_SUPPORT_COOKIE)) return admin;
    return v4SupportUser(request,env,admin);
}
// ==================================================
// DELETE CURRENT SESSION
// ==================================================

async function deleteCurrentSession(
    request,
    env
) {
    const token =
        getCookie(
            request,
            "scloud_session"
        );

    if (
        !token
    ) {
        return;
    }

    const tokenHash =
        await sha256Hex(
            token
        );

    await env.DB
        .prepare(
            "DELETE FROM sessions WHERE session_token_hash = ?"
        )
        .bind(
            tokenHash
        )
        .run();
}


// ==================================================
// CLEAN EXPIRED SESSIONS
// ==================================================

async function cleanExpiredSessions(
    env
) {
    try {

        await env.DB
            .prepare(
                "DELETE FROM sessions WHERE expires_at <= ?"
            )
            .bind(
                Date.now()
            )
            .run();

    } catch (
        error
    ) {
        console.error(
            "Session cleanup error:",
            error
        );
    }
}


// ==================================================
// API KEY SYSTEM
// ==================================================

const API_KEY_BYTES =
    32;


// ==================================================
// API KEY BASE64URL ENCODER
// ==================================================

function bytesToBase64Url(
    bytes
) {
    let binary = "";

    for (
        const byte of bytes
    ) {
        binary += String.fromCharCode(
            byte
        );
    }

    return btoa(
        binary
    )
        .replace(
            /\+/g,
            "-"
        )
        .replace(
            /\//g,
            "_"
        )
        .replace(
            /=+$/g,
            ""
        );
}


// ==================================================
// GENERATE SECURE API KEY
// ==================================================

function generateApiKey() {
    const bytes =
        new Uint8Array(
            API_KEY_BYTES
        );

    crypto.getRandomValues(
        bytes
    );

    return (
        "sc_" +
        bytesToBase64Url(
            bytes
        )
    );
}


// ==================================================
// GET API KEY FROM REQUEST
//
// Supported:
// Authorization: Bearer sc_xxxxx
// X-API-Key: sc_xxxxx
// ?api=sc_xxxxx
// ==================================================

function getApiKeyFromRequest(
    request
) {

    const authorization =
        request.headers.get(
            "Authorization"
        );

    if (
        authorization
    ) {

        const match =
            authorization.match(
                /^Bearer\s+(.+)$/i
            );

        if (
            match &&
            match[1]
        ) {
            return match[1].trim();
        }
    }


    const headerKey =
        request.headers.get(
            "X-API-Key"
        );

    if (
        headerKey
    ) {
        return headerKey.trim();
    }


    try {

        const requestUrl =
            new URL(
                request.url
            );

        const queryKey =
            requestUrl.searchParams.get(
                "api"
            );

        if (
            queryKey
        ) {
            return queryKey.trim();
        }

    } catch (
        error
    ) {

        console.error(
            "API key URL parsing error:",
            error
        );
    }


    return null;
}


// ==================================================
// ENSURE API KEY TABLE
// ==================================================

async function ensureApiKeyTable(
    env
) {

    await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            key_hash TEXT NOT NULL UNIQUE,
            key_prefix TEXT NOT NULL,
            encrypted_key TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_used_at TIMESTAMP,
            revoked_at TIMESTAMP
        )`
    ).run();


    const columns =
        await env.DB
            .prepare(
                `PRAGMA table_info(api_keys)`
            )
            .all();

    const hasEncryptedKey =
        columns.results?.some(
            column =>
                column.name ===
                "encrypted_key"
        );

    if (
        !hasEncryptedKey
    ) {
        await env.DB
            .prepare(
                `ALTER TABLE api_keys
                 ADD COLUMN encrypted_key TEXT`
            )
            .run();
    }


    await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_api_keys_user_id
         ON api_keys(user_id)`
    ).run();


    await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash
         ON api_keys(key_hash)`
    ).run();
}


// ==================================================
// GET CURRENT API KEY RECORD
// ==================================================

async function getUserApiKey(
    userId,
    env
) {

    const key =
        await env.DB
            .prepare(
                `SELECT
                    id,
                    user_id,
                    key_prefix,
                    encrypted_key,
                    status,
                    created_at,
                    last_used_at,
                    revoked_at
                 FROM api_keys
                 WHERE user_id = ?
                 AND status = 'active'
                 ORDER BY id DESC
                 LIMIT 1`
            )
            .bind(
                userId
            )
            .first();


    if (
        !key
    ) {
        return null;
    }


    if (
        key.encrypted_key
    ) {
        key.api_key =
            await decryptApiKey(
                key.encrypted_key,
                env
            );
    }


    return key;
}


// ==================================================
// CREATE NEW API KEY
// ==================================================

async function createApiKey(
    userId,
    env
) {

    const apiKey =
        generateApiKey();


    const keyHash =
        await sha256Hex(
            apiKey
        );


    const keyPrefix =
        apiKey.slice(
            0,
            11
        );


    const encryptedKey =
        await encryptApiKey(
            apiKey,
            env
        );


    await env.DB
        .prepare(
            `INSERT INTO api_keys
            (
                user_id,
                key_hash,
                key_prefix,
                encrypted_key,
                status
            )
            VALUES (?, ?, ?, ?, 'active')`
        )
        .bind(
            userId,
            keyHash,
            keyPrefix,
            encryptedKey
        )
        .run();


    return {
        apiKey,
        keyPrefix
    };
}


// ==================================================
// REVOKE CURRENT USER API KEYS
// ==================================================

async function revokeUserApiKeys(
    userId,
    env
) {

    await env.DB
        .prepare(
            `UPDATE api_keys
             SET
                status = 'revoked',
                revoked_at = CURRENT_TIMESTAMP
             WHERE
                user_id = ?
                AND status = 'active'`
        )
        .bind(
            userId
        )
        .run();
}


// ==================================================
// AUTHENTICATE API KEY
// ==================================================

async function authenticateApiKey(
    request,
    env
) {

    const apiKey =
        getApiKeyFromRequest(
            request
        );

    if (
        !apiKey
    ) {
        return null;
    }


    if (
        apiKey.length <
        20
    ) {
        return null;
    }


    let keyHash;

    try {

        keyHash =
            await sha256Hex(
                apiKey
            );

    } catch (
        error
    ) {

        console.error(
            "API key hashing error:",
            error
        );

        return null;
    }


    const record =
        await env.DB
            .prepare(
                `SELECT
                    k.id AS api_key_id,
                    k.user_id,
                    k.key_prefix,
                    k.status AS key_status,
                    u.id,
                    u.name,
                    u.email,
                    u.role,
                    u.balance,
                    u.custom_cpm,
                    u.status,
                    u.last_login_ip,
                    u.created_at
                 FROM api_keys k
                 INNER JOIN users u
                    ON u.id = k.user_id
                 WHERE
                    k.key_hash = ?
                    AND k.status = 'active'
                 LIMIT 1`
            )
            .bind(
                keyHash
            )
            .first();


    if (
        !record
    ) {
        return null;
    }


    if (
        record.status ===
        "banned"
    ) {
        return null;
    }


    try {

        await env.DB
            .prepare(
                `UPDATE api_keys
                 SET last_used_at = CURRENT_TIMESTAMP
                 WHERE id = ?`
            )
            .bind(
                record.api_key_id
            )
            .run();

    } catch (
        error
    ) {

        console.error(
            "API key last-used update error:",
            error
        );
    }


    return {
        id:
            record.id,
        name:
            record.name,
        email:
            record.email,
        role:
            record.role,
        balance:
            record.balance,
        custom_cpm:
            record.custom_cpm,
        status:
            record.status,
        last_login_ip:
            record.last_login_ip,
        created_at:
            record.created_at,
        api_key_id:
            record.api_key_id,
        api_key_prefix:
            record.key_prefix
    };
}


// ==================================================
// SAFE JSON HEADERS
// ==================================================

function jsonHeaders() {
    return {
        "Content-Type":
            "application/json; charset=UTF-8",
        "Cache-Control":
            "no-store"
    };
}


// ==================================================
// DOWNLOAD EARNING / UNIQUE PAID VIEW
// ==================================================

async function creditDownloadEarning(
    record,
    request,
    env
) {
    try {
        if (
            !record ||
            !record.id ||
            !record.user_id
        ) {
            return {
                credited: false,
                reason: "invalid_file"
            };
        }

        const visitorIP =
            request.headers.get(
                "CF-Connecting-IP"
            ) ||
            request.headers.get(
                "X-Real-IP"
            ) ||
            (
                request.headers.get(
                    "X-Forwarded-For"
                ) || ""
            )
                .split(",")[0]
                .trim();

        if (!visitorIP) {
            console.log(
                `[EARNING] SKIPPED | file=${record.short_id || record.id} | reason=no_ip`
            );

            return {
                credited: false,
                reason: "no_ip"
            };
        }

        const user =
            await env.DB
                .prepare(
                    `SELECT
                        id,
                        status,
                        custom_cpm
                     FROM users
                     WHERE id = ?
                     LIMIT 1`
                )
                .bind(
                    record.user_id
                )
                .first();

        if (
            !user ||
            user.status !==
                "active"
        ) {
            console.log(
                `[EARNING] SKIPPED | file=${record.short_id || record.id} | reason=user_inactive`
            );

            return {
                credited: false,
                reason: "user_inactive"
            };
        }

        const cpm =
            Number(
                user.custom_cpm
            );

        if (
            !Number.isFinite(cpm) ||
            cpm <= 0
        ) {
            console.log(
                `[EARNING] SKIPPED | file=${record.short_id || record.id} | reason=invalid_cpm`
            );

            return {
                credited: false,
                reason: "invalid_cpm"
            };
        }

        const ipHash =
            await sha256Hex(visitorIP);

        const browserId = readCookie(request, "scloud_vid");
        const browserHash = browserId
            ? await sha256Hex(browserId)
            : null;

        const earningAmount =
            Number((cpm / 1000).toFixed(6));

        if (
            !Number.isFinite(earningAmount) ||
            earningAmount <= 0
        ) {
            return {
                credited: false,
                reason: "invalid_amount"
            };
        }

        // One earning per uploader per rolling 24 hours for either
        // the same IP or the same first-party browser cookie.
        // Also respect legacy IP/day earnings created before migration.
        const uniqueDownloadId =
            `earning:${crypto.randomUUID()}`;

        const batchResult =
            await env.DB.batch([
                env.DB.prepare(
                    `INSERT INTO visitor_activity
                    (user_id, activity_type, ip_hash, browser_hash, occurred_at)
                    SELECT ?, 'earning', ?, ?, CURRENT_TIMESTAMP
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM visitor_activity va
                        WHERE va.user_id = ?
                          AND va.activity_type = 'earning'
                          AND va.occurred_at >= datetime('now', '-24 hours')
                          AND (
                              va.ip_hash = ?
                              OR (? IS NOT NULL AND va.browser_hash = ?)
                          )
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM earnings e
                        WHERE e.user_id = ?
                          AND e.created_at >= datetime('now', '-24 hours')
                          AND substr(e.download_id, 1, 5) = 'paid:' AND substr(e.download_id, -64) = ?
                    )`
                ).bind(
                    record.user_id,
                    ipHash,
                    browserHash,
                    record.user_id,
                    ipHash,
                    browserHash,
                    browserHash,
                    record.user_id,
                    ipHash
                ),
                env.DB.prepare(
                    `INSERT OR IGNORE INTO earnings
                    (user_id, file_id, download_id, amount, type, status, description)
                    SELECT ?, ?, ?, ?, ?, ?, ?
                    WHERE changes() > 0`
                ).bind(
                    record.user_id,
                    record.id,
                    uniqueDownloadId,
                    earningAmount,
                    "download",
                    "credited",
                    "Unique download earning (24h IP/browser limit)"
                ),
                env.DB.prepare(
                    `UPDATE users
                     SET balance = COALESCE(balance, 0) + ?
                     WHERE id = ? AND changes() > 0`
                ).bind(
                    earningAmount,
                    record.user_id
                )
            ]);

        const guardInserted =
            Number(batchResult?.[0]?.meta?.changes || 0) > 0;
        const earningInserted =
            Number(batchResult?.[1]?.meta?.changes || 0) > 0;
        const credited = guardInserted && earningInserted;

        if (credited) {
            console.log(
                `[EARNING] CREDITED | file=${record.short_id || record.id} | user=${record.user_id} | amount=${earningAmount} | limit=rolling-24h`
            );

            return {
                credited: true,
                amount:
                    earningAmount,
                window:
                    "rolling-24h"
            };
        }

        console.log(
            `[EARNING] SKIPPED | file=${record.short_id || record.id} | reason=already_earned_within_24h`
        );

        return {
            credited: false,
            reason:
                "already_earned_within_24h"
        };

    } catch (error) {
        /*
         * Earning failure must NEVER break
         * the actual download redirect.
         */
        console.error(
            "[EARNING] ERROR:",
            error.message
        );

        return {
            credited: false,
            reason:
                "earning_error"
        };
    }
}


// ==================================================
// MAIN WORKER
// ==================================================


// ============================================================
// BACKGROUND FAST-LINK PREPARATION
// ============================================================

const ENABLE_GDFLIX_FASTLINK_SCRAPING = false;

const fastLinkJobs = new Map();

// ==================================================
// PDLINK BACKGROUND JOB GUARD
// ==================================================

const pdlinkJobs = new Map();
const toxcloudJobs = new Map();


const THREE_HOURS_IN_MS =
    3 *
    60 *
    60 *
    1000;

function hasValidFastLinks(record, currentTime) {
    if (!record || !record.fast_links) {
        return false;
    }

    try {
        JSON.parse(record.fast_links);
    } catch (error) {
        return false;
    }

    const expiresAt = Number(
        record.fast_links_expires_at || 0
    );

    if (expiresAt > currentTime) {
        return true;
    }

    if (!expiresAt) {
        const lastUpdated = Number(
            record.last_updated || 0
        );

        if (
            lastUpdated > 0 &&
            currentTime - lastUpdated < THREE_HOURS_IN_MS
        ) {
            return true;
        }
    }

    return false;
}

async function prepareFastLinks(shortId, env) {
    if (fastLinkJobs.has(shortId)) {
        console.log(`[FAST] Job already running for ${shortId}`);
        return fastLinkJobs.get(shortId);
    }

    const startedAt = Date.now();

    const elapsed = () =>
        `${Date.now() - startedAt}ms`;

    console.log(
        `[FAST] START ${shortId} | elapsed=${elapsed()}`
    );

    const job = (async () => {
        try {
            console.log(
                `[FAST] DB lookup START ${shortId} | elapsed=${elapsed()}`
            );

            let record = await env.DB
                .prepare(
                    `SELECT *
                     FROM files
                     WHERE short_id = ?
                        OR id = ?`
                )
                .bind(shortId, shortId)
                .first();

            console.log(
                `[FAST] DB lookup END ${shortId} | elapsed=${elapsed()}`
            );

            if (!record || record.status === "deleted" || Number(record.sharing_enabled ?? 1) === 0) {
                console.log(
                    `[FAST] Record missing/deleted ${shortId} | elapsed=${elapsed()}`
                );
                return;
            }

            // Cron-managed uploads must not start the legacy Drivetot/fast-link
            // process from /d/:id; that would duplicate submissions.
            const canonicalId = String(record.short_id || shortId);
            if (await hasCronMirrorJobs(canonicalId, env)) {
                await healScloudMirrorJobs(canonicalId, env, getMirrorUploadPolicy, syncDownloadMetadata);
                return;
            }

            console.log(
                `[FAST] Record loaded ${shortId} | ` +
                `gdflix=${!!record.gdflix_url} | ` +
                `hubcloud=${!!record.hubcloud_url} | ` +
                `drivetot=${!!record.drivetot_url} | ` +
                `fast_links=${!!record.fast_links} | ` +
                `elapsed=${elapsed()}`
            );

            console.log(
                `[FAST] Existing fast-link check START ${shortId} | elapsed=${elapsed()}`
            );

            if (
                hasValidFastLinks(
                    record,
                    Date.now()
                )
            ) {
                console.log(
                    `[FAST] Existing fast links already valid ${shortId} | elapsed=${elapsed()}`
                );
                return;
            }

            console.log(
                `[FAST] No valid fast links found ${shortId} | elapsed=${elapsed()}`
            );

            let drivetotShareId = null;

            let drivetotUrl =
                record.drivetot_url || null;

            const hubcloudMissing =
                !record.hubcloud_url ||
                record.hubcloud_url === "Not Found";

            const gdflixMissing =
                !record.gdflix_url ||
                record.gdflix_url === "Not Found";

            console.log(
                `[FAST] Mirror status ${shortId} | ` +
                `hubcloudMissing=${hubcloudMissing} | ` +
                `gdflixMissing=${gdflixMissing} | ` +
                `elapsed=${elapsed()}`
            );

            if (drivetotUrl) {
                console.log(
                    `[FAST] Existing Drivetot URL found ${shortId} | elapsed=${elapsed()}`
                );

                const drivetotMatch =
                    String(drivetotUrl).match(
                        /\/(?:s\/)?([^/?#]+)\/?$/
                    );

                if (
                    drivetotMatch &&
                    drivetotMatch[1]
                ) {
                    drivetotShareId =
                        drivetotMatch[1];

                    console.log(
                        `[FAST] Drivetot Share ID extracted ${shortId} | ` +
                        `shareId=${drivetotShareId} | ` +
                        `elapsed=${elapsed()}`
                    );
                }
            } else {
                console.log(
                    `[FAST] No existing Drivetot URL ${shortId} | elapsed=${elapsed()}`
                );
            }

            if (
                (hubcloudMissing || gdflixMissing) &&
                !drivetotShareId
            ) {
                console.log(
                    `[FAST] Drivetot upload REQUIRED ${shortId} | elapsed=${elapsed()}`
                );

                const scloudMatch =
                    String(
                        record.drive_url || ""
                    ).match(
                        /[-\w]{25,}/
                    );

                if (scloudMatch) {
                    console.log(
                        `[FAST] Drivetot upload START ${shortId} | elapsed=${elapsed()}`
                    );

                    try {
                        const drivetotResult =
                            await uploadToDrivetot(
                                scloudMatch[0],
                                env
                            );

                        console.log(
                            `[FAST] Drivetot upload END ${shortId} | ` +
                            `success=${!!(drivetotResult && drivetotResult.share_id)} | ` +
                            `elapsed=${elapsed()}`
                        );

                        if (
                            drivetotResult &&
                            drivetotResult.share_id
                        ) {
                            drivetotShareId =
                                drivetotResult.share_id;

                            drivetotUrl =
                                `https://drivetot.website/${drivetotShareId}`;

                            console.log(
                                `[FAST] Saving Drivetot URL ${shortId} | elapsed=${elapsed()}`
                            );

                            await env.DB
                                .prepare(
                                    `UPDATE files
                                     SET drivetot_url = ?
                                     WHERE id = ?`
                                )
                                .bind(
                                    drivetotUrl,
                                    record.id
                                )
                                .run();

                            console.log(
                                `[FAST] Drivetot URL saved ${shortId} | elapsed=${elapsed()}`
                            );
                        }
                    } catch (error) {
                        console.error(
                            `[FAST] Drivetot upload FAILED ${shortId} | ` +
                            `elapsed=${elapsed()} |`,
                            error.message
                        );
                    }
                } else {
                    console.error(
                        `[FAST] S-Cloud Drive ID missing ${shortId} | elapsed=${elapsed()}`
                    );
                }
            } else {
                console.log(
                    `[FAST] Drivetot upload SKIPPED ${shortId} | ` +
                    `reason=mirrors_already_available_or_share_exists | ` +
                    `elapsed=${elapsed()}`
                );
            }

            if (
                (hubcloudMissing || gdflixMissing) &&
                drivetotShareId
            ) {
                console.log(
                    `[FAST] Drivetot extraction START ${shortId} | elapsed=${elapsed()}`
                );

                try {
                    const extractedLinks =
                        await extractLinksFromDrivetot(
                            drivetotShareId,
                            env
                        );

                    console.log(
                        `[FAST] Drivetot extraction END ${shortId} | ` +
                        `success=${!!(extractedLinks && !extractedLinks.error)} | ` +
                        `elapsed=${elapsed()}`
                    );

                    if (
                        extractedLinks &&
                        !extractedLinks.error
                    ) {
                        record.hubcloud_url =
                            extractedLinks.hubcloud_url ||
                            record.hubcloud_url ||
                            null;

                        record.gdflix_url =
                            extractedLinks.gdflix_url ||
                            record.gdflix_url ||
                            null;

                        console.log(
                            `[FAST] Saving extracted mirror URLs ${shortId} | elapsed=${elapsed()}`
                        );

                        await env.DB
                            .prepare(
                                `UPDATE files
                                 SET drivetot_url = ?,
                                     hubcloud_url = ?,
                                     gdflix_url = ?
                                 WHERE id = ?`
                            )
                            .bind(
                                drivetotUrl ||
                                    record.drivetot_url ||
                                    null,
                                record.hubcloud_url,
                                record.gdflix_url,
                                record.id
                            )
                            .run();

                        console.log(
                            `[FAST] Extracted mirror URLs saved ${shortId} | elapsed=${elapsed()}`
                        );

                        // Immediately sync recovered source metadata.
                        // Do not depend on the later GDFlix fast-link
                        // generation succeeding.
                        try {
                            const recoveredSyncRecord =
                                await env.DB
                                    .prepare(
                                        "SELECT * FROM files WHERE id = ? LIMIT 1"
                                    )
                                    .bind(record.id)
                                    .first();

                            if (recoveredSyncRecord) {
                                await syncDownloadMetadata(
                                    recoveredSyncRecord,
                                    env
                                );

                                console.log(
                                    `[FAST] Recovered mirrors synced ${shortId} | elapsed=${elapsed()}`
                                );
                            }
                        } catch (syncError) {
                            console.error(
                                `[FAST] Recovered mirror sync FAILED ${shortId} | elapsed=${elapsed()} |`,
                                syncError?.message || syncError
                            );
                        }
                    }
                } catch (error) {
                    console.error(
                        `[FAST] Drivetot extraction FAILED ${shortId} | ` +
                        `elapsed=${elapsed()} |`,
                        error.message
                    );
                }
            } else {
                console.log(
                    `[FAST] Drivetot extraction SKIPPED ${shortId} | ` +
                    `reason=mirrors_available_or_no_share | ` +
                    `elapsed=${elapsed()}`
                );
            }

            console.log(
                `[FAST] Final DB reload START ${shortId} | elapsed=${elapsed()}`
            );

            record = await env.DB
                .prepare(
                    `SELECT *
                     FROM files
                     WHERE short_id = ?
                        OR id = ?`
                )
                .bind(shortId, shortId)
                .first();

            console.log(
                `[FAST] Final DB reload END ${shortId} | elapsed=${elapsed()}`
            );

            if (
                !record ||
                record.status === "deleted" ||
                Number(record.sharing_enabled ?? 1) === 0
            ) {
                console.log(
                    `[FAST] Record missing/deleted after reload ${shortId} | elapsed=${elapsed()}`
                );
                return;
            }

            if (
                hasValidFastLinks(
                    record,
                    Date.now()
                )
            ) {
                console.log(
                    `[FAST] Fast links became available during preparation ${shortId} | elapsed=${elapsed()}`
                );
                return;
            }

            if (
                !record.gdflix_url ||
                record.gdflix_url === "Not Found"
            ) {
                console.error(
                    `[FAST] GDFlix URL unavailable ${shortId} | elapsed=${elapsed()}`
                );
                return;
            }

            console.log(
                `[FAST] GDFlix URL available ${shortId} | elapsed=${elapsed()}`
            );

            console.log(
                `[FAST] bypassGDFlix START ${shortId} | elapsed=${elapsed()}`
            );

            // Preserve the scraper but pause execution.
            // Mirror recovery above remains active.
            if (!ENABLE_GDFLIX_FASTLINK_SCRAPING) {
                console.log(
                    `[FAST] GDFlix scraping paused ${shortId}`
                );
                return;
            }

            const freshFastLinks =
                await bypassGDFlix(
                    record.gdflix_url,
                    env
                );

            console.log(
                `[FAST] bypassGDFlix END ${shortId} | ` +
                `links=${Array.isArray(freshFastLinks) ? freshFastLinks.length : "unknown"} | ` +
                `elapsed=${elapsed()}`
            );

            if (!freshFastLinks) {
                console.error(
                    `[FAST] bypassGDFlix returned empty ${shortId} | elapsed=${elapsed()}`
                );
                return;
            }

            const savedAt =
                Date.now();

            const expiresAt =
                savedAt +
                THREE_HOURS_IN_MS;

            console.log(
                `[FAST] Fast-link DB save START ${shortId} | elapsed=${elapsed()}`
            );

            await env.DB
                .prepare(
                    `UPDATE files
                     SET fast_links = ?,
                         last_updated = ?,
                         fast_links_expires_at = ?
                     WHERE id = ?`
                )
                .bind(
                    JSON.stringify(
                        freshFastLinks
                    ),
                    savedAt,
                    expiresAt,
                    record.id
                )
                .run();

            console.log(
                `[FAST] Fast-link DB save END ${shortId} | elapsed=${elapsed()}`
            );

            // Sync updated mirrors/fast links to the separate Download Worker.
            const syncedRecord = await env.DB.prepare(
                "SELECT * FROM files WHERE id = ? LIMIT 1"
            ).bind(record.id).first();
            if (syncedRecord) {
                await syncDownloadMetadata(syncedRecord, env);
            }

            console.log(
                `[FAST] COMPLETE ${shortId} | total=${elapsed()}`
            );

        } catch (error) {
            console.error(
                `[FAST] FAILED ${shortId} | ` +
                `elapsed=${elapsed()} |`,
                error.message
            );

        } finally {
            fastLinkJobs.delete(shortId);

            console.log(
                `[FAST] JOB RELEASED ${shortId} | total=${elapsed()}`
            );
        }
    })();

    fastLinkJobs.set(shortId, job);

    return job;
}

export default {
    async fetch(
        request,
        env,
        ctx
    ) {

        // ------------------------------------------
        // CORS / COMMON HEADERS
        // ------------------------------------------

        const corsHeaders = {
            "Access-Control-Allow-Origin":
                "*",
            "Access-Control-Allow-Methods":
                "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":
                "Content-Type, Authorization, X-API-Key"
        };

        // Shared JSON response helper used by API routes.
        const jsonResponse = (payload, status = 200) => new Response(
            JSON.stringify(payload),
            {
                status,
                headers: { ...corsHeaders, ...jsonHeaders() }
            }
        );


        // ------------------------------------------
        // OPTIONS
        // ------------------------------------------

        if (
            request.method ===
            "OPTIONS"
        ) {
            return new Response(
                null,
                {
                    status: 204,
                    headers:
                        corsHeaders
                }
            );
        }


        const url =
            new URL(
                request.url
            );


        // Canonical public domain. Keep machine-to-machine endpoints compatible
        // with existing clients and internal service bindings; never forward credentials.
        const legacyPublicHost = "dashboard.scloud7266.workers.dev";
        const canonicalPublicOrigin = "https://scloudd.dpdns.org";
        const legacyMachinePath = url.pathname === "/v1/upload" ||
            url.pathname.startsWith("/api/") ||
            url.pathname.startsWith("/__scloud_jobs/") ||
            (url.pathname.startsWith("/file/") && request.headers.get("Sec-Fetch-Mode") !== "navigate");
        if (url.hostname === legacyPublicHost &&
            (request.method === "GET" || request.method === "HEAD") && !legacyMachinePath) {
            const destination = new URL(canonicalPublicOrigin);
            destination.pathname = url.pathname;
            destination.search = url.search;
            return new Response(null, {status: 302, headers: {
                Location: destination.toString(), "Cache-Control": "no-store"
            }});
        }

        // Authenticated server-to-server revocation check for both download accounts.
        // The Main D1 is authoritative even when a replica sync failed.
        if (url.pathname === "/api/internal/download-authorize") {
            const secret = request.headers.get("X-Sync-Secret") || "";
            const configured = getDownloadTargets(env, true);
            if (request.method !== "POST" || !secret || !configured.some(target => safeEqual(secret,target.syncSecret))) {
                return jsonResponse({status:"error"}, 404);
            }
            try {
                const body = await request.json();
                const fileId = String(body?.file_id || "");
                if (!/^[A-Za-z0-9_-]{1,100}$/.test(fileId)) return jsonResponse({status:"error"},400);
                const record = await env.DB.prepare(`SELECT f.status, f.sharing_enabled,
                    CASE WHEN u.gofile_download_locked=0 AND COALESCE(g.show_on_download,1)=1 THEN 1 ELSE 0 END AS gofile_visible,
                    CASE WHEN u.pixeldrain_download_locked=0 AND COALESCE(p.show_on_download,1)=1 THEN 1 ELSE 0 END AS pixeldrain_visible
                    FROM files f LEFT JOIN users u ON u.id=f.user_id
                    LEFT JOIN user_mirror_sites g ON g.user_id=u.id AND g.provider='gofile'
                    LEFT JOIN user_mirror_sites p ON p.user_id=u.id AND p.provider='pixeldrain'
                    WHERE f.short_id=? LIMIT 1`).bind(fileId).first();
                return new Response(JSON.stringify({allowed: !!record && record.status === "active" && Number(record.sharing_enabled ?? 1) !== 0,
                    controlled_mirror_visibility:{gofile:record?.gofile_visible===1,pixeldrain:record?.pixeldrain_visible===1}}), {
                    headers: {"Content-Type":"application/json", "Cache-Control":"no-store"}
                });
            } catch (error) {
                return jsonResponse({status:"error"},503);
            }
        }

        // V4 support mode never grants a target session or write privileges.
        if (getCookie(request,V4_SUPPORT_COOKIE)) {
            // Visiting the login page explicitly leaves support mode. The cookie
            // can outlive the 15-minute database session; never let it lock out login.
            // Redirect before serving the page so /api/me sees the real session.
            const leaveForLogin = request.method === 'GET' && (
                url.pathname === '/login' || url.pathname === '/index.html' ||
                (url.pathname === '/' && url.searchParams.has('redirect'))
            );
            if (leaveForLogin) {
                try {
                    const actual = await getActualSessionUser(request, env);
                    if (actual && String(actual.email).toLowerCase() === V4_OWNER_EMAIL) {
                        await env.DB.prepare(`UPDATE scloud_admin_support SET ended_at=? WHERE token_hash=? AND admin_id=? AND admin_session_hash=? AND ended_at IS NULL`).bind(Date.now(), await sha256Hex(getCookie(request,V4_SUPPORT_COOKIE)), actual.id, await sha256Hex(getCookie(request,'scloud_session')||'')).run();
                    }
                } catch (_) { console.error('[SUPPORT] login exit audit failed'); }
                return new Response(null, {status:303, headers:{
                    Location: '/login' + url.search,
                    'Set-Cookie': v4SupportClear(), 'Cache-Control':'no-store'
                }});
            }
            if (url.pathname==='/api/admin/support/exit' && request.method==='POST') {
                if (request.headers.get('Origin')!==url.origin) return jsonResponse({status:'error',message:'Invalid origin'},403);
                const actual=await getActualSessionUser(request,env);
                if(actual && String(actual.email).toLowerCase()===V4_OWNER_EMAIL) {
                    try { await env.DB.prepare(`UPDATE scloud_admin_support SET ended_at=? WHERE token_hash=? AND admin_id=? AND admin_session_hash=?`).bind(Date.now(),await sha256Hex(getCookie(request,V4_SUPPORT_COOKIE)),actual.id,await sha256Hex(getCookie(request,'scloud_session')||'')).run(); } catch(e) { console.error('[SUPPORT] exit audit failed'); }
                }
                return new Response(JSON.stringify({status:'success'}),{headers:{...jsonHeaders(),'Set-Cookie':v4SupportClear(),'Cache-Control':'no-store'}});
            }
            const path=url.pathname, method=request.method;
            const allowed=(method==='GET' && ['/dashboard','/dashboard.html','/files','/files.html','/api/me','/api/dashboard'].includes(path)) || (method==='POST' && path==='/api/files');
            const asset=method==='GET' && /^\/(css|js|images|assets)\//.test(path) && !path.endsWith('.html');
            // Public download links are not account mutations. Keep the normal
            // /d handler's active-file/sharing checks, signing and healing intact.
            const publicDownload=method==='GET' && (/^\/d\/[A-Za-z0-9_-]{1,100}$/.test(path) || ["/","/home.html","/privacy","/privacy.html","/terms","/terms.html"].includes(path));
            if(!allowed && !asset && !publicDownload) return jsonResponse({status:'error',code:'SUPPORT_READ_ONLY',message:'Read-only admin view. Return to Admin before changing anything.'},403);
            if(allowed && !await getCurrentUser(request,env)) {
                if(path.startsWith('/api/')) return jsonResponse({status:'error',code:'SUPPORT_EXPIRED',message:'Support session expired. Return to Admin.'},403);
                return new Response(null,{status:302,headers:{Location:'/admin','Set-Cookie':v4SupportClear()}});
            }
        }

        // ==================================================
        // SCLOUD CRON JOB SERVICE BINDING (SECRET REQUIRED)
        // ==================================================
        if (url.pathname.startsWith("/__scloud_jobs/")) {
            if (request.method !== "POST" ||
                typeof env.JOB_WORKER_SECRET !== "string" ||
                env.JOB_WORKER_SECRET.length < 32 ||
                !safeEqual(request.headers.get("X-SCloud-Job-Secret") || "",
                           env.JOB_WORKER_SECRET)) {
                return jsonResponse({ status: "error", message: "Not Found" }, 404);
            }
            try {
                if (url.pathname === "/__scloud_jobs/reconcile") {
                    const stats = await reconcileScloudJobs(env, getMirrorUploadPolicy);
                    return jsonResponse({ status: "success", ...stats });
                }
                if (url.pathname === "/__scloud_jobs/run") {
                    const body = await request.json();
                    const fileId = String(body?.file_id || "");
                    const provider = String(body?.provider || "");
                    if (!/^[A-Za-z0-9_-]{6,128}$/.test(fileId) ||
                        !["pdlink", "toxcloud", "drivetot", "extract"].includes(provider)) {
                        return jsonResponse({status:"error",message:"Invalid job"},400);
                    }
                    const result = await executeScloudMirrorJob(
                        fileId, provider, env, getMirrorUploadPolicy, syncDownloadMetadata
                    );
                    return jsonResponse({ status: "success", ...result });
                }
                if (url.pathname === "/__scloud_jobs/cleanup") {
                    const body = await request.json();
                    const copiedId = String(body?.copied_drive_id || "");
                    if (!/^[A-Za-z0-9_-]{10,200}$/.test(copiedId)) {
                        return jsonResponse({status:"error",message:"Invalid cleanup ID"},400);
                    }
                    const result = await executeScloudCleanupJob(copiedId, env);
                    return jsonResponse({ status:"success", ...result });
                }
            } catch (error) {
                console.error("[SCLOUD JOBS] Internal error:",error?.message || "unknown");
                return jsonResponse({status:"error",message:"Job could not be completed"},500);
            }
            return jsonResponse({status:"error",message:"Not Found"},404);
        }

        // ==================================================
        // S-CLOUD FILEVIEW V7 - PRIVATE API KEY MIRROR ACCESS
        // Authorized accounts only. Saved D1 links only.
        // ==================================================

        const fileviewHeaderPrefix =
            url.pathname === "/api/fileview" ||
            url.pathname.startsWith("/api/fileview/");

        const fileviewKeyPrefix =
            /^\/sc_[^/]+\/fileview(?:\/|$)/.test(url.pathname);

        if (fileviewHeaderPrefix || fileviewKeyPrefix) {

            const fileviewReply = (data, status = 200, extra = {}) =>
                new Response(
                    JSON.stringify(data, null, 2),
                    {
                        status,
                        headers: {
                            "Content-Type": "application/json; charset=UTF-8",
                            "Cache-Control": "private, no-store, max-age=0",
                            "Vary": "Authorization, X-API-Key",
                            "Referrer-Policy": "no-referrer",
                            "X-Robots-Tag": "noindex, nofollow",
                            "X-Content-Type-Options": "nosniff",
                            "Content-Security-Policy":
                                "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
                            ...extra
                        }
                    }
                );

            if (request.method !== "GET") {
                return fileviewReply(
                    { status: "error", message: "Method Not Allowed" },
                    405,
                    { Allow: "GET" }
                );
            }

            const headerRoute =
                /^\/api\/fileview\/([A-Za-z0-9_-]{6,64})\/?$/
                    .exec(url.pathname);

            const keyRoute =
                /^\/(sc_[A-Za-z0-9_-]{20,128})\/fileview\/([A-Za-z0-9_-]{6,64})\/?$/
                    .exec(url.pathname);

            if (
                (fileviewHeaderPrefix && !headerRoute) ||
                (fileviewKeyPrefix && !keyRoute)
            ) {
                return fileviewReply(
                    { status: "error", message: "Not Found" },
                    404
                );
            }

            const fileIdentifier =
                headerRoute ? headerRoute[1] : keyRoute[2];

            const authorization =
                (request.headers.get("Authorization") || "").trim();

            const bearerMatch =
                /^Bearer\s+(sc_[A-Za-z0-9_-]{20,128})$/i
                    .exec(authorization);

            const headerApiKey =
                bearerMatch
                    ? bearerMatch[1]
                    : (request.headers.get("X-API-Key") || "").trim();

            const apiKey =
                keyRoute ? keyRoute[1] : headerApiKey;

            if (!/^sc_[A-Za-z0-9_-]{20,128}$/.test(apiKey)) {
                return fileviewReply(
                    { status: "error", message: "Invalid API key" },
                    401
                );
            }

            try {
                // Existing S-Cloud API keys are stored as SHA-256 hashes.
                // This query does not create a session or write to D1.

                const keyHash = await sha256Hex(apiKey);

                const fileviewAccount = await env.DB.prepare(`
                    SELECT u.id, u.email
                    FROM api_keys k
                    INNER JOIN users u ON u.id = k.user_id
                    WHERE k.key_hash = ?
                      AND k.status = 'active'
                      AND u.status = 'active'
                    LIMIT 1
                `).bind(keyHash).first();

                if (!fileviewAccount) {
                    return fileviewReply(
                        { status: "error", message: "Invalid API key" },
                        401
                    );
                }

                const accountEmail =
                    String(fileviewAccount.email || "")
                        .trim()
                        .toLowerCase();

                const allowedAccounts = [
                    "animeplex.in@proton.me",
                    "sagarmajethiya444@gmail.com"
                ];

                if (!allowedAccounts.includes(accountEmail)) {
                    return fileviewReply(
                        { status: "error", message: "Access Denied" },
                        403
                    );
                }

                // Ownership is checked using authenticated user ID.
                // A valid key cannot read another account's files.

                const fileRecord = await env.DB.prepare(`
                    SELECT
                        id,
                        short_id,
                        file_name,
                        hubcloud_url,
                        gdflix_url,
                        drivetot_url,
                        toxcloud_url
                    FROM files
                    WHERE (short_id = ? OR id = ?)
                      AND user_id = ?
                      AND COALESCE(status, '') != 'deleted'
                      AND COALESCE(sharing_enabled, 1) != 0
                    LIMIT 1
                `).bind(
                    fileIdentifier,
                    fileIdentifier,
                    fileviewAccount.id
                ).first();

                if (!fileRecord) {
                    return fileviewReply(
                        { status: "error", message: "File Not Found" },
                        404
                    );
                }

                const cleanMirrorUrl = (value) => {
                    if (typeof value !== "string") return null;

                    const raw = value.trim();

                    if (
                        !raw ||
                        /^(not found|null|undefined|none|n\/a)$/i.test(raw)
                    ) {
                        return null;
                    }

                    try {
                        const parsed = new URL(raw);

                        if (
                            parsed.protocol !== "https:" &&
                            parsed.protocol !== "http:"
                        ) {
                            return null;
                        }

                        if (parsed.username || parsed.password) {
                            return null;
                        }

                        return parsed.toString();
                    } catch {
                        return null;
                    }
                };

                const mirrors = {};

                for (const [name, field] of [
                    ["hubcloud", "hubcloud_url"],
                    ["gdflix", "gdflix_url"],
                    ["drivetot", "drivetot_url"],
                    ["toxcloud", "toxcloud_url"]
                ]) {
                    const savedUrl =
                        cleanMirrorUrl(fileRecord[field]);

                    if (savedUrl) {
                        mirrors[name] = savedUrl;
                    }
                }

                return fileviewReply({
                    status: "success",
                    data: {
                        file_id:
                            fileRecord.short_id || fileIdentifier,
                        file_name:
                            fileRecord.file_name || "",
                        mirrors
                    }
                });

            } catch (error) {
                console.error("[FILEVIEW] Private lookup failed");

                return fileviewReply(
                    { status: "error", message: "Server Error" },
                    500
                );
            }
        }

        // ==================================================
        // MANAGE SITES - settings and account download permission.
        // Global API key configuration stays independent from download locks.
        // ==================================================
        const MIRROR_SITE_PROVIDERS = Object.freeze([
            { id: 'instant', name: 'Instant Download 10GBps', accepts_key: false, initial_locked: true },
            { id: 'toxcloud', name: 'TOXCloud', accepts_key: true, initial_locked: false },
            { id: 'gofile', name: 'GoFile', accepts_key: true, initial_locked: false },
            { id: 'pixeldrain', name: 'Pixeldrain', accepts_key: true, initial_locked: false },
            { id: 'hubcloud', name: 'HubCloud', accepts_key: true, initial_locked: true },
            { id: 'gdflix', name: 'GDFlix', accepts_key: true, initial_locked: true }
        ]);
        const mirrorSiteById = (id) => MIRROR_SITE_PROVIDERS.find(p => p.id === id) || null;
        const mirrorSiteReply = (data, status = 200) => new Response(JSON.stringify(data), {
            status,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
                       'X-Content-Type-Options': 'nosniff', 'Vary': 'Cookie' }
        });
        const mirrorSiteSameOrigin = () => {
            const targetOrigin = new URL(request.url).origin;
            const origin = request.headers.get('Origin');
            if (origin && origin !== targetOrigin) return false;
            const referer = request.headers.get('Referer');
            if (!origin && referer) {
                try { if (new URL(referer).origin !== targetOrigin) return false; }
                catch (_) { return false; }
            }
            if (!origin && !referer && request.headers.get('Sec-Fetch-Site') !== 'same-origin') return false;
            return request.headers.get('Sec-Fetch-Site') !== 'cross-site';
        };
        async function ensureMirrorSiteTables() {
            await env.DB.batch([
                env.DB.prepare(`CREATE TABLE IF NOT EXISTS mirror_provider_controls (
                    provider TEXT PRIMARY KEY,
                    locked INTEGER NOT NULL DEFAULT 1 CHECK (locked IN (0, 1)),
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )`),
                env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_mirror_sites (
                    user_id INTEGER NOT NULL,
                    provider TEXT NOT NULL,
                    encrypted_key TEXT,
                    show_on_download INTEGER NOT NULL DEFAULT 1 CHECK (show_on_download IN (0, 1)),
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY(user_id, provider)
                )`)
            ]);
            await env.DB.batch(MIRROR_SITE_PROVIDERS.filter(p => p.accepts_key).map(p =>
                env.DB.prepare(`INSERT OR IGNORE INTO mirror_provider_controls (provider, locked) VALUES (?, ?)`)
                    .bind(p.id, p.initial_locked ? 1 : 0)
            ));
        }
        async function mirrorSiteListForUser(userId) {
            const [controls, prefs, account] = await Promise.all([
                env.DB.prepare('SELECT provider, locked FROM mirror_provider_controls').all(),
                env.DB.prepare(`SELECT provider, encrypted_key, show_on_download FROM user_mirror_sites WHERE user_id = ?`)
                    .bind(userId).all(),
                env.DB.prepare(`SELECT gofile_download_locked,pixeldrain_download_locked FROM users WHERE id=?`).bind(userId).first()
            ]);
            const locks = new Map((controls.results || []).map(r => [r.provider, Number(r.locked) === 1]));
            const userPrefs = new Map((prefs.results || []).map(r => [r.provider, r]));
            return MIRROR_SITE_PROVIDERS.map(p => {
                const pref = userPrefs.get(p.id);
                const downloadLocked = controlledDownloadProvider(p.id) && accountDownloadLocked(account,p.id);
                return {
                    id: p.id, name: p.name,
                    accepts_key: p.accepts_key,
                    locked: !p.accepts_key || (locks.get(p.id) ?? p.initial_locked),
                    has_key: !!pref?.encrypted_key,
                    download_locked: downloadLocked,
                    visible: !downloadLocked && (pref ? Number(pref.show_on_download) === 1 : true),
                    upload_integration_ready: false
                };
            });
        }

        // Verify user keys only with official provider APIs.
        // TOXCloud handling and upload pipeline are unchanged.
        async function verifyMirrorProviderKey(providerId, apiKey) {
            if (providerId !== "gofile" &&
                providerId !== "pixeldrain") {
                return null;
            }

            const endpoint = providerId === "gofile"
                ? "https://api.gofile.io/accounts/getid"
                : "https://pixeldrain.com/api/user";

            const authorization = providerId === "gofile"
                ? "Bearer " + apiKey
                : "Basic " + btoa(":" + apiKey);

            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(),
                12000
            );

            try {
                const response = await fetch(endpoint, {
                    method: "GET",
                    headers: {
                        "Accept": "application/json",
                        "Authorization": authorization
                    },
                    redirect: "manual",
                    signal: controller.signal
                });

                if (response.status === 401 ||
                    response.status === 403) {
                    return {
                        status: 400,
                        message: "Provider rejected this API key"
                    };
                }

                if (response.status === 429) {
                    return {
                        status: 503,
                        message: "Provider rate limit. Try later."
                    };
                }

                if (!response.ok) {
                    return {
                        status: 502,
                        message: "Provider API unavailable"
                    };
                }

                const length = Number(
                    response.headers.get("content-length") || 0
                );

                if (length > 65536) {
                    return {
                        status: 502,
                        message: "Unexpected provider response"
                    };
                }

                const raw = await response.text();

                if (raw.length > 65536) {
                    return {
                        status: 502,
                        message: "Unexpected provider response"
                    };
                }

                const data = JSON.parse(raw);

                const valid = providerId === "gofile"
                    ? data?.status === "ok" &&
                      !!data?.data?.id
                    : typeof data?.id === "string" &&
                      data.id.length > 0;

                return valid
                    ? null
                    : {
                        status: 400,
                        message: "Provider API key verification failed"
                    };

            } catch (error) {
                console.error(
                    "[MANAGE SITES] Provider verification failed:",
                    providerId,
                    error?.name || "Unknown"
                );

                return {
                    status: 503,
                    message: "Could not verify key with provider"
                };

            } finally {
                clearTimeout(timer);
            }
        }

        const isManageSitesApi = url.pathname === '/api/mirror-sites' ||
            url.pathname === '/api/mirror-sites/visibility' ||
            url.pathname === '/api/mirror-sites/key' ||
            url.pathname === '/api/mirror-sites/key/remove';
        if (isManageSitesApi) {
            if (request.method !== 'GET' && request.method !== 'POST') {
                return mirrorSiteReply({status:'error',message:'Method Not Allowed'},405);
            }
            const mirrorUser = await getCurrentUser(request, env);
            if (!mirrorUser) return mirrorSiteReply({status:'error',message:'Please log in'},401);
            if (request.method === 'POST' && !mirrorSiteSameOrigin()) {
                return mirrorSiteReply({status:'error',message:'Invalid request origin'},403);
            }
            try {
                await ensureMirrorSiteTables();
                if (url.pathname === '/api/mirror-sites' && request.method === 'GET') {
                    return mirrorSiteReply({status:'success',providers:await mirrorSiteListForUser(mirrorUser.id)});
                }
                if (request.method !== 'POST') return mirrorSiteReply({status:'error',message:'Method Not Allowed'},405);
                const body = await request.json();
                const providerId = String(body?.provider || '').trim().toLowerCase();
                const provider = mirrorSiteById(providerId);
                if (!provider) return mirrorSiteReply({status:'error',message:'Unknown server'},400);
                if (url.pathname === '/api/mirror-sites/visibility') {
                    if (typeof body.visible !== 'boolean') {
                        return mirrorSiteReply({status:'error',message:'visible must be true or false'},400);
                    }
                    if (controlledDownloadProvider(provider.id)) {
                        // Column name comes exclusively from the fixed allowlist.
                        const column = DOWNLOAD_LOCK_COLUMNS[provider.id];
                        const write = await env.DB.prepare(`INSERT INTO user_mirror_sites (user_id,provider,show_on_download)
                            SELECT ?,?,? FROM users WHERE id=? AND ${column}=0
                            ON CONFLICT(user_id,provider) DO UPDATE SET
                            show_on_download=excluded.show_on_download,updated_at=CURRENT_TIMESTAMP`)
                            .bind(mirrorUser.id,provider.id,body.visible ? 1 : 0,mirrorUser.id).run();
                        if (!write.meta?.changes) return mirrorSiteReply({status:'error',message:'Download option is locked by admin'},403);
                    } else {
                        await env.DB.prepare(`INSERT INTO user_mirror_sites (user_id, provider, show_on_download)
                            VALUES (?, ?, ?) ON CONFLICT(user_id,provider) DO UPDATE SET
                            show_on_download=excluded.show_on_download, updated_at=CURRENT_TIMESTAMP`)
                            .bind(mirrorUser.id, provider.id, body.visible ? 1 : 0).run();
                    }
                    return mirrorSiteReply({status:'success',provider:provider.id,visible:body.visible});
                }
                if (!provider.accepts_key) return mirrorSiteReply({status:'error',message:'This server has no user API key'},400);
                if (url.pathname === '/api/mirror-sites/key/remove') {
                    await env.DB.prepare(`UPDATE user_mirror_sites SET encrypted_key=NULL,
                        updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND provider=?`)
                        .bind(mirrorUser.id,provider.id).run();
                    return mirrorSiteReply({status:'success',provider:provider.id,has_key:false});
                }
                if (url.pathname === '/api/mirror-sites/key') {
                    const row = await env.DB.prepare('SELECT locked FROM mirror_provider_controls WHERE provider=?')
                        .bind(provider.id).first();
                    if (!row || Number(row.locked) !== 0) {
                        return mirrorSiteReply({status:'error',message:'API configuration is locked by admin'},403);
                    }
                    if (typeof body.api_key !== 'string' || body.api_key.length < 4 ||
                        body.api_key.length > 4096 || /[\x00-\x1f\x7f]/.test(body.api_key)) {
                        return mirrorSiteReply({status:'error',message:'Invalid API key format'},400);
                    }
                    const keyCheck =
                        await verifyMirrorProviderKey(
                            provider.id,
                            body.api_key
                        );

                    if (keyCheck) {
                        return mirrorSiteReply({
                            status: "error",
                            message: keyCheck.message
                        }, keyCheck.status);
                    }

                    // Reuse S-Cloud AES-GCM encryption; never return the secret to browser.
                    const encrypted = await encryptApiKey(body.api_key,env);
                    await env.DB.prepare(`INSERT INTO user_mirror_sites (user_id,provider,encrypted_key)
                        VALUES (?,?,?) ON CONFLICT(user_id,provider) DO UPDATE SET
                        encrypted_key=excluded.encrypted_key, updated_at=CURRENT_TIMESTAMP`)
                        .bind(mirrorUser.id,provider.id,encrypted).run();
                    return mirrorSiteReply({status:'success',provider:provider.id,has_key:true});
                }
                return mirrorSiteReply({status:'error',message:'Unknown action'},404);
            } catch (error) {
                console.error('[MANAGE SITES] user settings error:', error?.message || error);
                return mirrorSiteReply({status:'error',message:'Unable to save server settings'},500);
            }
        }
        if (url.pathname === '/api/admin/mirror-sites/downloads') {
            const admin = await getCurrentUser(request,env);
            if (!admin) return mirrorSiteReply({status:'error',message:'Authentication required'},401);
            if (String(admin.email||'').trim().toLowerCase() !== V4_OWNER_EMAIL) {
                return mirrorSiteReply({status:'error',message:'Admin access required'},403);
            }
            if (request.method === 'POST' && !mirrorSiteSameOrigin()) {
                return mirrorSiteReply({status:'error',message:'Invalid request origin'},403);
            }
            try {
                await ensureMirrorSiteTables();
                if (request.method === 'GET') {
                    const q=String(url.searchParams.get('q')||'').trim().slice(0,200);
                    const rows=await env.DB.prepare(`SELECT id,name,email,gofile_download_locked,pixeldrain_download_locked
                        FROM users WHERE ?='' OR instr(lower(COALESCE(name,'')),lower(?))>0
                        OR instr(lower(COALESCE(email,'')),lower(?))>0 OR CAST(id AS TEXT)=?
                        ORDER BY id DESC LIMIT 100`).bind(q,q,q,q).all();
                    return mirrorSiteReply({status:'success',users:(rows.results||[]).map(row=>({
                        id:row.id,name:row.name,email:row.email,
                        gofile_locked:accountDownloadLocked(row,'gofile'),
                        pixeldrain_locked:accountDownloadLocked(row,'pixeldrain')
                    }))});
                }
                if (request.method === 'POST') {
                    const body=await request.json();
                    const userId=Number(body?.user_id), provider=String(body?.provider||'');
                    if (!Number.isSafeInteger(userId)||userId<1||!controlledDownloadProvider(provider)||typeof body?.locked!=='boolean') {
                        return mirrorSiteReply({status:'error',message:'Invalid account, provider or lock status'},400);
                    }
                    if (!await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(userId).first()) {
                        return mirrorSiteReply({status:'error',message:'User not found'},404);
                    }
                    const column=DOWNLOAD_LOCK_COLUMNS[provider];
                    const statements=[env.DB.prepare(`UPDATE users SET ${column}=? WHERE id=?`).bind(body.locked?1:0,userId)];
                    if (!body.locked) {
                        // Admin unlock turns this server ON; the user may turn it OFF later.
                        statements.push(env.DB.prepare(`INSERT INTO user_mirror_sites(user_id,provider,show_on_download)
                            SELECT id,?,1 FROM users WHERE id=? ON CONFLICT(user_id,provider) DO UPDATE SET
                            show_on_download=1,updated_at=CURRENT_TIMESTAMP`).bind(provider,userId));
                        // Wake this account's existing paused PDLink jobs only, not running/done jobs.
                        if (String(env.SCLOUD_JOBS_ENABLED||'false').toLowerCase()==='true' &&
                            await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scloud_mirror_jobs'").first()) {
                            statements.push(env.DB.prepare(`UPDATE scloud_mirror_jobs SET state='queued',available_at=?,updated_at=CURRENT_TIMESTAMP
                                WHERE provider='pdlink' AND state='paused' AND file_id IN
                                (SELECT short_id FROM files WHERE user_id=? AND status='active' AND COALESCE(pdlink_share_id,'')='')`)
                                .bind(Date.now(),userId));
                        }
                    }
                    await env.DB.batch(statements);
                    return mirrorSiteReply({status:'success',user_id:userId,provider,locked:body.locked});
                }
                return mirrorSiteReply({status:'error',message:'Method Not Allowed'},405);
            } catch(error) {
                console.error('[DOWNLOAD LOCK] Admin update failed',error?.name||'Error');
                return mirrorSiteReply({status:'error',message:'Unable to manage account download locks'},500);
            }
        }
        if (url.pathname === '/api/admin/mirror-sites') {
            const mirrorAdmin = await getCurrentUser(request,env);
            if (!mirrorAdmin) return mirrorSiteReply({status:'error',message:'Authentication required'},401);
            if (String(mirrorAdmin.email||'').trim().toLowerCase() !== 'sagarmajethiya444@gmail.com') {
                return mirrorSiteReply({status:'error',message:'Admin access required'},403);
            }
            if (request.method === 'POST' && !mirrorSiteSameOrigin()) {
                return mirrorSiteReply({status:'error',message:'Invalid request origin'},403);
            }
            try {
                await ensureMirrorSiteTables();
                if (request.method === 'GET') {
                    const list = await mirrorSiteListForUser(mirrorAdmin.id);
                    return mirrorSiteReply({status:'success',providers:list.filter(p => p.accepts_key)
                        .map(({id,name,locked,upload_integration_ready}) => ({id,name,locked,upload_integration_ready}))});
                }
                if (request.method === 'POST') {
                    const body = await request.json();
                    const provider = mirrorSiteById(String(body?.provider||'').toLowerCase());
                    if (!provider?.accepts_key || typeof body.locked !== 'boolean') {
                        return mirrorSiteReply({status:'error',message:'Invalid provider or lock status'},400);
                    }
                    await env.DB.prepare(`UPDATE mirror_provider_controls SET locked=?,updated_at=CURRENT_TIMESTAMP
                        WHERE provider=?`).bind(body.locked ? 1 : 0,provider.id).run();
                    return mirrorSiteReply({status:'success',provider:provider.id,locked:body.locked});
                }
                return mirrorSiteReply({status:'error',message:'Method Not Allowed'},405);
            } catch (error) {
                console.error('[MANAGE SITES] admin controls error:', error?.message || error);
                return mirrorSiteReply({status:'error',message:'Unable to load server controls'},500);
            }
        }

        // ==================================================
        // PRIVATE ADMIN PANEL + SERVER-SIDE AUTHORIZATION
        // ==================================================
        const ADMIN_EMAIL = "sagarmajethiya444@gmail.com";
        const isAdminApi = url.pathname.startsWith("/api/admin/");

        if (url.pathname === "/admin1061") {
            const adminPageUser = await getCurrentUser(request, env);
            if (!adminPageUser) {
                const loginUrl = new URL("/", request.url);
                loginUrl.searchParams.set("redirect", "/admin1061");
                return Response.redirect(loginUrl.toString(), 302);
            }
            if (String(adminPageUser.email || "").toLowerCase() !== ADMIN_EMAIL) {
                return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" } });
            }
            return env.ASSETS.fetch(new Request(new URL("/admin.html", request.url), request));
        }

        if (isAdminApi) {
            const adminUser = await getCurrentUser(request, env);
            if (!adminUser) {
                return new Response(JSON.stringify({ status: "error", message: "Authentication required" }), { status: 401, headers: { ...corsHeaders, ...jsonHeaders() } });
            }
            if (String(adminUser.email || "").toLowerCase() !== ADMIN_EMAIL) {
                return new Response(JSON.stringify({ status: "error", message: "Admin access required" }), { status: 403, headers: { ...corsHeaders, ...jsonHeaders() } });
            }

            try {
                // Reuse the existing withdrawal tables and add only a small settings table.
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scloud_admin_settings (id INTEGER PRIMARY KEY CHECK (id = 1), exchange_rate REAL NOT NULL DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
                await env.DB.prepare(`INSERT OR IGNORE INTO scloud_admin_settings (id, exchange_rate) VALUES (1, 1)`).run();
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS withdrawal_settings (id INTEGER PRIMARY KEY, minimum_amount REAL NOT NULL DEFAULT 10.00, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
                await env.DB.prepare(`INSERT OR IGNORE INTO withdrawal_settings (id, minimum_amount) VALUES (1, 10.00)`).run();
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS payout_method_settings (method TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, minimum_amount REAL NOT NULL DEFAULT 10, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
                await env.DB.batch([
                    env.DB.prepare(`INSERT OR IGNORE INTO payout_method_settings (method, enabled, minimum_amount) VALUES ('upi', 1, 10)`),
                    env.DB.prepare(`INSERT OR IGNORE INTO payout_method_settings (method, enabled, minimum_amount) VALUES ('bank', 1, 10)`),
                    env.DB.prepare(`INSERT OR IGNORE INTO payout_method_settings (method, enabled, minimum_amount) VALUES ('paypal', 1, 10)`),
                    env.DB.prepare(`INSERT OR IGNORE INTO payout_method_settings (method, enabled, minimum_amount) VALUES ('crypto', 1, 10)`)
                ]);
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount REAL NOT NULL, method TEXT NOT NULL, payment_details TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, processed_at TIMESTAMP, processed_by INTEGER, rejection_reason TEXT)`).run();
                // Existing installations may have an older withdrawals schema. Add missing optional columns without deleting records.
                const withdrawalColumns = await env.DB.prepare(`PRAGMA table_info(withdrawals)`).all();
                const withdrawalColumnNames = new Set((withdrawalColumns.results || []).map(c => String(c.name)));
                if (!withdrawalColumnNames.has('payment_details')) {
                    await env.DB.prepare(`ALTER TABLE withdrawals ADD COLUMN payment_details TEXT`).run();
                }
                if (!withdrawalColumnNames.has('payout_reference')) {
                    await env.DB.prepare(`ALTER TABLE withdrawals ADD COLUMN payout_reference TEXT`).run();
                }
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_upload_limits (user_id INTEGER PRIMARY KEY, daily_limit INTEGER NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_daily_upload_usage (user_id INTEGER NOT NULL, usage_date TEXT NOT NULL, uploads_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, usage_date))`).run();

                const sendAdminJson = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, ...jsonHeaders() } });
                const path = url.pathname;
                await ensureV4Limits(env);

                if (path === "/api/admin/overview" && request.method === "GET") {
                    const [users, files, paid, pending] = await Promise.all([
                        env.DB.prepare(`SELECT COUNT(*) AS total FROM users`).first(),
                        env.DB.prepare(`SELECT COUNT(*) AS total FROM files`).first(),
                        env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'completed'`).first(),
                        env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status = 'pending'`).first(),
                    ]);
                    const rate = await env.DB.prepare(`SELECT exchange_rate FROM scloud_admin_settings WHERE id = 1`).first();
                    return sendAdminJson({ status: "success", data: { total_users: Number(users?.total || 0), total_files: Number(files?.total || 0), total_paid: Number(paid?.total || 0), pending_amount: Number(pending?.total || 0), exchange_rate: Number(rate?.exchange_rate || 1) } });
                }

                if (path === "/api/admin/users" && request.method === "GET") {
                    const result = await env.DB.prepare(`SELECT u.id, u.name, u.email, u.balance, u.custom_cpm, u.status, (SELECT COUNT(*) FROM files f WHERE f.user_id = u.id) AS file_count, CASE WHEN ul.user_id IS NULL THEN 20 ELSE ul.daily_limit END AS daily_upload_limit, COALESCE((SELECT folder_limit FROM user_folder_upload_limits WHERE user_id=u.id),20) AS folder_upload_limit, COALESCE(du.uploads_count, 0) AS uploads_today FROM users u LEFT JOIN user_upload_limits ul ON ul.user_id = u.id LEFT JOIN user_daily_upload_usage du ON du.user_id = u.id AND du.usage_date = date('now') ORDER BY u.id DESC LIMIT 500`).all();
                    return sendAdminJson({ status: "success", data: result.results || [] });
                }

                if(path==='/api/admin/user/folder-limit' && request.method==='POST') {
                    const body=await request.json(), id=Number(body.user_id), limit=Number(body.folder_limit);
                    if(!Number.isSafeInteger(id)||id<1||body.folder_limit==null||body.folder_limit===''||!Number.isInteger(limit)||limit<0||limit>1000) return sendAdminJson({status:'error',message:'Folder limit must be 0–1000'},400);
                    if(!await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first()) return sendAdminJson({status:'error',message:'User not found'},404);
                    await env.DB.prepare(`INSERT INTO user_folder_upload_limits(user_id,folder_limit) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET folder_limit=excluded.folder_limit`).bind(id,limit).run();
                    return sendAdminJson({status:'success'});
                }
                if(path==='/api/admin/support/start' && request.method==='POST') {
                    if(request.headers.get('Origin')!==url.origin) return sendAdminJson({status:'error',message:'Invalid origin'},403);
                    const body=await request.json(), targetId=Number(body.user_id);
                    if(!Number.isSafeInteger(targetId)||targetId<1||targetId===adminUser.id) return sendAdminJson({status:'error',message:'Select another user'},400);
                    if(!await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(targetId).first()) return sendAdminJson({status:'error',message:'User not found'},404);
                    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scloud_admin_support(token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL, admin_session_hash TEXT NOT NULL, target_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER)`).run();
                    const token=generateSessionToken(), hash=await sha256Hex(token), now=Date.now();
                    await env.DB.prepare(`INSERT INTO scloud_admin_support(token_hash,admin_id,admin_session_hash,target_id,expires_at,started_at) VALUES(?,?,?,?,?,?)`).bind(hash,adminUser.id,await sha256Hex(getCookie(request,'scloud_session')||''),targetId,now+900000,now).run();
                    return new Response(JSON.stringify({status:'success'}),{headers:{...jsonHeaders(),'Set-Cookie':`${V4_SUPPORT_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,'Cache-Control':'no-store'}});
                }

                if (path === "/api/admin/user/upload-limit" && request.method === "POST") {
                    const body = await request.json();
                    const userId = Number(body.user_id);
                    const dailyLimit = body.daily_limit === null || body.daily_limit === "" || body.daily_limit === undefined ? null : Number(body.daily_limit);
                    if (!Number.isInteger(userId) || userId < 1 || (dailyLimit !== null && (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 1000000))) {
                        return sendAdminJson({ status: "error", message: "Daily upload limit must be blank for unlimited or a whole number from 0 to 1,000,000" }, 400);
                    }
                    const target = await env.DB.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`).bind(userId).first();
                    if (!target) return sendAdminJson({ status: "error", message: "User not found" }, 404);
                    await env.DB.prepare(`INSERT INTO user_upload_limits (user_id, daily_limit, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET daily_limit = excluded.daily_limit, updated_at = CURRENT_TIMESTAMP`).bind(userId, dailyLimit).run();
                    return sendAdminJson({ status: "success", message: dailyLimit === null ? "Daily upload limit set to Unlimited" : `Daily upload limit set to ${dailyLimit}` });
                }

                if (path === "/api/admin/user/status" && request.method === "POST") {
                    const body = await request.json();
                    const userId = Number(body.user_id);
                    const status = String(body.status || "");
                    if (!Number.isInteger(userId) || userId < 1 || !["active", "banned"].includes(status)) return sendAdminJson({ status: "error", message: "Invalid user or status" }, 400);
                    const target = await env.DB.prepare(`SELECT id, email FROM users WHERE id = ? LIMIT 1`).bind(userId).first();
                    if (!target) return sendAdminJson({ status: "error", message: "User not found" }, 404);
                    if (String(target.email || "").toLowerCase() === ADMIN_EMAIL) return sendAdminJson({ status: "error", message: "The owner account cannot be banned" }, 400);
                    await env.DB.prepare(`UPDATE users SET status = ? WHERE id = ?`).bind(status, userId).run();
                    return sendAdminJson({ status: "success", message: "User status updated" });
                }

                if (path === "/api/admin/user/cpm" && request.method === "POST") {
                    const body = await request.json();
                    const userId = Number(body.user_id);
                    const cpm = Number(body.custom_cpm);
                    if (!Number.isInteger(userId) || userId < 1 || !Number.isFinite(cpm) || cpm < 0 || cpm > 100000) return sendAdminJson({ status: "error", message: "Invalid user or CPM" }, 400);
                    const result = await env.DB.prepare(`UPDATE users SET custom_cpm = ? WHERE id = ?`).bind(cpm, userId).run();
                    if (!result.meta?.changes) return sendAdminJson({ status: "error", message: "User not found" }, 404);
                    return sendAdminJson({ status: "success", message: "CPM updated" });
                }

                if (path === "/api/admin/payouts" && request.method === "GET") {
                    const result = await env.DB.prepare(`SELECT w.id, w.user_id, w.amount, w.method, w.payment_details, w.status, w.requested_at AS created_at, w.processed_at, w.rejection_reason, w.payout_reference, u.name, u.email FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id ORDER BY CASE WHEN w.status = 'pending' THEN 0 ELSE 1 END, w.id DESC LIMIT 500`).all();
                    return sendAdminJson({ status: "success", data: result.results || [] });
                }

                if (path === "/api/admin/payout-methods" && request.method === "GET") {
                    const result = await env.DB.prepare(`SELECT method, enabled, minimum_amount FROM payout_method_settings ORDER BY CASE method WHEN 'upi' THEN 1 WHEN 'bank' THEN 2 WHEN 'paypal' THEN 3 ELSE 4 END`).all();
                    return sendAdminJson({ status: "success", data: result.results || [] });
                }

                if (path === "/api/admin/payout-methods" && request.method === "POST") {
                    const body = await request.json();
                    const allowed = new Set(["upi", "bank", "paypal", "crypto"]);
                    if (!Array.isArray(body.methods) || body.methods.length !== 4) return sendAdminJson({ status: "error", message: "Submit all four payment methods" }, 400);
                    const seen = new Set();
                    const statements = [];
                    for (const item of body.methods) {
                        const method = String(item?.method || "").toLowerCase();
                        const enabled = item?.enabled === true || item?.enabled === 1 ? 1 : item?.enabled === false || item?.enabled === 0 ? 0 : -1;
                        const minimum = Number(item?.minimum_amount);
                        if (!allowed.has(method) || seen.has(method) || enabled < 0 || !Number.isFinite(minimum) || minimum < 0 || minimum > 100000000) return sendAdminJson({ status: "error", message: "Invalid method settings or minimum amount" }, 400);
                        seen.add(method);
                        statements.push(env.DB.prepare(`INSERT INTO payout_method_settings (method, enabled, minimum_amount, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(method) DO UPDATE SET enabled = excluded.enabled, minimum_amount = excluded.minimum_amount, updated_at = CURRENT_TIMESTAMP`).bind(method, enabled, minimum));
                    }
                    if (seen.size !== 4) return sendAdminJson({ status: "error", message: "Submit all four payment methods" }, 400);
                    await env.DB.batch(statements);
                    return sendAdminJson({ status: "success", message: "Payment method settings saved" });
                }

                if (path === "/api/admin/settings" && request.method === "GET") {
                    const rate = await env.DB.prepare(`SELECT exchange_rate FROM scloud_admin_settings WHERE id = 1`).first();
                    return sendAdminJson({ status: "success", data: { exchange_rate: Number(rate?.exchange_rate || 1) } });
                }

                if (path === "/api/admin/settings" && request.method === "POST") {
                    const body = await request.json();
                    const rate = Number(body.exchange_rate);
                    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000000) return sendAdminJson({ status: "error", message: "Invalid exchange rate" }, 400);
                    await env.DB.prepare(`INSERT INTO scloud_admin_settings (id, exchange_rate, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET exchange_rate = excluded.exchange_rate, updated_at = CURRENT_TIMESTAMP`).bind(rate).run();
                    return sendAdminJson({ status: "success", message: "Exchange rate saved" });
                }

                if (path === "/api/admin/payout" && request.method === "POST") {
                    const body = await request.json();
                    const withdrawalId = Number(body.withdrawal_id);
                    const action = String(body.action || '').toLowerCase();
                    const reference = String(body.reference || '').trim().slice(0, 120);
                    const reason = String(body.reason || '').trim().slice(0, 500);
                    if (!Number.isInteger(withdrawalId) || withdrawalId < 1 || !['approve', 'reject', 'paid'].includes(action)) return sendAdminJson({ status: 'error', message: 'Invalid payout action' }, 400);
                    const row = await env.DB.prepare(`SELECT id, user_id, amount, status FROM withdrawals WHERE id = ?`).bind(withdrawalId).first();
                    if (!row) return sendAdminJson({ status: 'error', message: 'Withdrawal not found' }, 404);
                    if (action === 'approve') {
                        if (row.status !== 'pending') return sendAdminJson({ status: 'error', message: 'Only pending requests can be approved' }, 409);
                        const upd = await env.DB.prepare(`UPDATE withdrawals SET status='approved', processed_at=CURRENT_TIMESTAMP, processed_by=?, rejection_reason=NULL WHERE id=? AND status='pending'`).bind(adminUser.id, withdrawalId).run();
                        if (!upd.meta?.changes) return sendAdminJson({ status: 'error', message: 'Request was already processed; refresh and try again' }, 409);
                        return sendAdminJson({ status: 'success', message: 'Withdrawal approved. Pay manually, then mark Paid with UTR/reference.' });
                    }
                    if (action === 'reject') {
                        if (!['pending', 'approved'].includes(row.status)) return sendAdminJson({ status: 'error', message: 'Only pending or approved requests can be rejected' }, 409);
                        if (!reason) return sendAdminJson({ status: 'error', message: 'Rejection reason is required' }, 400);
                        const upd = await env.DB.prepare(`UPDATE withdrawals SET status='rejected', processed_at=CURRENT_TIMESTAMP, processed_by=?, rejection_reason=? WHERE id=? AND status=?`).bind(adminUser.id, reason, withdrawalId, row.status).run();
                        if (!upd.meta?.changes) return sendAdminJson({ status: 'error', message: 'Request was already processed; refresh and try again' }, 409);
                        await env.DB.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`).bind(Number(row.amount), Number(row.user_id)).run();
                        return sendAdminJson({ status: 'success', message: 'Withdrawal rejected and amount returned to user balance' });
                    }
                    if (row.status !== 'approved') return sendAdminJson({ status: 'error', message: 'Approve the request first; only approved requests can be marked Paid' }, 409);
                    if (!reference) return sendAdminJson({ status: 'error', message: 'Enter the UTR/payment reference after making the manual payment' }, 400);
                    const upd = await env.DB.prepare(`UPDATE withdrawals SET status='completed', payout_reference=?, processed_at=CURRENT_TIMESTAMP, processed_by=? WHERE id=? AND status='approved'`).bind(reference, adminUser.id, withdrawalId).run();
                    if (!upd.meta?.changes) return sendAdminJson({ status: 'error', message: 'Request was already processed; refresh and try again' }, 409);
                    return sendAdminJson({ status: 'success', message: 'Payout marked Paid and reference saved' });
                }

                return sendAdminJson({ status: "error", message: "Admin endpoint not found" }, 404);
            } catch (error) {
                console.error("Admin API error:", error);
                const detail = String(error?.message || 'Unknown database error').slice(0, 240);
                return new Response(JSON.stringify({ status: "error", message: `Admin request failed: ${detail}` }), { status: 500, headers: { ...corsHeaders, ...jsonHeaders() } });
            }
        }

        // ==================================================
        // API KEY MANAGEMENT
        // ==================================================


        // ==================================================
        // GET API KEY
        // ==================================================

        if (
            url.pathname ===
                "/api/key" &&
            request.method ===
                "GET"
        ) {
            try {

                const user =
                    await getCurrentUser(
                        request,
                        env
                    );

                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Authentication required"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                await ensureApiKeyTable(
                    env
                );


                let key =
                    await getUserApiKey(
                        user.id,
                        env
                    );


                // ------------------------------------------
                // FIRST TIME
                // ------------------------------------------

                if (
                    !key
                ) {

                    const generated =
                        await createApiKey(
                            user.id,
                            env
                        );


                    return new Response(
                        JSON.stringify({
                            status:
                                "success",
                            message:
                                "API key created successfully.",
                            data: {
                                api_key:
                                    generated.apiKey,
                                key_prefix:
                                    generated.keyPrefix,
                                is_new:
                                    true,
                                warning:
                                    "Your API key is stored encrypted and can be viewed again from the API page."
                            }
                        }),
                        {
                            status: 200,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        data: {
                            key_prefix:
                                key.key_prefix,
                            status:
                                key.status,
                            created_at:
                                key.created_at,
                            last_used_at:
                                key.last_used_at,
                            is_new:
                                false,
                            api_key:
                                key.api_key || null,
                            requires_regeneration:
                                !key.api_key,
                            message:
                                key.api_key
                                    ? "Your API key is active and stored encrypted. You can view the full key again anytime."
                                    : "This API key was created before secure key storage was enabled. Regenerate it once to enable full-key viewing."
                        }
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Get API Key Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to load API key"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // REGENERATE API KEY
        // ==================================================

        if (
            url.pathname ===
                "/api/key/regenerate" &&
            request.method ===
                "POST"
        ) {
            try {

                const user =
                    await getCurrentUser(
                        request,
                        env
                    );


                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Authentication required"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                await ensureApiKeyTable(
                    env
                );


                await revokeUserApiKeys(
                    user.id,
                    env
                );


                const generated =
                    await createApiKey(
                        user.id,
                        env
                    );


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "API key regenerated successfully. Your previous key is now invalid.",
                        data: {
                            api_key:
                                generated.apiKey,
                            key_prefix:
                                generated.keyPrefix,
                            is_new:
                                true,
                            warning:
                                "Your API key is stored encrypted and can be viewed again from the API page."
                        }
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Regenerate API Key Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to regenerate API key"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // REVOKE API KEY
        // ==================================================

        if (
            url.pathname ===
                "/api/key/revoke" &&
            request.method ===
                "POST"
        ) {
            try {

                const user =
                    await getCurrentUser(
                        request,
                        env
                    );


                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Authentication required"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                await ensureApiKeyTable(
                    env
                );


                await revokeUserApiKeys(
                    user.id,
                    env
                );


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "API key revoked successfully."
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Revoke API Key Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to revoke API key"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 1. SIGNUP
        // ==================================================

        if (
            url.pathname ===
                "/api/signup" &&
            request.method ===
                "POST"
        ) {
            try {

                const body =
                    await request.json();

                const {
                    name,
                    email,
                    password
                } = body;


                if (
                    !name ||
                    !email ||
                    !password
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "All fields are required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const cleanName =
                    String(
                        name
                    ).trim();

                const cleanEmail =
                    String(
                        email
                    )
                        .trim()
                        .toLowerCase();

                const cleanPassword =
                    String(
                        password
                    );


                if (
                    cleanName.length <
                    2
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Name is too short"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    cleanName.length >
                    80
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Name is too long"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
                        cleanEmail
                    )
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Please enter a valid email address"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    cleanPassword.length <
                    8
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Password must be at least 8 characters"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    cleanPassword.length >
                    200
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Password is too long"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const existingUser =
                    await env.DB
                        .prepare(
                            "SELECT id FROM users WHERE email = ? LIMIT 1"
                        )
                        .bind(
                            cleanEmail
                        )
                        .first();


                if (
                    existingUser
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Email is already registered"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const hashedPassword =
                    await hashPassword(
                        cleanPassword
                    );


                await env.DB
                    .prepare(
                        `INSERT INTO users
                        (
                            name,
                            email,
                            password_hash,
                            role,
                            balance,
                            custom_cpm,
                            status,
                            gofile_download_locked,
                            pixeldrain_download_locked
                        )
                        VALUES (?, ?, ?, 'publisher', 0, 0, 'active', 1, 1)`
                    )
                    .bind(
                        cleanName,
                        cleanEmail,
                        hashedPassword
                    )
                    .run();


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Account created successfully!"
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Signup Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            error?.message || String(error)
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 2. LOGIN
        // ==================================================

        if (
            url.pathname ===
                "/api/login" &&
            request.method ===
                "POST"
        ) {
            try {

                const body =
                    await request.json();

                const {
                    email,
                    password
                } = body;


                const clientIP =
                    request.headers.get(
                        "CF-Connecting-IP"
                    ) ||
                    "Unknown IP";

                const userAgent =
                    request.headers.get(
                        "User-Agent"
                    ) ||
                    "Unknown Device";


                if (
                    !email ||
                    !password
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Email and password are required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const cleanEmail =
                    String(
                        email
                    )
                        .trim()
                        .toLowerCase();


                const cleanPassword =
                    String(
                        password
                    );


                const user =
                    await env.DB
                        .prepare(
                            "SELECT * FROM users WHERE email = ? LIMIT 1"
                        )
                        .bind(
                            cleanEmail
                        )
                        .first();


                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid email or password"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                // --------------------------------------
                // CHECK PASSWORD
                // --------------------------------------

                const passwordResult =
                    await verifyPassword(
                        cleanPassword,
                        user.password_hash
                    );


                if (
                    !passwordResult.valid
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid email or password"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                // --------------------------------------
                // CHECK BANNED USER
                // --------------------------------------

                if (
                    user.status ===
                    "banned"
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Your account has been banned."
                        }),
                        {
                            status: 403,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                // --------------------------------------
                // UPGRADE OLD SHA-256 PASSWORD
                // --------------------------------------

                if (
                    passwordResult.legacy
                ) {

                    try {

                        const newPasswordHash =
                            await hashPassword(
                                cleanPassword
                            );

                        await env.DB
                            .prepare(
                                `UPDATE users
                                 SET password_hash = ?
                                 WHERE id = ?`
                            )
                            .bind(
                                newPasswordHash,
                                user.id
                            )
                            .run();

                    } catch (
                        migrationError
                    ) {

                        console.error(
                            "Password migration error:",
                            migrationError
                        );
                    }
                }


                // --------------------------------------
                // UPDATE LOGIN IP
                // --------------------------------------

                await env.DB
                    .prepare(
                        "UPDATE users SET last_login_ip = ? WHERE id = ?"
                    )
                    .bind(
                        clientIP,
                        user.id
                    )
                    .run();


                // --------------------------------------
                // LOGIN HISTORY
                // --------------------------------------

                await env.DB
                    .prepare(
                        `INSERT INTO login_history
                        (
                            user_id,
                            ip_address,
                            device_info
                        )
                        VALUES (?, ?, ?)`
                    )
                    .bind(
                        user.id,
                        clientIP,
                        userAgent
                    )
                    .run();


                // --------------------------------------
                // CREATE SESSION
                // --------------------------------------

                const session =
                    await createSession(
                        user.id,
                        env
                    );


                // --------------------------------------
                // CLEAN OLD EXPIRED SESSIONS
                // --------------------------------------

                ctx.waitUntil(
                    cleanExpiredSessions(
                        env
                    )
                );


                // --------------------------------------
                // SAFE USER DATA
                // --------------------------------------

                const userData = {
                    id:
                        user.id,
                    name:
                        user.name,
                    email:
                        user.email,
                    role:
                        user.role,
                    balance:
                        user.balance,
                    custom_cpm:
                        user.custom_cpm,
                    status:
                        user.status,
                    last_login_ip:
                        clientIP,
                    created_at:
                        user.created_at
                };


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Login successful!",
                        userData:
                            userData
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders(),
                            "Set-Cookie":
                                createSessionCookie(
                                    session.rawToken
                                )
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Login Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to login right now"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 3. CURRENT USER
        // ==================================================

        if (
            url.pathname ===
                "/api/me" &&
            request.method ===
                "GET"
        ) {
            try {

                const user =
                    await getCurrentUser(
                        request,
                        env
                    );

                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Not authenticated"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        userData:
                            user
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Me Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to verify session"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 3.5. UPDATE PROFILE
        // ==================================================

        if (
            url.pathname ===
                "/api/profile/update" &&
            request.method ===
                "POST"
        ) {
            try {

                const user =
                    await getCurrentUser(
                        request,
                        env
                    );

                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Authentication required"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                let body;

                try {
                    body =
                        await request.json();
                } catch (
                    error
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid JSON request"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                const requestedName =
                    body?.name ??
                    body?.username;

                if (
                    requestedName ===
                        undefined ||
                    requestedName ===
                        null
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Name is required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                const cleanName =
                    String(
                        requestedName
                    ).trim();

                if (
                    cleanName.length <
                    2
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Name must be at least 2 characters"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                if (
                    cleanName.length >
                    80
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Name must not exceed 80 characters"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                await env.DB
                    .prepare(
                        `UPDATE users
                         SET name = ?
                         WHERE id = ?`
                    )
                    .bind(
                        cleanName,
                        user.id
                    )
                    .run();

                const updatedUser =
                    await getCurrentUser(
                        request,
                        env
                    );

                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Profile updated successfully!",
                        userData:
                            updatedUser
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Profile Update Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to update profile"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }

        // ==================================================
        // 3.6. UPDATE SHARED BY SETTINGS
        // ==================================================

        if (
            url.pathname ===
                "/api/shared-by/update" &&
            request.method ===
                "POST"
        ) {
            try {

                const user =
                    await getCurrentUser(
                        request,
                        env
                    );

                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Authentication required"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                let body;

                try {
                    body =
                        await request.json();
                } catch (
                    error
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid JSON request"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                const rawSharedBy =
                    typeof body?.sharedBy ===
                    "string"
                        ? body.sharedBy.trim()
                        : "";

                const rawSharedByUrl =
                    typeof body?.sharedByUrl === "string"
                        ? body.sharedByUrl.trim()
                        : "";

                if (rawSharedByUrl.length > 500) {
                    return new Response(JSON.stringify({
                        status: "error",
                        message: "Website URL cannot exceed 500 characters."
                    }), {
                        status: 400,
                        headers: { ...corsHeaders, ...jsonHeaders() }
                    });
                }

                let sharedByUrl = null;
                if (rawSharedByUrl) {
                    try {
                        const parsedUrl = new URL(rawSharedByUrl);
                        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
                            throw new Error("Unsupported protocol");
                        }
                        sharedByUrl = parsedUrl.href;
                    } catch {
                        return new Response(JSON.stringify({
                            status: "error",
                            message: "Enter a valid website URL beginning with https:// or http://."
                        }), {
                            status: 400,
                            headers: { ...corsHeaders, ...jsonHeaders() }
                        });
                    }
                }

                const requestedEnabled =
                    body?.enabled === true ||
                    body?.enabled === 1 ||
                    body?.enabled === "1";

                if (
                    rawSharedBy.length > 120
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Shared by name cannot exceed 120 characters."
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                const sharedBy =
                    rawSharedBy ||
                    null;

                /*
                 * Blank Shared by always forces the setting OFF.
                 */
                const enabled =
                    sharedBy &&
                    requestedEnabled
                        ? 1
                        : 0;

                await env.DB
                    .prepare(
                        `UPDATE users
                         SET
                            shared_by = ?,
                            shared_by_enabled = ?,
                            shared_by_url = ?
                         WHERE id = ?`
                    )
                    .bind(
                        sharedBy,
                        enabled,
                        sharedByUrl,
                        user.id
                    )
                    .run();

                const updatedUser =
                    await getCurrentUser(
                        request,
                        env
                    );

                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Shared by settings updated successfully.",
                        userData:
                            updatedUser
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Shared by update error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to update Shared by settings."
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }




        // ==================================================
        // 3.6. CHANGE PASSWORD
        // ==================================================

        if (
            url.pathname ===
                "/api/password/change" &&
            request.method ===
                "POST"
        ) {
            try {

                const user =
                    await getCurrentUser(
                        request,
                        env
                    );

                if (
                    !user
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Authentication required"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                let body;

                try {
                    body =
                        await request.json();
                } catch (
                    error
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid JSON request"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                const currentPassword =
                    String(
                        body?.current_password ??
                            ""
                    );

                const newPassword =
                    String(
                        body?.new_password ??
                            ""
                    );

                const confirmPassword =
                    String(
                        body?.confirm_password ??
                            ""
                    );

                if (
                    !currentPassword ||
                    !newPassword ||
                    !confirmPassword
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "All password fields are required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                if (
                    newPassword.length <
                    8
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "New password must be at least 8 characters"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                if (
                    newPassword.length >
                    200
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "New password is too long"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                if (
                    newPassword !==
                    confirmPassword
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "New passwords do not match"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                const dbUser =
                    await env.DB
                        .prepare(
                            `SELECT
                                id,
                                password_hash,
                                status
                             FROM users
                             WHERE id = ?
                             LIMIT 1`
                        )
                        .bind(
                            user.id
                        )
                        .first();

                if (
                    !dbUser
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "User account not found"
                        }),
                        {
                            status: 404,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                const passwordResult =
                    await verifyPassword(
                        currentPassword,
                        dbUser.password_hash
                    );

                if (
                    !passwordResult.valid
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Current password is incorrect"
                        }),
                        {
                            status: 401,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                const samePasswordResult =
                    await verifyPassword(
                        newPassword,
                        dbUser.password_hash
                    );

                if (
                    samePasswordResult.valid
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "New password must be different from your current password"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                const newPasswordHash =
                    await hashPassword(
                        newPassword
                    );

                await env.DB
                    .prepare(
                        `UPDATE users
                         SET password_hash = ?
                         WHERE id = ?`
                    )
                    .bind(
                        newPasswordHash,
                        user.id
                    )
                    .run();

                const currentToken =
                    getCookie(
                        request,
                        "scloud_session"
                    );

                if (
                    currentToken
                ) {

                    const currentTokenHash =
                        await sha256Hex(
                            currentToken
                        );

                    await env.DB
                        .prepare(
                            `DELETE FROM sessions
                             WHERE user_id = ?
                             AND session_token_hash != ?`
                        )
                        .bind(
                            user.id,
                            currentTokenHash
                        )
                        .run();

                } else {

                    await env.DB
                        .prepare(
                            `DELETE FROM sessions
                             WHERE user_id = ?`
                        )
                        .bind(
                            user.id
                        )
                        .run();
                }

                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Password changed successfully. Other active sessions have been logged out."
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Password Change Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to change password"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 4. LOGOUT
        // ==================================================

        if (
            url.pathname ===
                "/api/logout" &&
            request.method ===
                "POST"
        ) {
            try {

                await deleteCurrentSession(
                    request,
                    env
                );


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Logged out successfully"
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders(),
                            "Set-Cookie":
                                clearSessionCookie()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Logout Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Unable to logout"
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders(),
                            "Set-Cookie":
                                clearSessionCookie()
                        }
                    }
                );
            }
        }



        // ==================================================
        // WITHDRAWAL TABLES
        // ==================================================
        async function ensureWithdrawalTables(env) {
            await env.DB.prepare(`
                CREATE TABLE IF NOT EXISTS withdrawal_settings (
                    id INTEGER PRIMARY KEY,
                    minimum_amount REAL NOT NULL DEFAULT 10.00,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `).run();

            await env.DB.prepare(`
                INSERT OR IGNORE INTO withdrawal_settings (id, minimum_amount)
                VALUES (1, 10.00)
            `).run();

            await env.DB.prepare(`
                CREATE TABLE IF NOT EXISTS withdrawals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    method TEXT NOT NULL,
                    payment_details TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    processed_at TIMESTAMP,
                    processed_by INTEGER,
                    rejection_reason TEXT
                )
            `).run();

            const cols = await env.DB.prepare(`PRAGMA table_info(withdrawals)`).all();
            const names = new Set((cols.results || []).map(c => String(c.name)));
            if (!names.has('payment_details')) {
                await env.DB.prepare(`ALTER TABLE withdrawals ADD COLUMN payment_details TEXT`).run();
            }
            if (!names.has('payout_reference')) {
                await env.DB.prepare(`ALTER TABLE withdrawals ADD COLUMN payout_reference TEXT`).run();
            }

            await env.DB.prepare(`
                CREATE INDEX IF NOT EXISTS idx_withdrawals_user
                ON withdrawals(user_id)
            `).run();

            await env.DB.prepare(`
                CREATE INDEX IF NOT EXISTS idx_withdrawals_status
                ON withdrawals(status)
            `).run();
        }


        // Public exchange rate displayed on the withdrawal page.
        if (url.pathname === "/api/payout-info" && request.method === "GET") {
            try {
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scloud_admin_settings (id INTEGER PRIMARY KEY CHECK (id = 1), exchange_rate REAL NOT NULL DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
                await env.DB.prepare(`INSERT OR IGNORE INTO scloud_admin_settings (id, exchange_rate) VALUES (1, 1)`).run();
                await ensureWithdrawalTables(env);
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS payout_method_settings (method TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, minimum_amount REAL NOT NULL DEFAULT 10, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
                await env.DB.batch([
                    env.DB.prepare(`INSERT OR IGNORE INTO payout_method_settings (method, enabled, minimum_amount) VALUES ('upi', 1, 10)`),
                    env.DB.prepare(`INSERT OR IGNORE INTO payout_method_settings (method, enabled, minimum_amount) VALUES ('bank', 1, 10)`),
                    env.DB.prepare(`INSERT OR IGNORE INTO payout_method_settings (method, enabled, minimum_amount) VALUES ('paypal', 1, 10)`),
                    env.DB.prepare(`INSERT OR IGNORE INTO payout_method_settings (method, enabled, minimum_amount) VALUES ('crypto', 1, 10)`)
                ]);
                const [rate, methods] = await Promise.all([
                    env.DB.prepare(`SELECT exchange_rate FROM scloud_admin_settings WHERE id = 1`).first(),
                    env.DB.prepare(`SELECT method, enabled, minimum_amount FROM payout_method_settings`).all()
                ]);
                return jsonResponse({ status: 'success', exchange_rate: Number(rate?.exchange_rate ?? 1), methods: methods.results || [] });
            } catch (error) {
                console.error('Payout info error:', error);
                return jsonResponse({ status: 'error', message: 'Unable to load payout settings' }, 500);
            }
        }

        // ==================================================
        // WITHDRAWAL API
        // ==================================================
        if (url.pathname === "/api/withdraw") {
            const user = await getCurrentUser(request, env);

            if (!user) {
                return jsonResponse(
                    { status: "error", message: "Unauthorized" },
                    401
                );
            }

            await ensureWithdrawalTables(env);

            if (request.method === "GET") {
                const pending = await env.DB.prepare(`
                    SELECT COALESCE(SUM(amount), 0) AS total
                    FROM withdrawals
                    WHERE user_id = ?
                    AND status = 'pending'
                `).bind(user.id).first();

                const paid = await env.DB.prepare(`
                    SELECT COALESCE(SUM(amount), 0) AS total
                    FROM withdrawals
                    WHERE user_id = ?
                    AND status = 'completed'
                `).bind(user.id).first();

                const history = await env.DB.prepare(`
                    SELECT
                        id,
                        amount,
                        method,
                        status,
                        requested_at AS created_at,
                        processed_at,
                        rejection_reason
                    FROM withdrawals
                    WHERE user_id = ?
                    ORDER BY id DESC
                `).bind(user.id).all();

                return jsonResponse({
                    status: "success",
                    balance: Number(user.balance || 0),
                    pendingAmount: Number(pending?.total || 0),
                    totalPaid: Number(paid?.total || 0),
                    history: history.results || []
                });
            }

            if (request.method === "POST") {
                let body;

                try {
                    body = await request.json();
                } catch {
                    return jsonResponse(
                        { status: "error", message: "Invalid JSON" },
                        400
                    );
                }

                const amount = Number(body.amount);
                const method = String(body.method || "").toLowerCase();
                const details = body.paymentDetails || {};

                if (! ["upi", "bank", "paypal", "crypto"].includes(method)) {
                    return jsonResponse({ status: "error", message: "Invalid payment method" }, 400);
                }
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS payout_method_settings (method TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, minimum_amount REAL NOT NULL DEFAULT 10, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
                await env.DB.prepare(`INSERT OR IGNORE INTO payout_method_settings (method, enabled, minimum_amount) VALUES (?, 1, 10)`).bind(method).run();
                const methodSettings = await env.DB.prepare(`SELECT enabled, minimum_amount FROM payout_method_settings WHERE method = ?`).bind(method).first();
                if (!methodSettings || Number(methodSettings.enabled) !== 1) {
                    return jsonResponse({ status: "error", message: "This payment method is currently unavailable. Please choose another method." }, 400);
                }
                const minimum = Number(methodSettings.minimum_amount ?? 0);

                if (!Number.isFinite(amount) || amount < minimum) {
                    return jsonResponse({
                        status: "error",
                        message: `Minimum withdrawal is $${minimum.toLocaleString("en-US", { maximumFractionDigits: 3 })}`
                    }, 400);
                }

                if (amount > Number(user.balance || 0)) {
                    return jsonResponse({
                        status: "error",
                        message: "Insufficient balance"
                    }, 400);
                }

                if (method === "upi") {
                    const upi = String(details.upiId || "").trim();

                    if (!/^[^\s@]+@[^\s@]+$/.test(upi)) {
                        return jsonResponse({
                            status: "error",
                            message: "Invalid UPI ID"
                        }, 400);
                    }
                }

                if (method === "bank") {
                    const name = String(details.bankName || "").trim();
                    const acc = String(details.bankAcc || "").trim();
                    const ifsc = String(details.bankIfsc || "").trim().toUpperCase();

                    if (
                        !name ||
                        name.length > 100 ||
                        !/^\d{6,30}$/.test(acc) ||
                        !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)
                    ) {
                        return jsonResponse({
                            status: "error",
                            message: "Invalid bank details"
                        }, 400);
                    }

                    details.bankIfsc = ifsc;
                }

                if (method === "paypal") {
                    const email = String(details.paypalEmail || "").trim();

                    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                        return jsonResponse({
                            status: "error",
                            message: "Invalid PayPal email"
                        }, 400);
                    }
                }

                if (method === "crypto") {
                    const address = String(details.cryptoAddress || "").trim();

                    if (address.length < 20 || address.length > 100) {
                        return jsonResponse({
                            status: "error",
                            message: "Invalid crypto address"
                        }, 400);
                    }
                }

                const paymentDetailsJson = JSON.stringify(details);

                if (paymentDetailsJson.length > 5000) {
                    return jsonResponse({
                        status: "error",
                        message: "Payment details are too large"
                    }, 400);
                }

                const balanceUpdate = env.DB.prepare(`
                    UPDATE users
                    SET balance = balance - ?
                    WHERE id = ?
                    AND balance >= ?
                `).bind(amount, user.id, amount);

                const withdrawalInsert = env.DB.prepare(`
                    INSERT INTO withdrawals
                    (user_id, amount, method, payment_details, status)
                    VALUES (?, ?, ?, ?, 'pending')
                `).bind(
                    user.id,
                    amount,
                    method,
                    paymentDetailsJson
                );

                await env.DB.batch([
                    balanceUpdate,
                    withdrawalInsert
                ]);

                const updatedUser = await env.DB.prepare(`
                    SELECT balance
                    FROM users
                    WHERE id = ?
                `).bind(user.id).first();

                return jsonResponse({
                    status: "success",
                    message: "Withdrawal request submitted successfully",
                    balance: Number(updatedUser?.balance || 0)
                });
            }

            return jsonResponse({
                status: "error",
                message: "Method not allowed"
            }, 405);
        }

        // ==================================================
        // AUTHENTICATED USER
        // ==================================================

        let currentUser =
            null;


        if (
            url.pathname ===
                "/api/files" ||
            url.pathname ===
                "/api/rename" ||
            url.pathname ===
                "/api/delete" ||
            url.pathname ===
                "/api/sharing" ||
            url.pathname ===
                "/api/upload" ||
            url.pathname ===
                "/api/folder-files" ||
            url.pathname ===
                "/api/profile/update" ||
            url.pathname ===
                "/api/password/change" ||
            url.pathname ===
                "/api/withdraw" ||
            url.pathname ===
                "/api/dashboard" ||
            url.pathname ===
                "/v1/upload"
        ) {

            if (
                url.pathname ===
                    "/v1/upload"
            ) {

                currentUser =
                    await authenticateApiKey(
                        request,
                        env
                    );

            } else {

                currentUser =
                    await getCurrentUser(
                        request,
                        env
                    );
            }

            if (
                !currentUser
            ) {
                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            url.pathname ===
                                "/v1/upload"
                                ? "Valid API key required"
                                : "Authentication required"
                    }),
                    {
                        status: 401,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // DASHBOARD API
        // ==================================================

        if (
            url.pathname ===
                "/api/dashboard" &&
            request.method ===
                "GET"
        ) {
            try {

                const now = new Date();

                const indiaDate =
                    new Intl.DateTimeFormat(
                        "en-CA",
                        {
                            timeZone:
                                "Asia/Kolkata",
                            year:
                                "numeric",
                            month:
                                "2-digit",
                            day:
                                "2-digit"
                        }
                    ).format(now);

                const requestedDate =
                    url.searchParams.get("date") ||
                    indiaDate;

                const requestedMonth =
                    url.searchParams.get("month") ||
                    requestedDate.slice(0, 7);

                if (
                    !/^\d{4}-\d{2}-\d{2}$/.test(
                        requestedDate
                    )
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid date"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                if (
                    !/^\d{4}-\d{2}$/.test(
                        requestedMonth
                    )
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid month"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                // ==========================================
                // LIFETIME REVENUE
                // ==========================================

                const lifetimeEarnings =
                    await env.DB
                        .prepare(
                            `SELECT
                                COALESCE(
                                    SUM(
                                        CASE
                                            WHEN e.status = 'credited'
                                            THEN amount
                                            ELSE 0
                                        END
                                    ),
                                    0
                                ) AS total
                             FROM earnings e
                             WHERE e.user_id = ?`
                        )
                        .bind(
                            currentUser.id
                        )
                        .first();


                const paidWithdrawals =
                    await env.DB
                        .prepare(
                            `SELECT
                                COALESCE(
                                    SUM(amount),
                                    0
                                ) AS total
                             FROM withdrawals w
                             WHERE w.user_id = ?
                             AND w.status = 'completed'`
                        )
                        .bind(
                            currentUser.id
                        )
                        .first();


                const approvedWithdrawals =
                    await env.DB
                        .prepare(
                            `SELECT
                                COALESCE(
                                    SUM(amount),
                                    0
                                ) AS total
                             FROM withdrawals w
                             WHERE w.user_id = ?
                             AND w.status = 'approved'`
                        )
                        .bind(
                            currentUser.id
                        )
                        .first();


                const pendingWithdrawals =
                    await env.DB
                        .prepare(
                            `SELECT
                                COALESCE(
                                    SUM(amount),
                                    0
                                ) AS total
                             FROM withdrawals w
                             WHERE w.user_id = ?
                             AND w.status = 'pending'`
                        )
                        .bind(
                            currentUser.id
                        )
                        .first();


                // ==========================================
                // DAILY UPLOADS
                // ==========================================

                const dailyUploads =
                    await env.DB
                        .prepare(
                            `SELECT
                                COUNT(*) AS total
                             FROM files
                             WHERE user_id = ?
                             AND status != 'deleted'
                             AND date(
                                 created_at,
                                 '+05:30'
                             ) = ?`
                        )
                        .bind(
                            currentUser.id,
                            requestedDate
                        )
                        .first();


                // ==========================================
                // DAILY VIEWS
                // ==========================================

                const dailyViews =
                    await env.DB
                        .prepare(
                            `SELECT
                                COUNT(*) AS total
                             FROM views_log vl
                             INNER JOIN files f
                                ON f.id = vl.file_id
                             WHERE f.user_id = ?
                             AND f.status != 'deleted'
                             AND date(
                                 vl.viewed_at,
                                 '+05:30'
                             ) = ?`
                        )
                        .bind(
                            currentUser.id,
                            requestedDate
                        )
                        .first();


                // ==========================================
                // DAILY EARNINGS
                // ==========================================

                const dailyEarnings =
                    await env.DB
                        .prepare(
                            `SELECT
                                COALESCE(
                                    SUM(
                                        CASE
                                            WHEN e.status = 'credited'
                                            THEN amount
                                            ELSE 0
                                        END
                                    ),
                                    0
                                ) AS total
                             FROM earnings e
                             WHERE e.user_id = ?
                             AND date(
                                 e.created_at,
                                 '+05:30'
                             ) = ?`
                        )
                        .bind(
                            currentUser.id,
                            requestedDate
                        )
                        .first();


                // ==========================================
                // MONTHLY UPLOADS
                // ==========================================

                const monthlyUploads =
                    await env.DB
                        .prepare(
                            `SELECT
                                COUNT(*) AS total
                             FROM files
                             WHERE user_id = ?
                             AND status != 'deleted'
                             AND strftime(
                                 '%Y-%m',
                                 created_at,
                                 '+05:30'
                             ) = ?`
                        )
                        .bind(
                            currentUser.id,
                            requestedMonth
                        )
                        .first();


                // ==========================================
                // MONTHLY VIEWS
                // ==========================================

                const monthlyViews =
                    await env.DB
                        .prepare(
                            `SELECT
                                COUNT(*) AS total
                             FROM views_log vl
                             INNER JOIN files f
                                ON f.id = vl.file_id
                             WHERE f.user_id = ?
                             AND f.status != 'deleted'
                             AND strftime(
                                 '%Y-%m',
                                 vl.viewed_at,
                                 '+05:30'
                             ) = ?`
                        )
                        .bind(
                            currentUser.id,
                            requestedMonth
                        )
                        .first();


                // ==========================================
                // MONTHLY EARNINGS
                // ==========================================

                const monthlyEarnings =
                    await env.DB
                        .prepare(
                            `SELECT
                                COALESCE(
                                    SUM(
                                        CASE
                                            WHEN e.status = 'credited'
                                            THEN e.amount
                                            ELSE 0
                                        END
                                    ),
                                    0
                                ) AS total
                             FROM earnings e
                             WHERE e.user_id = ?
                             AND strftime(
                                 '%Y-%m',
                                 e.created_at,
                                 '+05:30'
                             ) = ?`
                        )
                        .bind(
                            currentUser.id,
                            requestedMonth
                        )
                        .first();


                // ==========================================
                // LAST 7 DAYS CHART
                // ==========================================

                const chartResult =
                    await env.DB
                        .prepare(
                            `SELECT
                                date(
                                    vl.viewed_at,
                                    '+05:30'
                                ) AS day,
                                COUNT(*) AS views
                             FROM views_log vl
                             INNER JOIN files f
                                ON f.id = vl.file_id
                             WHERE f.user_id = ?
                             AND f.status != 'deleted'
                             AND date(
                                 vl.viewed_at,
                                 '+05:30'
                             ) BETWEEN
                                 date(?, '-6 days')
                                 AND ?
                             GROUP BY day
                             ORDER BY day ASC`
                        )
                        .bind(
                            currentUser.id,
                            requestedDate,
                            requestedDate
                        )
                        .all();


                const chartMap =
                    new Map();

                for (
                    const row of
                    chartResult.results ||
                    []
                ) {
                    chartMap.set(
                        row.day,
                        Number(
                            row.views || 0
                        )
                    );
                }


                const chart = [];

                for (
                    let i = 6;
                    i >= 0;
                    i--
                ) {
                    const date =
                        new Date(
                            `${requestedDate}T00:00:00Z`
                        );

                    date.setUTCDate(
                        date.getUTCDate() -
                        i
                    );

                    const day =
                        date
                            .toISOString()
                            .slice(
                                0,
                                10
                            );

                    chart.push({
                        date:
                            day,
                        views:
                            chartMap.get(
                                day
                            ) || 0
                    });
                }


                // ==========================================
                // RECENT FILES
                // ==========================================

                const recentFiles =
                    await env.DB
                        .prepare(
                            `SELECT
                                f.id,
                                f.short_id,
                                f.file_name,
                                f.views,
                                f.created_at,
                                COALESCE(
                                    SUM(
                                        CASE
                                            WHEN e.status = 'credited'
                                            THEN e.amount
                                            ELSE 0
                                        END
                                    ),
                                    0
                                ) AS earnings
                             FROM files f
                             LEFT JOIN earnings e
                                ON e.file_id = f.id
                             WHERE f.user_id = ?
                             AND f.status != 'deleted'
                             GROUP BY
                                f.id,
                                f.short_id,
                                f.file_name,
                                f.views,
                                f.created_at
                             ORDER BY
                                f.created_at DESC
                             LIMIT 5`
                        )
                        .bind(
                            currentUser.id
                        )
                        .all();


                // ==========================================
                // MONTH OPTIONS
                // ==========================================

                const monthOptions = [];

                const monthOptionsNow = new Date();
                const dateParts = new Intl.DateTimeFormat("en-US", {
                    year: "numeric",
                    month: "2-digit",
                    timeZone: "Asia/Kolkata"
                }).formatToParts(monthOptionsNow);

                const baseYear = Number(dateParts.find(p => p.type === "year").value);
                const baseMonth = Number(dateParts.find(p => p.type === "month").value) - 1;

                for (let i = 0; i < 12; i++) {
                    const d = new Date(Date.UTC(baseYear, baseMonth - i, 1));
                    const value = d.toISOString().slice(0, 7);
                    const label = new Intl.DateTimeFormat("en-US", {
                        month: "short",
                        year: "numeric",
                        timeZone: "UTC"
                    }).format(d);

                    monthOptions.push({ value, label });
                }


                return new Response(
                    JSON.stringify({
                        status:
                            "success",

                        revenue: {
                            total:
                                Number(
                                    lifetimeEarnings?.total ||
                                    0
                                ),
                            paid:
                                Number(
                                    paidWithdrawals?.total ||
                                    0
                                ),
                            available:
                                Number(
                                    currentUser.balance ||
                                    0
                                ),
                            approved:
                                Number(
                                    approvedWithdrawals?.total ||
                                    0
                                ),
                            pending:
                                Number(
                                    pendingWithdrawals?.total ||
                                    0
                                )
                        },

                        daily: {
                            date:
                                requestedDate,
                            uploadedFiles:
                                Number(
                                    dailyUploads?.total ||
                                    0
                                ),
                            views:
                                Number(
                                    dailyViews?.total ||
                                    0
                                ),
                            earnings:
                                Number(
                                    dailyEarnings?.total ||
                                    0
                                )
                        },

                        monthly: {
                            month:
                                requestedMonth,
                            uploadedFiles:
                                Number(
                                    monthlyUploads?.total ||
                                    0
                                ),
                            views:
                                Number(
                                    monthlyViews?.total ||
                                    0
                                ),
                            earnings:
                                Number(
                                    monthlyEarnings?.total ||
                                    0
                                )
                        },

                        chart,

                        recentFiles:
                            recentFiles.results ||
                            [],

                        monthOptions
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                console.error(
                    "Dashboard API Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            error.message
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 5. GET FILES
        // ==================================================

        if (
            url.pathname ===
                "/api/files" &&
            request.method ===
                "POST"
        ) {
            try {

                const {
                    results
                } =
                    await env.DB
                        .prepare(
                            `SELECT
                                f.*,
                                COALESCE(
                                    SUM(
                                        CASE
                                            WHEN e.status = 'credited'
                                            THEN e.amount
                                            ELSE 0
                                        END
                                    ),
                                    0
                                ) AS earnings
                             FROM files f
                             LEFT JOIN earnings e
                                ON e.file_id = f.id
                             WHERE f.user_id = ?
                               AND COALESCE(f.status, '') != 'deleted'
                             GROUP BY f.id
                             ORDER BY f.created_at DESC`
                        )
                        .bind(
                            currentUser.id
                        )
                        .all();


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        data:
                            results
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            error.message
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 6. RENAME FILE
        // ==================================================

        if (
            url.pathname ===
                "/api/rename" &&
            request.method ===
                "POST"
        ) {
            try {

                const body =
                    await request.json();

                const {
                    file_id,
                    new_name
                } = body;


                if (
                    !file_id ||
                    !new_name
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "File ID and new name are required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const cleanName =
                    String(
                        new_name
                    ).trim();


                if (
                    !cleanName
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "New name cannot be empty"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                if (
                    cleanName.length >
                    255
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "File name is too long"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                const result =
                    await env.DB
                        .prepare(
                            `UPDATE files
                             SET file_name = ?,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE
                                (id = ? OR short_id = ?)
                                AND user_id = ?
                                AND status != 'deleted'`
                        )
                        .bind(
                            cleanName,
                            file_id,
                            file_id,
                            currentUser.id
                        )
                        .run();
                        {
                            const downloadSyncRecord =
                                await env.DB
                                    .prepare(
                                        "SELECT * FROM files WHERE (id = ? OR short_id = ?) LIMIT 1"
                                    )
                                    .bind(
                                        file_id,
                                        file_id
                                    )
                                    .first();
    
                            if (downloadSyncRecord) {
                                await syncDownloadMetadata(
                                    downloadSyncRecord,
                                    env
                                );
                            }
                        }


                if (
                    (result.meta?.changes ??
                        0) === 0
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "File not found"
                        }),
                        {
                            status: 404,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "Renamed successfully!",
                        changes:
                            result.meta?.changes ??
                            0
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            error.message
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 7. TOGGLE PUBLIC SHARING
        // ==================================================

        if (
            url.pathname === "/api/sharing" &&
            request.method === "POST"
        ) {
            try {
                const body = await request.json();
                const fileId = body.file_id || body.id || body.short_id;
                const enabled = body.enabled;

                if (!fileId || typeof enabled !== "boolean") {
                    return new Response(JSON.stringify({
                        status: "error",
                        message: "File ID and sharing state are required."
                    }), {
                        status: 400,
                        headers: { ...corsHeaders, ...jsonHeaders() }
                    });
                }

                // Add the field lazily so existing D1 databases migrate safely.
                // Existing files default to sharing ON; no earning/view history is changed.
                try {
                    await env.DB.prepare(
                        "ALTER TABLE files ADD COLUMN sharing_enabled INTEGER NOT NULL DEFAULT 1"
                    ).run();
                } catch (schemaError) {
                    const schemaMessage = String(schemaError?.message || schemaError);
                    if (!/duplicate column name|already exists/i.test(schemaMessage)) {
                        throw schemaError;
                    }
                }

                const result = await env.DB.prepare(
                    `UPDATE files
                     SET sharing_enabled = ?,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE (id = ? OR short_id = ?)
                       AND user_id = ?
                       AND COALESCE(status, '') != 'deleted'`
                ).bind(
                    enabled ? 1 : 0,
                    fileId,
                    fileId,
                    currentUser.id
                ).run();
                {
                    const downloadSyncRecord =
                        await env.DB
                            .prepare(
                                "SELECT * FROM files WHERE (id = ? OR short_id = ?) LIMIT 1"
                            )
                            .bind(
                                fileId,
                                fileId
                            )
                            .first();
    
                    if (downloadSyncRecord) {
                        await syncDownloadMetadata(
                            downloadSyncRecord,
                            env
                        );
                    }
                }

                if ((result.meta?.changes ?? 0) === 0) {
                    return new Response(JSON.stringify({
                        status: "error",
                        message: "File not found."
                    }), {
                        status: 404,
                        headers: { ...corsHeaders, ...jsonHeaders() }
                    });
                }

                return new Response(JSON.stringify({
                    status: "success",
                    enabled,
                    message: enabled ? "Sharing enabled." : "Sharing disabled."
                }), {
                    status: 200,
                    headers: { ...corsHeaders, ...jsonHeaders() }
                });
            } catch (error) {
                console.error("Sharing toggle error:", error);
                return new Response(JSON.stringify({
                    status: "error",
                    message: error.message || "Unable to update sharing."
                }), {
                    status: 500,
                    headers: { ...corsHeaders, ...jsonHeaders() }
                });
            }
        }


        // ==================================================
        // 8. PERMANENT DELETE FROM FILES (preserve financial history)
        // ==================================================
        if (url.pathname === '/api/delete' && request.method === 'POST') {
            try {
                const body = await request.json();
                const fileId = String(body?.file_id || '').trim();
                if (!fileId || fileId.length > 128) {
                    return new Response(JSON.stringify({ status: 'error', message: 'Valid file ID is required.' }), {
                        status: 400, headers: { ...corsHeaders, ...jsonHeaders() }
                    });
                }

                const file = await env.DB.prepare(`
                    SELECT * FROM files
                    WHERE (id = ? OR short_id = ?) AND user_id = ?
                      AND COALESCE(status, '') != 'deleted'
                    LIMIT 1
                `).bind(fileId, fileId, currentUser.id).first();

                if (!file) {
                    return new Response(JSON.stringify({ status: 'error', message: 'File not found.' }), {
                        status: 404, headers: { ...corsHeaders, ...jsonHeaders() }
                    });
                }

                // Financial ledger MUST survive deletion, including previously
                // withdrawn earnings. Fail safely if FK rules could alter it.
                const ledgerFK = await env.DB.prepare('PRAGMA foreign_key_list(earnings)').all();
                const hasLedgerForeignKey = (ledgerFK?.results || []).some(fk =>
                    String(fk.table || '').toLowerCase() === 'files'
                );
                if (hasLedgerForeignKey) {
                    const ledgerEntries = await env.DB.prepare(
                        'SELECT COUNT(*) AS total FROM earnings WHERE file_id = ?'
                    ).bind(file.id).first();
                    if (Number(ledgerEntries?.total || 0) > 0) {
                        return new Response(JSON.stringify({
                            status: 'error',
                            message: 'Deletion blocked: financial ledger has a files foreign key. Preserve earnings via a separate D1 schema migration first.'
                        }), { status: 409, headers: { ...corsHeaders, ...jsonHeaders() } });
                    }
                }

                // Disable cached/signed download in the separate Download Worker
                // BEFORE removing the D1 source row. Abort on sync failure.
                const disabled = await syncDownloadMetadata(
                    { ...file, status: 'deleted', sharing_enabled: 0 }, env
                );
                if (!disabled) {
                    return new Response(JSON.stringify({
                        status: 'error',
                        message: 'Download Worker could not confirm link disablement. No file was deleted; try again.'
                    }), { status: 503, headers: { ...corsHeaders, ...jsonHeaders() } });
                }

                // The tracking table is created by the rotation script, so it
                // may not exist in some installations. Check it before batch.
                const hasTracking = await env.DB.prepare(`
                    SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name = 'pdlink_rotation_jobs'
                    LIMIT 1
                `).first();
                await ensureScloudJobTables(env);
                const statements = [
                    env.DB.prepare(`
                        DELETE FROM files
                        WHERE id = ? AND user_id = ?
                          AND COALESCE(status, '') != 'deleted'
                    `).bind(file.id, currentUser.id)
                ];
                // Copy cleanup must be queued before dedupe/registry rows are removed.
                // The Google Drive API is called later, NEVER inside D1 transaction.
                statements.push(env.DB.prepare(`
                    INSERT OR IGNORE INTO scloud_drive_cleanup_jobs
                      (copied_drive_id, user_id, account_number, folder_id, state, available_at)
                    SELECT r.copied_drive_id, r.user_id, r.account_number,
                           r.folder_id, 'queued', ?
                    FROM scloud_drive_copy_registry r
                    JOIN scloud_upload_sources s
                      ON s.user_id = r.user_id AND s.source_hash = r.source_hash
                    WHERE s.user_id = ? AND s.file_short_id = ?
                      AND changes() > 0
                `).bind(Date.now(), currentUser.id, file.short_id || file.id));

                if (hasTracking) {
                    statements.push(env.DB.prepare(`
                        DELETE FROM pdlink_rotation_jobs
                        WHERE record_id = ? AND changes() > 0
                    `).bind(file.id));
                }
                const hasSourceTracking = await env.DB.prepare(`
                    SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name = 'scloud_upload_sources'
                    LIMIT 1
                `).first();
                if (hasSourceTracking) {
                    statements.push(env.DB.prepare(`
                        DELETE FROM scloud_upload_sources
                        WHERE user_id = ? AND file_short_id = ?
                          AND NOT EXISTS (
                              SELECT 1 FROM files
                              WHERE id = ? AND user_id = ?
                          )
                    `).bind(currentUser.id, file.short_id || file.id,
                           file.id, currentUser.id));
                }
                // A new upload of the same source after user deletion must not
                // collide with the old registry; the cleanup queue owns it now.
                statements.push(env.DB.prepare(`
                    DELETE FROM scloud_drive_copy_registry
                    WHERE user_id = ? AND copied_drive_id = ?
                      AND EXISTS (
                          SELECT 1 FROM scloud_drive_cleanup_jobs q
                          WHERE q.copied_drive_id = scloud_drive_copy_registry.copied_drive_id
                      ) AND NOT EXISTS (
                          SELECT 1 FROM scloud_upload_sources s
                          WHERE s.user_id = scloud_drive_copy_registry.user_id
                            AND s.source_hash = scloud_drive_copy_registry.source_hash
                      )
                `).bind(currentUser.id, (String(file.drive_url || '').match(/\/file\/d\/([A-Za-z0-9_-]+)/) || [])[1] || ''));
                statements.push(env.DB.prepare(`
                    DELETE FROM scloud_mirror_jobs WHERE file_id = ?
                `).bind(file.short_id || file.id));
                // D1 batches run transactionally. No earnings, balance,
                // withdrawals, or visitor accounting rows are modified.
                const results = await env.DB.batch(statements);
                const deletedCount = Number(results?.[0]?.meta?.changes || 0);
                if (deletedCount !== 1) {
                    return new Response(JSON.stringify({
                        status: 'error',
                        message: 'File was not removed; please refresh and check before retrying.'
                    }), { status: 409, headers: { ...corsHeaders, ...jsonHeaders() } });
                }
                const remaining = await env.DB.prepare(
                    'SELECT id FROM files WHERE id = ? LIMIT 1'
                ).bind(file.id).first();
                if (remaining) {
                    return new Response(JSON.stringify({
                        status: 'error', message: 'D1 deletion verification failed.'
                    }), { status: 500, headers: { ...corsHeaders, ...jsonHeaders() } });
                }
                return new Response(JSON.stringify({
                    status: 'success',
                    message: 'File permanently removed from D1. Historical earnings and withdrawals preserved.',
                    deleted_id: file.id
                }), { status: 200, headers: { ...corsHeaders, ...jsonHeaders() } });
            } catch (error) {
                console.error('[DELETE] Permanent delete failed:', error);
                return new Response(JSON.stringify({
                    status: 'error',
                    message: 'Deletion could not be confirmed. Check D1 and Download Worker state before retrying.'
                }), { status: 500, headers: { ...corsHeaders, ...jsonHeaders() } });
            }
        }


        // ==================================================
        // GOOGLE DRIVE FOLDER FILE LIST (per-user cap)
        // ==================================================

        if(url.pathname==='/api/upload-limits' && request.method==='GET') {
            const user=await getCurrentUser(request,env);
            if(!user) return jsonResponse({status:'error',message:'Authentication required'},401);
            return jsonResponse({status:'success',data:await v4UploadLimits(env,user.id)});
        }

        if (
            url.pathname === "/api/folder-files" &&
            request.method === "POST"
        ) {
            try {
                const body = await request.json();
                const folderUrl = String(body?.folder_url || "").trim();
                const folderId=v4DriveId(folderUrl,true);
                if(!folderId) return jsonResponse({status:'error',message:'Please enter a valid Google Drive folder link.'},400);
                const limits=await v4UploadLimits(env,currentUser.id);
                if(!limits.folder_limit) return jsonResponse({status:'error',code:'FOLDER_UPLOAD_LIMIT',message:'Folder upload is disabled for your account.'},429);
                if(limits.remaining===0) return jsonResponse({status:'error',code:'DAILY_UPLOAD_LIMIT',message:`Daily upload limit reached (${limits.uploads_today}/${limits.daily_limit}). Try again after the daily reset.`,...limits},429);
                const cap=Math.min(limits.folder_limit,limits.remaining??limits.folder_limit);
                const listed=await v4ListFolder(folderId,env,cap);
                if(!listed.files.length) return jsonResponse({status:'error',message:'No files found inside this folder.'},400);
                return jsonResponse({status:'success',...listed,total:listed.files.length,limit:cap,folder_limit:limits.folder_limit,remaining:limits.remaining});
            } catch (err) {
                console.error("Folder list error:", err);
                return new Response(JSON.stringify({
                    status: "error",
                    message: "Failed to read folder contents. Check that the folder is accessible and try again."
                }), { status: 400, headers: { ...corsHeaders, ...jsonHeaders() } });
            }
        }

        // ==================================================
        // 8. UPLOAD
        // ==================================================

        if (
            (
                url.pathname ===
                    "/api/upload" &&
                request.method ===
                    "POST"
            ) ||
            (
                url.pathname ===
                    "/v1/upload" &&
                request.method ===
                    "GET"
            )
        ) {
            let uploadReservation = false;
            let sourceUploadClaimed = false;
            let sourceCopyStarted = false;
            let sourceUploadHash = null;
            // Direct-source uploads require the durable Cron queue. Existing
            // copied files keep their original behavior when this is disabled.
            const directSourceMode =
                String(env.SCLOUD_DIRECT_SOURCE_ENABLED || "false").toLowerCase() === "true";
            if (directSourceMode &&
                String(env.SCLOUD_JOBS_ENABLED || "false").toLowerCase() !== "true") {
                return jsonResponse({
                    status: "error",
                    code: "DIRECT_SOURCE_REQUIRES_JOBS",
                    message: "Background jobs must be enabled for direct-source uploads."
                }, 503);
            }
            const uploadStartedAt = Date.now();
            const uploadUsageDate = new Date().toISOString().slice(0, 10);
            try {
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_upload_limits (user_id INTEGER PRIMARY KEY, daily_limit INTEGER NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
                await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_daily_upload_usage (user_id INTEGER NOT NULL, usage_date TEXT NOT NULL, uploads_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, usage_date))`).run();

                let drive_url;

                if (
                    url.pathname ===
                        "/v1/upload"
                ) {

                    drive_url =
                        url.searchParams.get(
                            "url"
                        ) ||
                        url.searchParams.get(
                            "drive_url"
                        );

                } else {

                    const body =
                        await request.json();

                    drive_url =
                        body?.drive_url;
                }


                if (
                    !drive_url
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Google Drive URL required"
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                let cleanUrl =
                    String(
                        drive_url
                    ).trim();


                // --------------------------------------
                // GOOGLE DRIVE FOLDER
                // --------------------------------------

                if (
                    cleanUrl.includes(
                        "/drive/folders/"
                    )
                ) {

                    const folderId =
                        extractFolderId(
                            cleanUrl
                        );


                    if (
                        !folderId
                    ) {
                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "Invalid Google Drive Folder ID!"
                            }),
                            {
                                status: 400,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }


                    try {

                        if(!v4DriveId(cleanUrl,true)) return jsonResponse({status:'error',message:'Invalid Google Drive folder URL'},400);
                        const limits=await v4UploadLimits(env,currentUser.id);
                        if(!limits.folder_limit) return jsonResponse({status:'error',code:'FOLDER_UPLOAD_LIMIT',message:'Folder upload is disabled for your account.'},429);
                        if(limits.remaining===0) return jsonResponse({status:'error',code:'DAILY_UPLOAD_LIMIT',message:'Daily upload limit reached.',...limits},429);
                        const listed=await v4ListFolder(folderId,env,1);
                        if(!listed.files.length) return jsonResponse({status:'error',message:'No files found inside this folder.'},400);
                        cleanUrl=`https://drive.google.com/file/d/${listed.files[0].id}/view`;

                    } catch (
                        err
                    ) {

                        console.error(
                            "Folder Error:",
                            err
                        );

                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "Failed to read folder contents via Google API."
                            }),
                            {
                                status: 400,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }
                }


                // --------------------------------------
                // VALIDATE GOOGLE DRIVE LINK
                // --------------------------------------

                const sourceFileId=v4DriveId(cleanUrl);
                if(!sourceFileId) return jsonResponse({status:'error',message:'Invalid Google Drive Link format!'},400);
                // Normalize for the legacy copy helper; direct source uses the parsed ID.
                cleanUrl=`https://drive.google.com/file/d/${sourceFileId}/view`;

                // ====================================================
                // PER-USER SOURCE DRIVE DEDUPLICATION
                // One original Drive ID per uploader, regardless of
                // URL format. Never persist the original URL/ID.
                // A D1 unique claim prevents parallel files.copy calls.
                // ====================================================
                sourceUploadHash = await sha256Hex(sourceFileId);

                await env.DB.prepare(`
                    CREATE TABLE IF NOT EXISTS scloud_upload_sources (
                        user_id INTEGER NOT NULL,
                        source_hash TEXT NOT NULL,
                        state TEXT NOT NULL DEFAULT 'processing',
                        file_short_id TEXT,
                        copied_drive_id TEXT,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (user_id, source_hash)
                    )
                `).run();

                // Each completed copy remembers its owning account and folder.
                // This will support safe retention/cleanup and per-account recovery.
                await env.DB.prepare(`
                    CREATE TABLE IF NOT EXISTS scloud_drive_copy_registry (
                        user_id INTEGER NOT NULL,
                        source_hash TEXT NOT NULL,
                        copied_drive_id TEXT NOT NULL,
                        account_number INTEGER NOT NULL,
                        folder_id TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (user_id, source_hash)
                    )
                `).run();


                // Durable mirror and cleanup jobs live in this SAME D1 database.
                await ensureScloudJobTables(env);

                const existingSourceReply = async () => {
                    const previous = await env.DB.prepare(`
                        SELECT s.state AS source_state,
                               s.file_short_id, s.copied_drive_id,
                               f.short_id AS existing_short_id,
                               f.file_name, f.file_size,
                               f.status AS file_status,
                               f.sharing_enabled
                        FROM scloud_upload_sources AS s
                        LEFT JOIN files AS f
                          ON f.short_id = s.file_short_id
                         AND f.user_id = s.user_id
                        WHERE s.user_id = ? AND s.source_hash = ?
                        LIMIT 1
                    `).bind(currentUser.id, sourceUploadHash).first();

                    if (!previous) return null;

                    if (previous.existing_short_id &&
                        previous.file_status !== "deleted") {
                        const existingShortId = previous.existing_short_id;
                        const alreadyHidden =
                            Number(previous.sharing_enabled ?? 1) === 0;
                        const existingLink =
                            `${canonicalPublicOrigin}/d/${existingShortId}`;
                        return jsonResponse({
                            status: "success",
                            already_uploaded: true,
                            message: alreadyHidden
                                ? "Already uploaded. Sharing is OFF for this file."
                                : "This Google Drive file was already uploaded.",
                            data: {
                                file_name: previous.file_name || "Unknown File",
                                file_size: previous.file_size || "Unknown",
                                short_id: existingShortId,
                                short_link: existingLink,
                                already_uploaded: true,
                                sharing_enabled: !alreadyHidden
                            }
                        });
                    }

                    // If a user permanently deleted the original file,
                    // allow fresh upload. No S-Cloud copy is performed here.
                    if (previous.file_short_id &&
                        previous.file_status === "deleted") {
                        await env.DB.prepare(`
                            DELETE FROM scloud_upload_sources
                            WHERE user_id = ? AND source_hash = ?
                              AND file_short_id = ?
                              AND NOT EXISTS (
                                  SELECT 1 FROM files
                                  WHERE short_id = ? AND user_id = ?
                                    AND COALESCE(status, '') != 'deleted'
                              )
                        `).bind(
                            currentUser.id, sourceUploadHash,
                            previous.file_short_id,
                            previous.file_short_id, currentUser.id
                        ).run();
                        return null;
                    }

                    return jsonResponse({
                        status: "processing",
                        code: "UPLOAD_IN_PROGRESS",
                        message: previous.copied_drive_id
                            ? "This Drive file was already copied; its upload needs completion or review."
                            : "This Drive file is already being processed. Try again once its upload finishes."
                    }, 409);
                };

                const existingBeforeMetadata = await existingSourceReply();
                if (existingBeforeMetadata) return existingBeforeMetadata;
                // Quick quota check before the Drive API call. The atomic reservation below remains authoritative.
                const earlyLimit=await env.DB.prepare(`SELECT NULLIF(COALESCE((SELECT COALESCE(daily_limit,-1) FROM user_upload_limits WHERE user_id=?),20),-1) AS daily_limit, COALESCE((SELECT uploads_count FROM user_daily_upload_usage WHERE user_id=? AND usage_date=?),0) AS uploads_today`).bind(currentUser.id,currentUser.id,uploadUsageDate).first();
                if(earlyLimit?.daily_limit!=null && Number(earlyLimit.uploads_today)>=Number(earlyLimit.daily_limit)) return jsonResponse({status:'error',code:'DAILY_UPLOAD_LIMIT',message:`Daily upload limit reached (${earlyLimit.uploads_today}/${earlyLimit.daily_limit}). Try again after the daily reset.`,daily_limit:Number(earlyLimit.daily_limit),uploads_today:Number(earlyLimit.uploads_today)},429);


                // Use the same numbered OAuth account for source metadata
                // AND the eventual files.copy request; no cross-account mix.
                let selectedCopyAccount = directSourceMode ? await selectDriveMetadataAccount(sourceFileId,env) : await selectDriveCopyAccount(sourceFileId,env);

                // --------------------------------------
                // GET SOURCE FILE METADATA
                // --------------------------------------

                let actualFileName =
                    "Unknown File";

                let exactFileSize =
                    "Unknown";

                let actualMimeType =
                    null;


                try {

                    const token = selectedCopyAccount.token;

                    let metaData = directSourceMode ? selectedCopyAccount.metadata : null;
                    if (!metaData) {
                        const metaRes = await fetch(
                            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}?fields=name,size,mimeType&supportsAllDrives=true`,
                            {headers:{Authorization:`Bearer ${token}`}}
                        );
                        metaData = await metaRes.json();
                        if (!metaRes.ok) throw new Error(metaData.error?.message || "Google Drive metadata error");
                    }

                    // Unknown size on a binary source cannot be safely routed.
                    if (!String(metaData?.mimeType || "").startsWith("application/vnd.google-apps.") &&
                        (metaData?.size == null || !Number.isFinite(Number(metaData.size)) ||
                         Number(metaData.size) < 0)) {
                        throw new Error("Google Drive file size is unavailable");
                    }

                    // Strict size policy: anything above 12 GiB MUST use Account 1.
                    // Check actual Google Drive metadata bytes (not rounded UI text).
                    // Account 1 must have permission to read the source AND write
                    // its own folder; fail closed if unavailable. Never fall back.
                    const rawSize = metaData?.size;
                    const measuredSize = rawSize == null ? NaN : Number(rawSize);
                    if (!directSourceMode && Number.isFinite(measuredSize) &&
                        measuredSize > 12 * 1024 ** 3 &&
                        selectedCopyAccount.account.number !== 1) {
                        selectedCopyAccount = await selectDriveCopyAccount(
                            sourceFileId, env, { requiredAccountNumber: 1 }
                        );
                        console.log("[DRIVE POOL] File over 12 GiB routed to Account 1");
                    }

                    if (
                        metaData &&
                        metaData.name
                    ) {

                        actualFileName =
                            metaData.name;

                        actualMimeType =
                            typeof metaData.mimeType === "string" &&
                            metaData.mimeType.trim()
                                ? metaData.mimeType.trim()
                                : null;


                        if (
                            metaData.size != null
                        ) {

                            const bytes =
                                Number(
                                    metaData.size
                                );


                            if (
                                bytes >
                                1024 *
                                1024 *
                                1024
                            ) {

                                exactFileSize =
                                    (
                                        bytes /
                                        (
                                            1024 *
                                            1024 *
                                            1024
                                        )
                                    ).toFixed(
                                        2
                                    ) +
                                    " GB";

                            } else {

                                exactFileSize =
                                    (
                                        bytes /
                                        (
                                            1024 *
                                            1024
                                        )
                                    ).toFixed(
                                        2
                                    ) +
                                    " MB";
                            }
                        }

                    } else {

                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "Drive file not found or private! Make sure it's accessible."
                            }),
                            {
                                status: 400,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }

                } catch (
                    e
                ) {

                    console.error(
                        "Drive Metadata Error:",
                        e
                    );

                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Could not verify Google Drive file via API."
                        }),
                        {
                            status: 400,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }


                // Atomically claim (user, original Drive file) BEFORE
                // daily quota or the external Google files.copy call.
                // Simultaneous requests cannot both acquire the claim.
                const sourceClaim = await env.DB.prepare(`
                    INSERT OR IGNORE INTO scloud_upload_sources
                        (user_id, source_hash, state)
                    VALUES (?, ?, 'processing')
                `).bind(currentUser.id, sourceUploadHash).run();

                if (Number(sourceClaim.meta?.changes || 0) !== 1) {
                    const racedReply = await existingSourceReply();
                    if (racedReply) return racedReply;
                    // A concurrent delete/retry removed the claim; never
                    // risk starting a second copy in this same request.
                    return jsonResponse({
                        status: "processing",
                        code: "UPLOAD_IN_PROGRESS",
                        message: "Upload state changed. Please retry."
                    }, 409);
                }
                sourceUploadClaimed = true;

                // --------------------------------------
                // ENFORCE DAILY UPLOAD LIMIT (WEB + API)
                // Atomically reserve one slot before copying.
                // Missing setting = 20; explicit blank/null = unlimited; 0 blocks uploads.
                // --------------------------------------
                const reserveResult = await env.DB.prepare(`
                    INSERT INTO user_daily_upload_usage (user_id, usage_date, uploads_count)
                    SELECT ?, ?, 1
                    WHERE COALESCE((SELECT COALESCE(daily_limit,-1) FROM user_upload_limits WHERE user_id = ?),20) = -1
                       OR COALESCE((SELECT COALESCE(daily_limit,-1) FROM user_upload_limits WHERE user_id = ?),20) >= 1
                    ON CONFLICT(user_id, usage_date) DO UPDATE SET uploads_count = uploads_count + 1
                    WHERE COALESCE((SELECT COALESCE(daily_limit,-1) FROM user_upload_limits WHERE user_id = ?),20) = -1
                       OR user_daily_upload_usage.uploads_count < COALESCE((SELECT COALESCE(daily_limit,-1) FROM user_upload_limits WHERE user_id = ?),20)
                `).bind(currentUser.id, uploadUsageDate, currentUser.id, currentUser.id, currentUser.id, currentUser.id).run();

                if (!reserveResult.meta?.changes) {
                    // No copy attempted: release the unique claim so a
                    // later date can retry without a stuck reservation.
                    await env.DB.prepare(`
                        DELETE FROM scloud_upload_sources
                        WHERE user_id = ? AND source_hash = ?
                          AND state = 'processing'
                          AND copied_drive_id IS NULL
                          AND file_short_id IS NULL
                    `).bind(currentUser.id, sourceUploadHash).run();
                    sourceUploadClaimed = false;
                    const [limitRow, usageRow] = await Promise.all([
                        env.DB.prepare(`SELECT NULLIF(COALESCE((SELECT COALESCE(daily_limit,-1) FROM user_upload_limits WHERE user_id=?),20),-1) AS daily_limit`).bind(currentUser.id).first(),
                        env.DB.prepare(`SELECT uploads_count FROM user_daily_upload_usage WHERE user_id = ? AND usage_date = date('now')`).bind(currentUser.id).first()
                    ]);
                    const limit = Number(limitRow?.daily_limit ?? 20);
                    const used = Number(usageRow?.uploads_count || 0);
                    return new Response(JSON.stringify({ status: "error", message: `Daily upload limit reached (${used}/${limit}). Try again after the daily reset.`, code: "DAILY_UPLOAD_LIMIT", daily_limit: limit, uploads_today: used }), { status: 429, headers: { ...corsHeaders, ...jsonHeaders() } });
                }
                uploadReservation = true;

                // --------------------------------------
                // STEP 1 - COPY TO S-CLOUD DRIVE
                //
                // IMPORTANT:
                // Original Google Drive URL is used only
                // temporarily and is NEVER saved to DB.
                // --------------------------------------

                // Direct-source mode sends the ORIGINAL Google Drive ID to
                // provider APIs. No Google files.copy and no S-Cloud Drive write.
                // Providers may still fail if the file is private/inaccessible.
                let scloudFileId = sourceFileId;
                let scloudResult = null;
                if (directSourceMode) {
                    console.log("[UPLOAD] Direct source selected; files.copy skipped");
                } else {
                console.log("[UPLOAD] S-Cloud Drive copy START | user=", currentUser.id);

                // Persist copied ID immediately after Google's files.copy
                // returns, BEFORE permission/metadata calls. If a later
                // step fails, retry must not silently copy the same source.
                scloudResult =
                    await copyFileToSCloud(
                        cleanUrl,
                        env,
                        async (copiedId, accountInfo) => {
                            // Both writes succeed or neither does: no mismatched
                            // account vs file ID in the cleanup/recovery registry.
                            const results = await env.DB.batch([
                                env.DB.prepare(`
                                    UPDATE scloud_upload_sources
                                    SET copied_drive_id = ?,
                                        updated_at = CURRENT_TIMESTAMP
                                    WHERE user_id = ? AND source_hash = ?
                                      AND state = 'processing'
                                      AND copied_drive_id IS NULL
                                `).bind(copiedId, currentUser.id, sourceUploadHash),
                                env.DB.prepare(`
                                    INSERT INTO scloud_drive_copy_registry
                                        (user_id, source_hash, copied_drive_id,
                                         account_number, folder_id)
                                    SELECT ?, ?, ?, ?, ?
                                    WHERE EXISTS (
                                        SELECT 1 FROM scloud_upload_sources
                                        WHERE user_id = ? AND source_hash = ?
                                          AND copied_drive_id = ?
                                          AND state = 'processing'
                                    )
                                `).bind(
                                    currentUser.id, sourceUploadHash, copiedId,
                                    accountInfo.accountNumber, accountInfo.folderId,
                                    currentUser.id, sourceUploadHash, copiedId
                                )
                            ]);
                            if (Number(results?.[0]?.meta?.changes || 0) !== 1 ||
                                Number(results?.[1]?.meta?.changes || 0) !== 1) {
                                throw new Error("S-Cloud copy/account tracking failed; manual review required.");
                            }
                        },
                        () => { sourceCopyStarted = true; },
                        selectedCopyAccount
                    );
                
                console.log("[UPLOAD DEBUG] S-Cloud Copy ka result:", JSON.stringify(scloudResult));

                if (
                    !scloudResult ||
                    !scloudResult.fileId
                ) {
                    throw new Error(
                        "S-Cloud Copy Failed: " + JSON.stringify(scloudResult)
                    );
                }


                scloudFileId =
                    scloudResult.fileId;


                }

                // --------------------------------------
                // CREATE S-CLOUD DRIVE URL
                // --------------------------------------

                const scloudDriveUrl =
                    `https://drive.google.com/file/d/${scloudFileId}/view`;


                // --------------------------------------
                // UPDATE FILE SIZE FROM S-CLOUD COPY
                // --------------------------------------

                if (
                    scloudResult &&
                    scloudResult.fileSize &&
                    scloudResult.fileSize !==
                        "Unknown"
                ) {

                    exactFileSize =
                        scloudResult.fileSize;
                }


                // --------------------------------------
                // CREATE SHORT ID
                // --------------------------------------

                const shortId =
                    generateFileId();


                const currentTime =
                    Date.now();

                // Store the planned S-Cloud record before inserting it.
                // Direct mode has no copied ID, so claim via source hash only;
                // legacy copy mode still matches its tracked copied ID.
                const reservationSql = directSourceMode ? `
                    UPDATE scloud_upload_sources
                    SET file_short_id = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = ? AND source_hash = ?
                      AND state = 'processing'
                      AND copied_drive_id IS NULL
                      AND file_short_id IS NULL
                ` : `
                    UPDATE scloud_upload_sources
                    SET file_short_id = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = ? AND source_hash = ?
                      AND state = 'processing'
                      AND copied_drive_id = ?
                `;
                const recordClaim = await env.DB.prepare(reservationSql)
                    .bind(...(directSourceMode
                        ? [shortId, currentUser.id, sourceUploadHash]
                        : [shortId, currentUser.id, sourceUploadHash, scloudFileId]))
                    .run();
                if (Number(recordClaim.meta?.changes || 0) !== 1) {
                    throw new Error("S-Cloud record reservation failed; manual review required.");
                }

                const short_link =
                    `${canonicalPublicOrigin}/d/${shortId}`;


                // --------------------------------------
                // INSERT FILE RECORD
                //
                // drive_url contains canonical Drive file reference:
                // direct mode => original user's file ID;
                // copy mode   => S-Cloud copied file ID.
                // We never use the source reference for automatic deletion.
                // --------------------------------------

                await env.DB.batch([
                    env.DB.prepare(
                        `INSERT INTO files
                        (
                            id,
                            short_id,
                            user_id,
                            file_name,
                            file_size,
                            mime_type,
                            drive_url,
                            last_updated,
                            status
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    )
                    .bind(
                        shortId,
                        shortId,
                        currentUser.id,
                        actualFileName,
                        exactFileSize,
                        actualMimeType,
                        scloudDriveUrl,
                        currentTime,
                        "active"
                    )
                    ,
                    ...(String(env.SCLOUD_JOBS_ENABLED || "false").toLowerCase() === "true"
                        ? newMirrorJobStatements(shortId, env)
                        : [])
                ]);

                // Upload has succeeded once its file record is committed.
                uploadReservation = false;

                try {
                    await env.DB.prepare(`
                        UPDATE scloud_upload_sources
                        SET state = 'ready', updated_at = CURRENT_TIMESTAMP
                        WHERE user_id = ? AND source_hash = ?
                          AND file_short_id = ?
                    `).bind(currentUser.id, sourceUploadHash, shortId).run();
                } catch (claimFinishError) {
                    // A later duplicate lookup will still find the saved
                    // files row via file_short_id; do not recopy the file.
                    console.error("[UPLOAD] Dedupe finalization failed:",
                        claimFinishError?.message || claimFinishError);
                }

                // --------------------------------------
                // INITIAL DOWNLOAD WORKER SYNC
                //
                // Make the new file available in DOWNLOAD_DB
                // immediately after the Main DB insert.
                // This runs in the background and does not
                // delay the successful upload response.
                // --------------------------------------
                const initialSync = (async () => {
                    try {
                        const row = await env.DB.prepare("SELECT * FROM files WHERE id = ? LIMIT 1").bind(shortId).first();
                        if (row) await syncDownloadMetadata(row, env);
                    } catch (error) {
                        console.error("[DOWNLOAD SYNC] Initial upload sync failed:", error?.name || "Error");
                    }
                })();

                // --------------------------------------
                // STAGED JOB-WORKER ROLLOUT
                // Existing uploads stay on the proven background chain until
                // SCLOUD_JOBS_ENABLED=true is set after the Cron Worker works.
                // Only one upload engine is active for each NEW file.
                // --------------------------------------
                if (String(env.SCLOUD_JOBS_ENABLED || "false").toLowerCase() !== "true") {
                ctx.waitUntil(initialSync);
                // --------------------------------------
                // BACKGROUND PROCESSING
                //
                // S-CLOUD COPY IS ALREADY COMPLETE.
                // Only Drivetot + link extraction run
                // in the background.
                // --------------------------------------

                ctx.waitUntil(
                    (async () => {

                        try {

                            // =================================
                            // STEP 2 - PDLINK FIRST
                            // =================================
                            //
                            // PDLink upload starts first.
                            // Share ID is saved immediately.
                            // Drivetot runs independently even if PDLink is skipped/failed.
                            // =================================

                            // Use one PDLink job when EITHER GoFile or Pixeldrain is ON.
                            // If BOTH are OFF, never send the file to PDLink.
                            const pdlinkPolicy = await getMirrorUploadPolicy(currentUser.id, env);
                            if (pdlinkPolicy.pdlink) {
                                try {
                                    console.log(
                                        `[PDLINK] Upload START | file=${shortId} | drive=${scloudFileId}`
                                    );

                                    const pdlinkResult =
                                        await queuePDLinkFile(
                                            scloudFileId,
                                            env
                                        );

                                    if (
                                        !pdlinkResult ||
                                        !pdlinkResult.share_id
                                    ) {
                                        throw new Error(
                                            "PDLink Upload Failed: share_id missing."
                                        );
                                    }

                                    // =================================
                                    // SAVE PDLINK SHARE ID IMMEDIATELY
                                    // =================================

                                    await env.DB
                                        .prepare(
                                            `UPDATE files
                                             SET pdlink_share_id = ?
                                             WHERE id = ?`
                                        )
                                        .bind(
                                            pdlinkResult.share_id,
                                            shortId
                                        )
                                        .run();
                                            {
                                                const downloadSyncRecord =
                                                    await env.DB
                                                        .prepare(
                                                            "SELECT * FROM files WHERE (id = ? OR short_id = ?) LIMIT 1"
                                                        )
                                                        .bind(
                                                            shortId,
                                                            shortId
                                                        )
                                                        .first();
    
                                                if (downloadSyncRecord) {
                                                    await syncDownloadMetadata(
                                                        downloadSyncRecord,
                                                        env
                                                    );
                                                }
                                            }

                                    console.log(
                                        `[PDLINK] Share ID saved | file=${shortId} | share=${pdlinkResult.share_id}`
                                    );
                                } catch (pdlinkError) {
                                    // Drivetot/TOXCloud still run if PDLink fails.
                                    console.error(`[PDLINK] Upload FAILED | file=${shortId}:`,
                                        pdlinkError?.message || 'unknown');
                                }
                            } else {
                                console.log(`[PDLINK] SKIPPED | file=${shortId} | gofile_and_pixeldrain_off`);
                            }

                            // =================================
                            // STEP 3 - TOXCLOUD
                            // =================================
                            //
                            // PDLink share ID is already safely saved.
                            // Now send the S-Cloud Drive file to
                            // TOXcloud and save its download URL.
                            //
                            // If TOXcloud is pending or fails, the
                            // existing Drivetot flow continues normally.
                            // =================================

                            const toxcloudPolicy = await getMirrorUploadPolicy(currentUser.id, env);
                            if (toxcloudPolicy.toxcloud) {
                                console.log(
                                    `[TOXCLOUD] Upload START | file=${shortId} | drive=${scloudFileId}`
                                );

                                try {
                                    const toxcloudResult =
                                        await uploadToToxCloud(
                                            scloudFileId,
                                            env
                                        );

                                    if (
                                        toxcloudResult &&
                                        toxcloudResult.ready &&
                                        toxcloudResult.download_url
                                    ) {
                                        await env.DB
                                            .prepare(
                                                `UPDATE files
                                                 SET toxcloud_url = ?
                                                 WHERE id = ?`
                                            )
                                            .bind(
                                                toxcloudResult.download_url,
                                                shortId
                                            )
                                            .run();
                                        {
                                            const downloadSyncRecord =
                                                await env.DB
                                                    .prepare(
                                                        "SELECT * FROM files WHERE (id = ? OR short_id = ?) LIMIT 1"
                                                    )
                                                    .bind(
                                                        shortId,
                                                        shortId
                                                    )
                                                    .first();
    
                                            if (downloadSyncRecord) {
                                                await syncDownloadMetadata(
                                                    downloadSyncRecord,
                                                    env
                                                );
                                            }
                                        }

                                        console.log(
                                            `[TOXCLOUD] Download URL saved | file=${shortId}`
                                        );
                                    } else {
                                        console.log(
                                            `[TOXCLOUD] Download URL not ready | file=${shortId} | status=${toxcloudResult?.status || "unknown"}`
                                        );
                                    }

                                } catch (toxcloudError) {
                                    console.error(
                                        `[TOXCLOUD] Upload FAILED | file=${shortId}:`,
                                        toxcloudError.message
                                    );
                                }
                            } else {
                                console.log(`[TOXCLOUD] SKIPPED | file=${shortId} | user_off`);
                            }

                            // =================================
                            // STEP 4 - DRIVETOT
                            // =================================

                            console.log(
                                `[DRIVETOT] Upload START | file=${shortId}`
                            );

                            const drivetotResult =
                                await uploadToDrivetot(
                                    scloudFileId,
                                    env
                                );

                            if (
                                !drivetotResult ||
                                !drivetotResult.share_id
                            ) {
                                throw new Error(
                                    "Drivetot Upload Failed"
                                );
                            }


                            const drivetot_url =
                                `https://drivetot.website/${drivetotResult.share_id}`;


                            await env.DB
                                .prepare(
                                    `UPDATE files
                                     SET drivetot_url = ?
                                     WHERE id = ?`
                                )
                                .bind(
                                    drivetot_url,
                                    shortId
                                )
                                .run();


                            // =================================
                            // STEP 3 - EXTRACT LINKS
                            // =================================

                            const extractedLinks =
                                await extractLinksFromDrivetot(
                                    drivetotResult.share_id,
                                    env
                                );


                            if (
                                extractedLinks.error
                            ) {
                                throw new Error(
                                    "Drivetot Scraper Failed: " +
                                    extractedLinks.error
                                );
                            }


                            const hubcloud_url =
                                extractedLinks.hubcloud_url ||
                                "Not Found";


                            const gdflix_url =
                                extractedLinks.gdflix_url;


                            await env.DB
                                .prepare(
                                    `UPDATE files
                                     SET hubcloud_url = ?,
                                         gdflix_url = ?
                                     WHERE id = ?`
                                )
                                .bind(
                                    hubcloud_url,
                                    gdflix_url,
                                    shortId
                                )
                                .run();
                                {
                                    const downloadSyncRecord =
                                        await env.DB
                                            .prepare(
                                                "SELECT * FROM files WHERE (id = ? OR short_id = ?) LIMIT 1"
                                            )
                                            .bind(
                                                shortId,
                                                shortId
                                            )
                                            .first();
    
                                    if (downloadSyncRecord) {
                                        await syncDownloadMetadata(
                                            downloadSyncRecord,
                                            env
                                        );
                                    }
                                }


                            console.log(
                                `Background processing completed: ${shortId}`
                            );

                        } catch (
                            bgErr
                        ) {

                            console.error(
                                "Background processing error for " +
                                shortId +
                                ":",
                                bgErr.message
                            );
                        }

                    })()
                );


                } else {
                    // Start the three durable jobs right now, not at the next Cron tick.
                    // Cron/self-healing still share the same atomic D1 claim.
                    // Serialize only metadata sync, not the provider submissions.
                    // Each response is written to D1 by the atomic job executor.
                    let syncChain = initialSync;
                    const syncLatest = () => {
                        syncChain = syncChain.then(async () => {
                            const fresh = await env.DB.prepare("SELECT * FROM files WHERE short_id = ? LIMIT 1").bind(shortId).first();
                            if (fresh) await syncDownloadMetadata(fresh, env);
                        }).catch(error => console.error("[SCLOUD FAST SUBMIT] sync error", error?.name || "Error"));
                        return syncChain;
                    };
                    const dispatchStartedAt = Date.now();
                    const fastStart = Promise.allSettled(["pdlink", "toxcloud", "drivetot"].map(async provider => {
                        const result = await executeScloudMirrorJob(shortId, provider, env, getMirrorUploadPolicy, syncLatest, {fastStart:true});
                        // A quick read-only extraction attempt if Drivetot is ready
                        // early; no extra upload. Slow responses remain with Cron.
                        if (provider === "drivetot" && result.state === "done" && Date.now()-dispatchStartedAt < 8000) {
                            await executeScloudMirrorJob(shortId, "extract", env, getMirrorUploadPolicy, syncLatest, {fastStart:true});
                        }
                        return result;
                    }));
                    ctx.waitUntil((async () => {
                        const results = await fastStart;
                        await syncChain;
                        console.log("[SCLOUD FAST SUBMIT] complete", {fileId:shortId, states:results.map(r=>r.status === "fulfilled" ? r.value?.state : "error")});
                    })().catch(error => console.error("[SCLOUD FAST SUBMIT] background error", error?.name || "Error")));
                    console.log("[SCLOUD UPLOAD TIMING] registered", {fileId:shortId, elapsed_ms:Date.now()-uploadStartedAt});
                }

                // --------------------------------------
                // RESPONSE
                // --------------------------------------

                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message: directSourceMode
                            ? "File registered; background mirror submissions started."
                            : "File Uploaded Successfully!",
                        data: {
                            file_name:
                                actualFileName,
                            file_size:
                                exactFileSize,
                            short_id:
                                shortId,
                            short_link:
                                short_link
                        }
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (
                error
            ) {

                if (uploadReservation) {
                    try {
                        await env.DB.prepare(`UPDATE user_daily_upload_usage SET uploads_count = CASE WHEN uploads_count > 0 THEN uploads_count - 1 ELSE 0 END WHERE user_id = ? AND usage_date = ?`).bind(currentUser.id, uploadUsageDate).run();
                    } catch (releaseError) {
                        console.error("Could not release failed upload reservation:", releaseError);
                    }
                }

                if (sourceUploadClaimed && !sourceCopyStarted) {
                    // Only release if files.copy was definitely NOT called.
                    // Once called, an unknown Google response must NEVER
                    // trigger an automatic duplicate copy on retry.
                    try {
                        await env.DB.prepare(`
                            DELETE FROM scloud_upload_sources
                            WHERE user_id = ? AND source_hash = ?
                              AND state = 'processing'
                              AND copied_drive_id IS NULL
                              AND (file_short_id IS NULL OR (? = 1 AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id=scloud_upload_sources.file_short_id OR f.short_id=scloud_upload_sources.file_short_id)))
                        `).bind(currentUser.id, sourceUploadHash,directSourceMode?1:0).run();
                    } catch (dedupeReleaseError) {
                        console.error("[UPLOAD] Could not release pre-copy claim:",
                            dedupeReleaseError?.message || dedupeReleaseError);
                    }
                }

                // ==============================
                // ADVANCED ERROR LOGGING ADDED
                // ==============================
                console.error("[UPLOAD ERROR MESSAGE]:", error.message);
                console.error("[UPLOAD ERROR STACK]:", error.stack);

                return new Response(
                    JSON.stringify({
                        status:
                            "error",
                        message:
                            "Upload could not be completed. Please try again or contact support."
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // 9. PUBLIC DOWNLOAD ROUTE
        // ==================================================

        // ==================================================
        // 9. PUBLIC DOWNLOAD ROUTE
        // ==================================================

        if (
            url.pathname.startsWith(
                "/file/"
            )
        ) {

            const shortId =
                url.pathname
                    .split(
                        "/"
                    )[2];

            if (!shortId) {
                return new Response(
                    "Invalid Link",
                    {
                        status: 400,
                        headers:
                            corsHeaders
                    }
                );
            }

            try {

                const record =
                    await env.DB
                        .prepare(
                            `SELECT
                                 files.*,
                                 users.shared_by,
                                 users.shared_by_enabled,
                                 users.shared_by_url
                             FROM files
                             LEFT JOIN users
                                 ON users.id = files.user_id
                             WHERE files.short_id = ?
                                OR files.id = ?
                             LIMIT 1`
                        )
                        .bind(
                            shortId,
                            shortId
                        )
                        .first();

                if (!record) {
                    return new Response(
                        "File Not Found in DB",
                        {
                            status: 404,
                            headers:
                                corsHeaders
                        }
                    );
                }

                if (
                    record.status ===
                    "deleted"
                ) {
                    return new Response(
                        "This file has been removed.",
                        {
                            status: 403,
                            headers:
                                corsHeaders
                        }
                    );
                }

                if (Number(record.sharing_enabled ?? 1) === 0) {
                    return new Response("Sharing is turned off for this file.", {
                        status: 403,
                        headers: corsHeaders
                    });
                }

                const {visibility: accountVisibility} = await getAccountMirrorVisibility(record.user_id,env);
                const currentTime =
                    Date.now();

                let instantReady = false;
                let cachedLinks = null;

                if (
                    hasValidFastLinks(
                        record,
                        currentTime
                    )
                ) {
                    instantReady = true;

                    try {
                        cachedLinks =
                            JSON.parse(
                                record.fast_links
                            );
                    } catch (error) {
                        instantReady = false;
                        cachedLinks = null;
                    }
                }

                // Start preparation in background.
                // Page request does NOT wait for GDFlix.
                ctx.waitUntil(
                    prepareFastLinks(
                        shortId,
                        env
                    )
                );

                // ==================================================
                // PDLINK SELF-HEALING
                //
                // If pdlink_share_id is missing, use the
                // S-CLOUD copied Drive URL stored in drive_url.
                //
                // This runs completely in the background.
                // The /file request does NOT wait for PDLink.
                // ==================================================

                if (
                    !record.pdlink_share_id &&
                    record.drive_url &&
                    !(await hasCronMirrorJobs(String(record.short_id || shortId), env)) &&
                    !pdlinkJobs.has(shortId) &&
                    (await getMirrorUploadPolicy(record.user_id, env)).pdlink
                ) {

                    const driveMatch =
                        record.drive_url.match(
                            /\/file\/d\/([a-zA-Z0-9_-]+)/
                        );

                    const driveFileId =
                        driveMatch?.[1] ||
                        null;

                    if (driveFileId) {

                        const pdlinkJob =
                            (async () => {

                                try {

                                    console.log(
                                        `[PDLINK] Self-healing START | file=${shortId} | drive=${driveFileId}`
                                    );

                                    if (!(await getMirrorUploadPolicy(record.user_id, env)).pdlink) {
                                        console.log(`[PDLINK] Self-healing CANCELLED | file=${shortId} | both_off`);
                                        return;
                                    }

                                    const pdlinkResult =
                                        await queuePDLinkFile(
                                            driveFileId,
                                            env
                                        );

                                    if (
                                        !pdlinkResult ||
                                        !pdlinkResult.share_id
                                    ) {
                                        throw new Error(
                                            "PDLink returned no share_id."
                                        );
                                    }

                                    await env.DB
                                        .prepare(
                                            `UPDATE files
                                             SET pdlink_share_id = ?
                                             WHERE id = ?
                                               AND (
                                                   pdlink_share_id IS NULL
                                                   OR pdlink_share_id = ''
                                               )`
                                        )
                                        .bind(
                                            pdlinkResult.share_id,
                                            record.id
                                        )
                                        .run();

                                    console.log(
                                        `[PDLINK] Self-healing SUCCESS | file=${shortId} | share=${pdlinkResult.share_id}`
                                    );

                                } catch (
                                    pdlinkError
                                ) {

                                    console.error(
                                        `[PDLINK] Self-healing FAILED | file=${shortId}:`,
                                        pdlinkError.message
                                    );

                                } finally {

                                    pdlinkJobs.delete(
                                        shortId
                                    );

                                }

                            })();

                        pdlinkJobs.set(
                            shortId,
                            pdlinkJob
                        );

                        ctx.waitUntil(
                            pdlinkJob
                        );

                    }
                }

                        // ==================================================
                        // TOXCLOUD SELF-HEALING
                        //
                        // If toxcloud_url is missing, use the
                        // S-CLOUD copied Drive URL stored in drive_url.
                        //
                        // This runs completely in the background.
                        // The /file request does NOT wait for TOXcloud.
                        // ==================================================

                        if (
                            !record.toxcloud_url &&
                            record.drive_url &&
                            !(await hasCronMirrorJobs(String(record.short_id || shortId), env)) &&
                            !toxcloudJobs.has(shortId) &&
                            (await getMirrorUploadPolicy(record.user_id, env)).toxcloud
                        ) {

                            const toxDriveMatch =
                                record.drive_url.match(
                                    /\/file\/d\/([a-zA-Z0-9_-]+)/
                                );

                            const toxDriveFileId =
                                toxDriveMatch?.[1] ||
                                null;

                            if (toxDriveFileId) {

                                const toxcloudJob =
                                    (async () => {

                                        try {

                                            console.log(
                                                `[TOXCLOUD] Self-healing START | file=${shortId} | drive=${toxDriveFileId}`
                                            );

                                            if (!(await getMirrorUploadPolicy(record.user_id, env)).toxcloud) {
                                                console.log(`[TOXCLOUD] Self-healing CANCELLED | file=${shortId} | user_off`);
                                                return;
                                            }

                                            const toxcloudResult =
                                                await uploadToToxCloud(
                                                    toxDriveFileId,
                                                    env
                                                );

                                            if (
                                                toxcloudResult &&
                                                toxcloudResult.ready &&
                                                toxcloudResult.download_url
                                            ) {

                                                await env.DB
                                                    .prepare(
                                                        `UPDATE files
                                                         SET toxcloud_url = ?
                                                         WHERE id = ?
                                                           AND (
                                                               toxcloud_url IS NULL
                                                               OR toxcloud_url = ''
                                                           )`
                                                    )
                                                    .bind(
                                                        toxcloudResult.download_url,
                                                        record.id
                                                    )
                                                    .run();

                                                console.log(
                                                    `[TOXCLOUD] Self-healing SUCCESS | file=${shortId}`
                                                );

                                            } else {

                                                console.log(
                                                    `[TOXCLOUD] Self-healing PENDING | file=${shortId} | status=${toxcloudResult?.status || "unknown"}`
                                                );

                                            }

                                        } catch (
                                            toxcloudError
                                        ) {

                                            console.error(
                                                `[TOXCLOUD] Self-healing FAILED | file=${shortId}:`,
                                                toxcloudError.message
                                            );

                                        } finally {

                                            toxcloudJobs.delete(
                                                shortId
                                            );

                                        }

                                    })();

                                toxcloudJobs.set(
                                    shortId,
                                    toxcloudJob
                                );

                                ctx.waitUntil(
                                    toxcloudJob
                                );
                            }
                        }



                const fileResponseHeaders = new Headers({
                    "Content-Type": "application/json",
                    ...corsHeaders
                });
                return new Response(
                    JSON.stringify({
                        status: "success",

                        file: {
                            name:
                                record.file_name,

                            size:
                                record.file_size,

                            type:
                                record.mime_type ||
                                record.file_type ||
                                "application/octet-stream",

                            shared:
                                record.created_at ||
                                record.last_updated ||
                                null,

                            sharedBy:


                                Number(


                                    record.shared_by_enabled


                                ) === 1 &&


                                typeof record.shared_by === "string" &&


                                record.shared_by.trim()


                                    ? record.shared_by.trim()


                                    : null,

                            sharedByUrl:
                                Number(record.shared_by_enabled) === 1 &&
                                typeof record.shared_by === "string" &&
                                record.shared_by.trim() &&
                                typeof record.shared_by_url === "string" &&
                                /^https?:\/\//i.test(record.shared_by_url.trim())
                                    ? record.shared_by_url.trim()
                                    : null
                        },

                        mirrors: {
                            hubcloud:
                                !!record.hubcloud_url,

                            gdflix:
                                !!record.gdflix_url,

                            gofile:
                                accountVisibility.gofile && !!record.pdlink_share_id,

                            toxcloud:
                                !!record.toxcloud_url,

                            pixeldrain:
                                accountVisibility.pixeldrain && !!record.pdlink_share_id
                        },

                        instant: {
                            ready:
                                instantReady,

                            links:
                                cachedLinks
                        }
                    }),
                    {
                        status: 200,
                        headers: fileResponseHeaders
                    }
                );

            } catch (err) {

                console.error(
                    "Download Route Error:",
                    err
                );

                return new Response(
                    "DB Error: " +
                    err.message,
                    {
                        status: 500,
                        headers:
                            corsHeaders
                    }
                );
            }
        }



        // ==================================================
        // PUBLIC DOWNLOAD PAGE
        // ==================================================

        if (url.pathname.startsWith("/d/") && request.method === "GET") {
  let fileId = "";
  try {
    fileId = decodeURIComponent(url.pathname.slice("/d/".length).split("/")[0]);
  } catch {
    return new Response("Invalid link", { status: 400 });
  }

  if (!fileId || !/^[A-Za-z0-9_-]{1,100}$/.test(fileId)) {
    return new Response("Invalid link", { status: 400 });
  }

  const row = await env.DB
    .prepare(`SELECT * FROM files WHERE short_id = ? LIMIT 1`)
    .bind(fileId)
    .first();

  if (
    !row ||
    row.status !== "active" ||
    Number(row.sharing_enabled ?? 1) === 0
  ) {
    return new Response(
      "File not found, deleted, or private.",
      {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store"
        }
      }
    );
  }

  // ==================================================
  // DOWNLOAD ENTRY SELF-HEALING
  //
  // Restore the old /file behavior for the real public /d
  // entry point. Missing Drivetot / HubCloud / GDFlix metadata
  // can continue preparing in the background without delaying
  // the signed redirect to the Download Worker.
  // ==================================================
  // Dispatch after the initial Download Worker sync below.

  // ==================================================
  // UNIQUE VIEW AT THE REAL PUBLIC ENTRY POINT
  //
  // One publisher can receive at most one eligible view
  // from the same IP/browser identity during 24 hours.
  // ==================================================

  const viewerIp =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Real-IP") ||
    (request.headers.get("X-Forwarded-For") || "")
      .split(",")[0]
      .trim() ||
    "unknown";

  const viewerIpHash =
    await sha256Hex(viewerIp);

  let viewerBrowserId =
    readCookie(request, "scloud_vid");

  let shouldSetVisitorCookie = false;

  if (
    !viewerBrowserId ||
    !/^[a-f0-9]{48}$/.test(viewerBrowserId)
  ) {
    viewerBrowserId =
      createVisitorId();

    shouldSetVisitorCookie = true;
  }

  const viewerBrowserHash =
    await sha256Hex(viewerBrowserId);

  const viewerUserAgent =
    request.headers.get("User-Agent") ||
    null;

  try {
    const viewGuard =
      await env.DB
        .prepare(
          `INSERT INTO visitor_activity
           (user_id, activity_type, ip_hash, browser_hash, occurred_at)

           SELECT ?, 'view', ?, ?, CURRENT_TIMESTAMP

           WHERE NOT EXISTS (
             SELECT 1
             FROM visitor_activity va
             WHERE va.user_id = ?
               AND va.activity_type = 'view'
               AND va.occurred_at >= datetime('now', '-24 hours')
               AND (
                 va.ip_hash = ?
                 OR (
                   ? IS NOT NULL
                   AND va.browser_hash = ?
                 )
               )
           )

           AND NOT EXISTS (
             SELECT 1
             FROM views_log vl
             INNER JOIN files f
               ON f.id = vl.file_id
             WHERE f.user_id = ?
               AND vl.viewed_at >= datetime('now', '-24 hours')
               AND vl.ip_address = ?
           )`
        )
        .bind(
          row.user_id,
          viewerIpHash,
          viewerBrowserHash,

          row.user_id,
          viewerIpHash,
          viewerBrowserHash,
          viewerBrowserHash,

          row.user_id,
          viewerIp
        )
        .run();

    const uniqueView =
      Number(
        viewGuard?.meta?.changes || 0
      ) > 0;

    if (uniqueView) {
      await env.DB.batch([
        env.DB
          .prepare(
            `UPDATE files
             SET views = COALESCE(views, 0) + 1
             WHERE id = ?`
          )
          .bind(row.id),

        env.DB
          .prepare(
            `INSERT INTO views_log
             (file_id, ip_address, user_agent)
             VALUES (?, ?, ?)`
          )
          .bind(
            row.id,
            viewerIp,
            viewerUserAgent
          )
      ]);

      console.log(
        `[VIEWS] Unique /d view logged | file=${fileId} | user=${row.user_id}`
      );
    } else {
      console.log(
        `[VIEWS] Duplicate /d view blocked | file=${fileId} | user=${row.user_id}`
      );
    }

  } catch (viewLogError) {
    // View analytics must never break a valid download.
    console.error(
      `[VIEWS] /d guard/log failed | file=${fileId}:`,
      viewLogError?.message ||
      viewLogError
    );
  }


  // Select one replica at random. Only that replica is synced on the
  // critical path; the other is tried only if synchronization fails.
  const candidates = getDownloadTargets(env);
  if (candidates.length === 2 && crypto.getRandomValues(new Uint8Array(1))[0] < 128) candidates.reverse();
  let selected = null;
  for (const target of candidates) {
    if (await syncDownloadMetadata(row, env, [target])) { selected = target; break; }
  }
  if (!selected) {
    return new Response("Download service temporarily unavailable. Please try again.", {
      status: 503, headers: {"Cache-Control":"no-store", "Retry-After":"5"}
    });
  }
  // Check source again before issuing a signed credential.
  const current = await env.DB.prepare("SELECT status, sharing_enabled FROM files WHERE short_id = ? LIMIT 1").bind(fileId).first();
  if (!current || current.status !== "active" || Number(current.sharing_enabled ?? 1) === 0) {
    return new Response("File not found, deleted, or private.", {status:404,headers:{"Cache-Control":"no-store"}});
  }
  ctx.waitUntil(prepareFastLinks(fileId, env));
  const expires = Math.floor(Date.now() / 1000) + 600;
  const accessBytes = crypto.getRandomValues(new Uint8Array(24));
  const accessNonce = Array.from(accessBytes).map(b => b.toString(16).padStart(2,"0")).join("");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(selected.signSecret),
    {name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signatureBuffer = await crypto.subtle.sign("HMAC",key,encoder.encode(`${fileId}:${expires}:${accessNonce}`));
  const signatureHex = Array.from(new Uint8Array(signatureBuffer)).map(b=>b.toString(16).padStart(2,"0")).join("");
  const downloadWorkerBase = selected.base;
  console.log("[DOWNLOAD ROUTE]", {worker:selected.id,fileId});

  const downloadWorkerUrl =
    `${downloadWorkerBase}/d/${encodeURIComponent(fileId)}` +
    `?expires=${expires}` +
    `&access=${encodeURIComponent(accessNonce)}` +
    `&token=${signatureHex}`;
  const redirectHeaders = new Headers({
    "Location": downloadWorkerUrl,
    "Cache-Control": "no-store"
  });

  if (shouldSetVisitorCookie) {
    redirectHeaders.append(
      "Set-Cookie",
      `scloud_vid=${viewerBrowserId}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`
    );
  }

  return new Response(null, {
    status: 302,
    headers: redirectHeaders
  });
}


        // ==================================================
        // DOWNLOAD STATUS
        // ==================================================

        if (
            url.pathname.startsWith(
                "/api/download-status/"
            ) &&
            request.method === "GET"
        ) {
            const shortId =
                url.pathname
                    .split("/")
                    .filter(Boolean)[2];

            if (!shortId) {
                return new Response(
                    JSON.stringify({
                        status: "error",
                        message: "Invalid file ID."
                    }),
                    {
                        status: 400,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }

            try {
                const record =
                    await env.DB
                        .prepare(
                            `SELECT *
                             FROM files
                             WHERE short_id = ?
                                OR id = ?
                             LIMIT 1`
                        )
                        .bind(
                            shortId,
                            shortId
                        )
                        .first();

                if (!record) {
                    return new Response(
                        JSON.stringify({
                            status: "error",
                            message: "File not found."
                        }),
                        {
                            status: 404,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                if (
                    record.status ===
                    "deleted"
                ) {
                    return new Response(
                        JSON.stringify({
                            status: "error",
                            message:
                                "This file has been removed."
                        }),
                        {
                            status: 403,
                            headers: {
                                ...corsHeaders,
                                ...jsonHeaders()
                            }
                        }
                    );
                }

                if (Number(record.sharing_enabled ?? 1) === 0) {
                    return new Response(JSON.stringify({
                        status: "error",
                        message: "Sharing is turned off for this file."
                    }), {
                        status: 403,
                        headers: { ...corsHeaders, ...jsonHeaders() }
                    });
                }

                const {visibility: accountVisibility} = await getAccountMirrorVisibility(record.user_id,env);
                const currentTime =
                    Date.now();

                let ready = false;
                let links = null;

                if (
                    hasValidFastLinks(
                        record,
                        currentTime
                    )
                ) {
                    try {
                        links = JSON.parse(
                            record.fast_links
                        );

                        ready = true;
                    } catch (error) {
                        ready = false;
                        links = null;
                    }
                }

                return new Response(
                    JSON.stringify({
                        status: "success",
                        ready,
                        links,
                        mirrors: {
                            hubcloud:
                                !!record.hubcloud_url &&
                                record.hubcloud_url !==
                                    "Not Found",

                            gdflix:
                                !!record.gdflix_url &&
                                record.gdflix_url !==
                                    "Not Found",

                            gofile:
                                accountVisibility.gofile && !!record.pdlink_share_id,

                            toxcloud:
                                !!record.toxcloud_url,

                            pixeldrain:
                                accountVisibility.pixeldrain && !!record.pdlink_share_id
                        }
                    }),
                    {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );

            } catch (error) {
                console.error(
                    "Download Status Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status: "error",
                        message: error.message
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // TRACKED DOWNLOAD / MIRROR REDIRECTS
        // ==================================================

        if (
            url.pathname.startsWith("/go/") &&
            request.method === "GET"
        ) {
            const parts =
                url.pathname
                    .split("/")
                    .filter(Boolean);

            const action =
                parts[1] || "";

            const shortId =
                parts[2] || "";

            if (
                !shortId ||
                ![
                    "instant",
                    "hubcloud",
                    "gdflix",
                    "gofile",
                    "toxcloud",
                    "pixeldrain"
                ].includes(action)
            ) {
                return new Response(
                    "Invalid download request.",
                    {
                        status: 400,
                        headers: corsHeaders
                    }
                );
            }

            try {
                const record =
                    await env.DB
                        .prepare(
                            `SELECT *
                             FROM files
                             WHERE short_id = ?
                                OR id = ?
                             LIMIT 1`
                        )
                        .bind(
                            shortId,
                            shortId
                        )
                        .first();

                if (!record) {
                    return new Response(
                        "File not found.",
                        {
                            status: 404,
                            headers: corsHeaders
                        }
                    );
                }

                if (
                    record.status ===
                    "deleted"
                ) {
                    return new Response(
                        "This file has been removed.",
                        {
                            status: 403,
                            headers: corsHeaders
                        }
                    );
                }

                if (Number(record.sharing_enabled ?? 1) === 0) {
                    return new Response("Sharing is turned off for this file.", {
                        status: 403,
                        headers: corsHeaders
                    });
                }

                // ------------------------------------------
                // PDLINK: GOFILE + PIXELDRAIN
                // ------------------------------------------
                if (controlledDownloadProvider(action)) {
                    const {locked} = await getAccountMirrorVisibility(record.user_id,env);
                    if (locked[action]) return new Response("This download server is disabled for this account.", {
                        status:403,headers:{...corsHeaders,"Cache-Control":"no-store"}
                    });
                }


                if (
                    action ===
                        "gofile" ||
                    action ===
                        "pixeldrain"
                ) {

                    // ------------------------------------------
                    // SHARE ID REQUIRED
                    // ------------------------------------------

                    if (
                        !record.pdlink_share_id
                    ) {
                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    `${action === "gofile" ? "Gofile" : "Pixeldrain"} link is not available yet.`
                            }),
                            {
                                status: 404,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }

                    try {

                        console.log(
                            `[PDLINK] Generating ${action} link | file=${shortId} | share=${record.pdlink_share_id}`
                        );

                        const target =
                            await getPDLinkMirrorLinks(
                                record.pdlink_share_id,
                                env,
                                action
                            );

                        // ------------------------------------------
                        // REQUESTED MIRROR NOT READY
                        // ------------------------------------------

                        if (!target) {
                            return new Response(
                                JSON.stringify({
                                    status:
                                        "error",
                                    message:
                                        `${action === "gofile" ? "Gofile" : "Pixeldrain"} link is not available yet.`
                                }),
                                {
                                    status: 404,
                                    headers: {
                                        ...corsHeaders,
                                        ...jsonHeaders()
                                    }
                                }
                            );
                        }

                        console.log(
                            `[PDLINK] ${action} redirect SUCCESS | file=${shortId}`
                        );

                        await creditDownloadEarning(
                            record,
                            request,
                            env
                        );

                        return Response.redirect(
                            target,
                            302
                        );

                    } catch (error) {

                        console.error(
                            `[PDLINK] ${action} route ERROR | file=${shortId}:`,
                            error.message
                        );

                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    `${action === "gofile" ? "Gofile" : "Pixeldrain"} link generation failed.`
                            }),
                            {
                                status: 500,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }
                }


                // ------------------------------------------
                // TOXCLOUD
                // ------------------------------------------

                if (
                    action ===
                    "toxcloud"
                ) {

                    if (
                        !record.toxcloud_url
                    ) {
                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "TOXcloud link is not available yet."
                            }),
                            {
                                status: 404,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }

                    try {

                        console.log(
                            `[TOXCLOUD] Redirect START | file=${shortId}`
                        );

                        console.log(
                            `[TOXCLOUD] Redirect SUCCESS | file=${shortId}`
                        );

                        await creditDownloadEarning(
                            record,
                            request,
                            env
                        );

                        return Response.redirect(
                            record.toxcloud_url,
                            302
                        );

                    } catch (error) {

                        console.error(
                            `[TOXCLOUD] Route ERROR | file=${shortId}:`,
                            error.message
                        );

                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "TOXcloud redirect failed."
                            }),
                            {
                                status: 500,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }
                }



                // ------------------------------------------
                // INSTANT DOWNLOAD - HUBCLOUD AUTO
                // ------------------------------------------

                if (action === "instant") {

                    const source =
                        String(record.hubcloud_url || "").trim();

                    if (!source || source === "Not Found") {
                        return jsonResponse({
                            status: "error",
                            message: "HubCloud mirror unavailable."
                        }, 404);
                    }

                    try {
                        const hub = new URL(source);

                        const allowedHosts = new Set([
                            "hubcloud.pw",
                            "hubcloud.mov",
                            "hubcloud.cx",
                            "hubcloud.ist",
                            "hubcloud.one"
                        ]);

                        if (
                            hub.protocol !== "https:" ||
                            !allowedHosts.has(hub.hostname) ||
                            hub.username ||
                            hub.password ||
                            hub.port ||
                            !/^\/video\/[A-Za-z0-9_-]+\/?$/.test(hub.pathname)
                        ) {
                            throw new Error("Unsupported HubCloud URL");
                        }

                        const api = new URL(
                            "https://opx.toxcloud.shop/hub/auto"
                        );

                        // Normalize old domain for the resolver only.
                        // Do not change the database or mirror URL.
                        if (hub.hostname === "hubcloud.one") {
                            hub.hostname = "hubcloud.mov";
                        }

                        api.searchParams.set("url", hub.href);

                        const controller = new AbortController();

                        const timeout = setTimeout(
                            () => controller.abort(),
                            30000
                        );

                        let response;

                        try {
                            response = await fetch(
                                api.href,
                                {
                                    method: "GET",
                                    headers: {
                                        "Accept": "application/json",
                                        "User-Agent": "Mozilla/5.0"
                                    },
                                    redirect: "follow",
                                    signal: controller.signal
                                }
                            );
                        } finally {
                            clearTimeout(timeout);
                        }

                        if (!response.ok) {
                            throw new Error(
                                `Hub Auto HTTP ${response.status}`
                            );
                        }

                        const length = Number(
                            response.headers.get("content-length") || 0
                        );

                        if (length > 131072) {
                            throw new Error("Response too large");
                        }

                        const responseText = await response.text();

                        if (responseText.length > 131072) {
                            throw new Error("Response too large");
                        }

                        const result = JSON.parse(responseText);

                        if (
                            result?.success !== true ||
                            typeof result.download_url !== "string" ||
                            !/10\s*gbps/i.test(
                                String(result.selected_server || "")
                            )
                        ) {
                            throw new Error(
                                "10Gbps direct URL unavailable"
                            );
                        }

                        const direct = new URL(result.download_url);

                        if (
                            direct.protocol !== "https:" ||
                            direct.hostname !==
                                "video-downloads.googleusercontent.com" ||
                            direct.username ||
                            direct.password ||
                            direct.port
                        ) {
                            throw new Error("Invalid direct URL host");
                        }

                        const instantUrl = direct.href;

                        console.log(
                            `[INSTANT AUTO] Resolved | file=${shortId}`
                        );

                        // Existing earning system remains on Main Worker.
                        // Its rolling 24-hour guard is unchanged.
                        await creditDownloadEarning(
                            record,
                            request,
                            env
                        );

                        if (
                            url.searchParams.get("mode") === "json"
                        ) {
                            return jsonResponse({
                                status: "success",
                                url: instantUrl
                            });
                        }

                        // Redirect only; never proxy file bytes.
                        return new Response(null, {
                            status: 302,
                            headers: {
                                "Location": instantUrl,
                                "Cache-Control": "no-store",
                                "Referrer-Policy": "no-referrer"
                            }
                        });

                    } catch (error) {
                        console.error(
                            `[INSTANT AUTO] Failed | file=${shortId}`,
                            error?.message || "Unknown error"
                        );

                        const reason =
                            String(error?.message || "");

                        let errorCode = "UNKNOWN_ERROR";

                        const httpMatch = reason.match(
                            /^Hub Auto HTTP ([0-9]{3})$/
                        );

                        if (httpMatch) {
                            errorCode = "API_HTTP_" + httpMatch[1];
                        } else if (error?.name === "AbortError") {
                            errorCode = "API_TIMEOUT";
                        } else if (reason === "Unsupported HubCloud URL") {
                            errorCode = "INVALID_HUBCLOUD_URL";
                        } else if (reason === "Response too large") {
                            errorCode = "API_RESPONSE_TOO_LARGE";
                        } else if (error instanceof SyntaxError) {
                            errorCode = "INVALID_API_JSON";
                        } else if (reason === "10Gbps direct URL unavailable") {
                            errorCode = "DIRECT_LINK_MISSING";
                        } else if (reason === "Invalid direct URL host") {
                            errorCode = "INVALID_DIRECT_HOST";
                        } else if (error instanceof TypeError) {
                            errorCode = "FETCH_OR_URL_ERROR";
                        }

                        console.error(
                            "[INSTANT AUTO] Diagnostic:",
                            errorCode
                        );

                        return jsonResponse({
                            status: "error",
                            message:
                                "Instant download link could not be resolved.",
                            error_code: errorCode
                        }, 502);
                    }
                }


                // ------------------------------------------
                // HUBCLOUD
                // ------------------------------------------

                if (
                    action ===
                    "hubcloud"
                ) {
                    const hubcloudUrl =
                        record.hubcloud_url;

                    if (
                        !hubcloudUrl ||
                        hubcloudUrl ===
                            "Not Found"
                    ) {
                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "HubCloud link is not available yet."
                            }),
                            {
                                status: 404,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }

                    await creditDownloadEarning(
                        record,
                        request,
                        env
                    );

                    return Response.redirect(
                        hubcloudUrl,
                        302
                    );
                }


                // ------------------------------------------
                // GDFLIX
                // ------------------------------------------

                if (
                    action ===
                    "gdflix"
                ) {
                    const gdflixUrl =
                        record.gdflix_url;

                    if (
                        !gdflixUrl ||
                        gdflixUrl ===
                            "Not Found"
                    ) {
                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "GDFlix link is not available yet."
                            }),
                            {
                                status: 404,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }

                    await creditDownloadEarning(
                        record,
                        request,
                        env
                    );

                    return Response.redirect(
                        gdflixUrl,
                        302
                    );
                }

            } catch (error) {
                console.error(
                    "Tracked Download Error:",
                    error
                );

                return new Response(
                    JSON.stringify({
                        status: "error",
                        message: error.message
                    }),
                    {
                        status: 500,
                        headers: {
                            ...corsHeaders,
                            ...jsonHeaders()
                        }
                    }
                );
            }
        }


        // ==================================================
        // ==================================================
        // S-CLOUD MULTI-PAGE ROUTING + AUTH PROTECTION
        // ==================================================

        // Clean URLs serve their own HTML documents. Each navigation
        // is a normal browser navigation/full page reload; API routes
        // under /api/ remain untouched because only exact paths match.
        const pageRoutes = {
            "/dashboard": "/dashboard.html",
            "/upload": "/upload.html",
            "/files": "/files.html",
            "/api": "/api.html",
            "/settings": "/settings.html",
            "/manage-sites": "/manage-sites.html",
            "/withdraw": "/withdraw.html"
        };

        const protectedHtmlPages = [
            "/dashboard.html",
            "/upload.html",
            "/files.html",
            "/api.html",
            "/settings.html",
            "/manage-sites.html",
            "/withdraw.html"
        ];

        // The underlying admin document must not be directly accessible.
        if (url.pathname === "/admin.html") {
            const directAdminUser = await getCurrentUser(request, env);
            if (!directAdminUser) return Response.redirect(new URL("/", request.url).toString(), 302);
            if (String(directAdminUser.email || "").toLowerCase() !== "sagarmajethiya444@gmail.com") return new Response("Not Found", { status: 404 });
            return env.ASSETS.fetch(new Request(new URL("/admin.html", request.url), request));
        }

        const isProtectedPage =
            Object.prototype.hasOwnProperty.call(
                pageRoutes,
                url.pathname
            ) || protectedHtmlPages.includes(url.pathname);

        if (isProtectedPage) {
            const pageUser = await getCurrentUser(request, env);

            if (!pageUser) {
                const loginUrl = new URL("/", request.url);
                loginUrl.searchParams.set(
                    "redirect",
                    url.pathname + url.search
                );
                return Response.redirect(loginUrl.toString(), 302);
            }

            if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
                const targetPath = pageRoutes[url.pathname] || url.pathname;
                const pageRequest = new Request(
                    new URL(targetPath, request.url),
                    request
                );
                return env.ASSETS.fetch(pageRequest);
            }
        }

        // The old SPA shell is no longer used. Never serve it as a page.
        if (url.pathname === "/app.html") {
            return Response.redirect(new URL("/", request.url).toString(), 302);
        }

        // ==================================================
        // PUBLIC ROOT / LOGIN PAGE
        // ==================================================

        if (
            ["/", "/login", "/privacy", "/terms"].includes(url.pathname) &&
            request.method === "GET" &&
            env.ASSETS &&
            typeof env.ASSETS.fetch === "function"
        ) {
            const indexRequest = new Request(
                new URL(url.pathname === "/privacy" ? "/privacy.html" : url.pathname === "/terms" ? "/terms.html" : url.pathname === "/login" || url.searchParams.has("redirect") ? "/index.html" : "/home.html", request.url),
                request
            );

            return env.ASSETS.fetch(
                indexRequest
            );
        }


        // ==================================================
        // STATIC FRONTEND
        // ==================================================

        if (
            env.ASSETS &&
            typeof env.ASSETS.fetch ===
                "function"
        ) {
            return env.ASSETS.fetch(
                request
            );
        }


        // ==================================================
        // DEFAULT RESPONSE
        // ==================================================

        return new Response(
            "S-Cloud Dashboard Mega Engine is Live!",
            {
                status: 200,
                headers:
                    corsHeaders
            }
        );
    }
};
