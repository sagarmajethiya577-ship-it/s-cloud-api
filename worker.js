import { copyFileToSCloud } from "./drive-handler.js";
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


// ==================================================
// GET CURRENT USER
// ==================================================

async function getCurrentUser(
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
            ).format(
                new Date()
            );

        const ipHash =
            await sha256Hex(
                visitorIP
            );

        const downloadId =
            `paid:${indiaDate}:${ipHash}`;

        const earningAmount =
            Number(
                (
                    cpm /
                    1000
                ).toFixed(6)
            );

        if (
            !Number.isFinite(
                earningAmount
            ) ||
            earningAmount <= 0
        ) {
            return {
                credited: false,
                reason: "invalid_amount"
            };
        }

        /*
         * The UNIQUE partial index on
         * earnings(download_id) guarantees
         * one paid view per IP per India day.
         *
         * SQLite changes() is checked by the
         * following UPDATE. If INSERT OR IGNORE
         * was ignored because the IP already earned
         * today, changes() is 0 and balance is not
         * increased.
         */
        const batchResult =
            await env.DB.batch([
                env.DB
                    .prepare(
                        `INSERT OR IGNORE INTO earnings
                        (
                            user_id,
                            file_id,
                            download_id,
                            amount,
                            type,
                            status,
                            description
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?)`
                    )
                    .bind(
                        record.user_id,
                        record.id,
                        downloadId,
                        earningAmount,
                        "download",
                        "credited",
                        "Unique download earning"
                    ),

                env.DB
                    .prepare(
                        `UPDATE users
                         SET balance =
                             COALESCE(balance, 0) + ?
                         WHERE id = ?
                           AND changes() > 0`
                    )
                    .bind(
                        earningAmount,
                        record.user_id
                    )
            ]);

        const insertResult =
            batchResult &&
            batchResult[0];

        const credited =
            Number(
                insertResult?.meta
                    ?.changes || 0
            ) > 0;

        if (credited) {
            console.log(
                `[EARNING] CREDITED | file=${record.short_id || record.id} | user=${record.user_id} | amount=${earningAmount} | date=${indiaDate}`
            );

            return {
                credited: true,
                amount:
                    earningAmount,
                date:
                    indiaDate
            };
        }

        console.log(
            `[EARNING] SKIPPED | file=${record.short_id || record.id} | reason=already_earned_today`
        );

        return {
            credited: false,
            reason:
                "already_earned_today"
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

            if (!record || record.status === "deleted") {
                console.log(
                    `[FAST] Record missing/deleted ${shortId} | elapsed=${elapsed()}`
                );
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
                record.status === "deleted"
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
                            status
                        )
                        VALUES (?, ?, ?, 'publisher', 0, 1.0, 'active')`
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
                            shared_by_enabled = ?
                         WHERE id = ?`
                    )
                    .bind(
                        sharedBy,
                        enabled,
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

            await env.DB.prepare(`
                CREATE INDEX IF NOT EXISTS idx_withdrawals_user
                ON withdrawals(user_id)
            `).run();

            await env.DB.prepare(`
                CREATE INDEX IF NOT EXISTS idx_withdrawals_status
                ON withdrawals(status)
            `).run();
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
                const settings = await env.DB.prepare(`
                    SELECT minimum_amount
                    FROM withdrawal_settings
                    WHERE id = 1
                `).first();

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
                        created_at,
                        processed_at,
                        rejection_reason
                    FROM withdrawals
                    WHERE user_id = ?
                    ORDER BY id DESC
                `).bind(user.id).all();

                return jsonResponse({
                    status: "success",
                    balance: Number(user.balance || 0),
                    minimumAmount: Number(settings?.minimum_amount || 10),
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

                const settings = await env.DB.prepare(`
                    SELECT minimum_amount
                    FROM withdrawal_settings
                    WHERE id = 1
                `).first();

                const minimum = Number(settings?.minimum_amount || 10);

                if (!Number.isFinite(amount) || amount < minimum) {
                    return jsonResponse({
                        status: "error",
                        message: `Minimum withdrawal is $${minimum.toFixed(2)}`
                    }, 400);
                }

                if (amount > Number(user.balance || 0)) {
                    return jsonResponse({
                        status: "error",
                        message: "Insufficient balance"
                    }, 400);
                }

                if (!["upi", "bank", "paypal", "crypto"].includes(method)) {
                    return jsonResponse({
                        status: "error",
                        message: "Invalid payment method"
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
                "/api/upload" ||
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
                             INNER JOIN files f
                                ON f.id = e.file_id
                             WHERE e.user_id = ?
                             AND f.status != 'deleted'
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
                             INNER JOIN files f
                                ON f.id = e.file_id
                             WHERE e.user_id = ?
                             AND f.status != 'deleted'
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
                            `${requestedDate}T00:00:00+05:30`
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

                const monthMatch = /^(\d{4})-(\d{2})$/.exec(requestedMonth);

                if (!monthMatch) {
                    throw new Error("Invalid requested month");
                }

                const baseYear = Number(monthMatch[1]);
                const baseMonth = Number(monthMatch[2]) - 1;

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
        // 7. DELETE FILE
        // ==================================================

        if (
            url.pathname ===
                "/api/delete" &&
            request.method ===
                "POST"
        ) {
            try {

                const body =
                    await request.json();

                const {
                    file_id
                } = body;


                if (
                    !file_id
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "File ID is required"
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
                             SET status = 'deleted',
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE
                                (id = ? OR short_id = ?)
                                AND user_id = ?
                                AND status != 'deleted'`
                        )
                        .bind(
                            file_id,
                            file_id,
                            currentUser.id
                        )
                        .run();


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
                            "Deleted successfully!"
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
            try {

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

                        const token =
                            await getAccessToken(
                                env.OAUTH_CLIENT_ID,
                                env.OAUTH_CLIENT_SECRET,
                                env.OAUTH_REFRESH_TOKEN
                            );


                        const listRes =
                            await fetch(
                                `https://www.googleapis.com/drive/v3/files?q='${encodeURIComponent(folderId)}'+in+parents&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,size,mimeType)`,
                                {
                                    headers: {
                                        "Authorization":
                                            `Bearer ${token}`
                                    }
                                }
                            );


                        const listData =
                            await listRes.json();


                        if (
                            !listRes.ok
                        ) {
                            throw new Error(
                                listData.error?.message ||
                                "Google Drive folder API error"
                            );
                        }


                        if (
                            !listData.files ||
                            listData.files.length ===
                                0
                        ) {
                            return new Response(
                                JSON.stringify({
                                    status:
                                        "error",
                                    message:
                                        "No files found inside this folder."
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


                        cleanUrl =
                            `https://drive.google.com/file/d/${listData.files[0].id}/view`;

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

                const match =
                    cleanUrl.match(
                        /[-\w]{25,}/
                    );


                if (
                    !cleanUrl.includes(
                        "drive.google.com"
                    ) ||
                    !match
                ) {
                    return new Response(
                        JSON.stringify({
                            status:
                                "error",
                            message:
                                "Invalid Google Drive Link format!"
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


                const sourceFileId =
                    match[0];


                // --------------------------------------
                // GET SOURCE FILE METADATA
                // --------------------------------------

                let actualFileName =
                    "Unknown File";

                let exactFileSize =
                    "Unknown";


                try {

                    const token =
                        await getAccessToken(
                            env.OAUTH_CLIENT_ID,
                            env.OAUTH_CLIENT_SECRET,
                            env.OAUTH_REFRESH_TOKEN
                        );


                    const metaRes =
                        await fetch(
                            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}?fields=name,size,mimeType&supportsAllDrives=true`,
                            {
                                headers: {
                                    "Authorization":
                                        `Bearer ${token}`
                                }
                            }
                        );


                    const metaData =
                        await metaRes.json();


                    if (
                        !metaRes.ok
                    ) {
                        throw new Error(
                            metaData.error?.message ||
                            "Google Drive metadata error"
                        );
                    }


                    if (
                        metaData &&
                        metaData.name
                    ) {

                        actualFileName =
                            metaData.name;


                        if (
                            metaData.size
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


                // --------------------------------------
                // STEP 1 - COPY TO S-CLOUD DRIVE
                //
                // IMPORTANT:
                // Original Google Drive URL is used only
                // temporarily and is NEVER saved to DB.
                // --------------------------------------

                const scloudResult =
                    await copyFileToSCloud(
                        cleanUrl,
                        env
                    );


                if (
                    !scloudResult ||
                    !scloudResult.fileId
                ) {
                    throw new Error(
                        "S-Cloud Copy Failed"
                    );
                }


                const scloudFileId =
                    scloudResult.fileId;


                // --------------------------------------
                // CREATE S-CLOUD DRIVE URL
                // --------------------------------------

                const scloudDriveUrl =
                    `https://drive.google.com/file/d/${scloudFileId}/view`;


                // --------------------------------------
                // UPDATE FILE SIZE FROM S-CLOUD COPY
                // --------------------------------------

                if (
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


                const short_link =
                    `https://${url.hostname}/file/${shortId}`;


                // --------------------------------------
                // INSERT FILE RECORD
                //
                // drive_url contains ONLY the
                // S-CLOUD COPIED DRIVE URL.
                //
                // Original Google Drive URL is NOT saved.
                // --------------------------------------

                await env.DB
                    .prepare(
                        `INSERT INTO files
                        (
                            id,
                            short_id,
                            user_id,
                            file_name,
                            file_size,
                            drive_url,
                            last_updated,
                            status
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                    )
                    .bind(
                        shortId,
                        shortId,
                        currentUser.id,
                        actualFileName,
                        exactFileSize,
                        scloudDriveUrl,
                        currentTime,
                        "active"
                    )
                    .run();


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
                            // Only after PDLink succeeds, Drivetot
                            // upload starts.
                            // =================================

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

                            console.log(
                                `[PDLINK] Share ID saved | file=${shortId} | share=${pdlinkResult.share_id}`
                            );

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


                // --------------------------------------
                // RESPONSE
                // --------------------------------------

                return new Response(
                    JSON.stringify({
                        status:
                            "success",
                        message:
                            "File Uploaded Successfully!",
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

                console.error(
                    "Upload Error:",
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
                                 users.shared_by_enabled
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

                await env.DB
                    .prepare(
                        `UPDATE files
                         SET views = COALESCE(views, 0) + 1
                         WHERE id = ?`
                    )
                    .bind(
                        record.id
                    )
                    .run();

                // ==========================================
                // VIEW LOGGING
                // ==========================================

                const viewerIp =
                    request.headers.get("CF-Connecting-IP") ||
                    request.headers.get("X-Real-IP") ||
                    (
                        request.headers.get("X-Forwarded-For") || ""
                    )
                        .split(",")[0]
                        .trim() ||
                    "unknown";

                const viewerUserAgent =
                    request.headers.get("User-Agent") ||
                    null;

                try {
                    await env.DB
                        .prepare(
                            `INSERT INTO views_log
                             (
                                 file_id,
                                 ip_address,
                                 user_agent
                             )
                             VALUES (?, ?, ?)`
                        )
                        .bind(
                            record.id,
                            viewerIp,
                            viewerUserAgent
                        )
                        .run();

                    console.log(
                        `[VIEWS] Logged | file=${shortId} | ip=${viewerIp}`
                    );

                } catch (viewLogError) {

                    console.error(
                        `[VIEWS] Log failed | file=${shortId}:`,
                        viewLogError.message
                    );
                }

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
                    !pdlinkJobs.has(shortId)
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
                            !toxcloudJobs.has(shortId)
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
                                "video/x-matroska",

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


                                    : null
                        },

                        mirrors: {
                            hubcloud:
                                !!record.hubcloud_url,

                            gdflix:
                                !!record.gdflix_url,

                            gofile:
                                !!record.pdlink_share_id,

                            toxcloud:
                                !!record.toxcloud_url,

                            pixeldrain:
                                !!record.pdlink_share_id
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
                        headers: {
                            "Content-Type":
                                "application/json",
                            ...corsHeaders
                        }
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

        if (
            url.pathname.startsWith("/d/") &&
            request.method === "GET"
        ) {
            const shortId =
                url.pathname
                    .split("/")
                    .filter(Boolean)[1];

            if (!shortId) {
                return new Response(
                    "Invalid download link.",
                    {
                        status: 400,
                        headers: corsHeaders
                    }
                );
            }

            if (
                env.ASSETS &&
                typeof env.ASSETS.fetch === "function"
            ) {
                const downloadRequest =
                    new Request(
                        new URL(
                            "/download.html",
                            request.url
                        ),
                        request
                    );

                return env.ASSETS.fetch(
                    downloadRequest
                );
            }

            return new Response(
                "Download page unavailable.",
                {
                    status: 503,
                    headers: corsHeaders
                }
            );
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
                            `SELECT
                                id,
                                short_id,
                                status,
                                hubcloud_url,
                                gdflix_url,
                                pdlink_share_id,
                                toxcloud_url,
                                fast_links,
                                fast_links_expires_at,
                                last_updated
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
                                !!record.pdlink_share_id,

                            toxcloud:
                                !!record.toxcloud_url,

                            pixeldrain:
                                !!record.pdlink_share_id
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


                // ------------------------------------------
                // PDLINK: GOFILE + PIXELDRAIN
                // ------------------------------------------

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
                // INSTANT DOWNLOAD
                // ------------------------------------------

                if (
                    action ===
                    "instant"
                ) {
                    const currentTime =
                        Date.now();

                    if (
                        !hasValidFastLinks(
                            record,
                            currentTime
                        )
                    ) {
                        ctx.waitUntil(
                            prepareFastLinks(
                                shortId,
                                env
                            )
                        );

                        return new Response(
                            JSON.stringify({
                                status:
                                    "preparing",
                                message:
                                    "Instant download is still preparing."
                            }),
                            {
                                status: 202,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }

                    let links = null;

                    try {
                        links =
                            JSON.parse(
                                record.fast_links
                            );
                    } catch (error) {
                        links = null;
                    }

                    if (!links) {
                        ctx.waitUntil(
                            prepareFastLinks(
                                shortId,
                                env
                            )
                        );

                        return new Response(
                            JSON.stringify({
                                status:
                                    "preparing",
                                message:
                                    "Instant download is still preparing."
                            }),
                            {
                                status: 202,
                                headers: {
                                    ...corsHeaders,
                                    ...jsonHeaders()
                                }
                            }
                        );
                    }

                    /*
                     * bypassGDFlix() output is kept as-is.
                     * Find the first usable URL without
                     * changing the scraper's structure.
                     */

                    let instantUrl = null;

                    if (
                        typeof links ===
                        "string"
                    ) {
                        instantUrl =
                            links;
                    } else if (
                        Array.isArray(
                            links
                        )
                    ) {
                        instantUrl =
                            links.find(
                                item =>
                                    typeof item ===
                                        "string" &&
                                    /^https?:\/\//i.test(
                                        item
                                    )
                            ) || null;
                    } else if (
                        links &&
                        typeof links ===
                            "object"
                    ) {
                        const candidates = [
                            links.download,
                            links.download_url,
                            links.direct,
                            links.direct_url,
                            links.url,
                            links.link,
                            links.fast,
                            links.fast_url
                        ];

                        instantUrl =
                            candidates.find(
                                item =>
                                    typeof item ===
                                        "string" &&
                                    /^https?:\/\//i.test(
                                        item
                                    )
                            ) || null;

                        if (
                            !instantUrl
                        ) {
                            const values =
                                Object.values(
                                    links
                                );

                            instantUrl =
                                values.find(
                                    item =>
                                        typeof item ===
                                            "string" &&
                                        /^https?:\/\//i.test(
                                            item
                                        )
                                ) || null;
                        }
                    }

                    if (!instantUrl) {
                        return new Response(
                            JSON.stringify({
                                status:
                                    "error",
                                message:
                                    "Instant download link is unavailable."
                            }),
                            {
                                status: 503,
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
                        instantUrl,
                        302
                    );
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
            "/withdraw": "/withdraw.html"
        };

        const protectedHtmlPages = [
            "/dashboard.html",
            "/upload.html",
            "/files.html",
            "/api.html",
            "/settings.html",
            "/withdraw.html"
        ];

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
            url.pathname === "/" &&
            request.method === "GET" &&
            env.ASSETS &&
            typeof env.ASSETS.fetch === "function"
        ) {
            const indexRequest = new Request(
                new URL("/index.html", request.url),
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
