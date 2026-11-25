// S-CLOUD GOOGLE DRIVE COPY POOL V1
// Account 1 keeps existing OAuth bindings and existing folder as fallback.
// Account N (>1) uses OAUTH_CLIENT_ID_N, OAUTH_CLIENT_SECRET_N,
// OAUTH_REFRESH_TOKEN_N, DRIVE_FOLDER_ID_N.
// DRIVE_ACCOUNT_NUMBERS is a comma-separated list such as 1,2,3.

const LEGACY_ACCOUNT_ONE_FOLDER = "1jnJkvjIE8cvvOYOvYz52VZabX5H1bvhz";

function configuredAccountNumbers(env) {
    const raw = String(env.DRIVE_ACCOUNT_NUMBERS || "1").trim();
    const parts = raw.split(",").map(value => value.trim());
    if (parts.length === 0 || parts.some(value => !/^[1-9][0-9]*$/.test(value))) {
        throw new Error("DRIVE_ACCOUNT_NUMBERS must be comma-separated positive numbers");
    }
    const numbers = parts.map(value => Number(value));
    if (numbers.some(value => !Number.isSafeInteger(value))) {
        throw new Error("DRIVE_ACCOUNT_NUMBERS contains an unsafe account number");
    }
    return [...new Set(numbers)];
}

function parseDriveFolderId(value, number) {
    const input = String(value || "").trim();
    if (/^[A-Za-z0-9_-]{10,200}$/.test(input)) return input;
    let folder;
    try {
        const parsed = new URL(input);
        if (parsed.protocol !== "https:" || parsed.hostname !== "drive.google.com" ||
            parsed.username || parsed.password || parsed.port) {
            throw new Error("unsupported host");
        }
        folder = parsed.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,200})(?:\/|$)/)?.[1];
    } catch (_) {
        // Intentionally do not interpret arbitrary strings as folder identifiers.
    }
    if (!folder) throw new Error(`Invalid destination folder for Drive account ${number}`);
    return folder;
}

function getDrivePoolConfigurations(env) {
    const numbers = configuredAccountNumbers(env);
    const accounts = [];
    for (const number of numbers) {
        const suffix = number === 1 ? "" : `_${number}`;
        const clientId = String(env[`OAUTH_CLIENT_ID${suffix}`] || "").trim();
        const clientSecret = String(env[`OAUTH_CLIENT_SECRET${suffix}`] || "").trim();
        const refreshToken = String(env[`OAUTH_REFRESH_TOKEN${suffix}`] || "").trim();
        const folderRaw = number === 1
            ? (env.DRIVE_FOLDER_ID || LEGACY_ACCOUNT_ONE_FOLDER)
            : env[`DRIVE_FOLDER_ID_${number}`];
        if (!clientId || !clientSecret || !refreshToken || !String(folderRaw || "").trim()) {
            console.warn(`[DRIVE POOL] Account ${number} skipped: incomplete OAuth/folder configuration`);
            continue;
        }
        let folderId;
        try { folderId = parseDriveFolderId(folderRaw, number); }
        catch (_) {
            console.warn(`[DRIVE POOL] Account ${number} skipped: invalid folder`);
            continue;
        }
        accounts.push({ number, clientId, clientSecret, refreshToken, folderId });
    }
    if (!accounts.length) {
        throw new Error("No complete Google Drive account configuration found");
    }
    return accounts;
}

async function getAccessToken(clientId, clientSecret, refreshToken) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token"
        }).toString()
    });
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error(`Google OAuth returned invalid JSON (${response.status})`); }
    if (!response.ok || typeof data.access_token !== "string" || !data.access_token) {
        // Never leak OAuth tokens, client secrets, or upstream response bodies.
        throw new Error(`Google OAuth rejected credentials (HTTP ${response.status})`);
    }
    return data.access_token;
}

async function chooseDriveAccount(env, sourceFileId, requiredAccountNumber = null) {
    const configured = getDrivePoolConfigurations(env);
    const accounts = requiredAccountNumber == null
        ? configured
        : configured.filter(account => account.number === requiredAccountNumber);
    if (!accounts.length) {
        throw new Error(`Required Google Drive account ${requiredAccountNumber} is not configured`);
    }
    if (!env.DB) throw new Error("D1 DB binding missing for Drive rotation");
    let start = 0;
    if (requiredAccountNumber == null) {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scloud_drive_rotation (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            cursor INTEGER NOT NULL DEFAULT 0
        )`).run();
        await env.DB.prepare(`INSERT OR IGNORE INTO scloud_drive_rotation (singleton, cursor)
            VALUES (1, 0)`).run();

        // UPDATE ... RETURNING atomically reserves one slot across Workers.
        const row = await env.DB.prepare(`UPDATE scloud_drive_rotation
            SET cursor = cursor + 1 WHERE singleton = 1 RETURNING cursor`).first();
        const cursor = Number(row?.cursor);
        if (!Number.isSafeInteger(cursor) || cursor < 1) {
            throw new Error("Drive account rotation state unavailable");
        }
        start = (cursor - 1) % accounts.length;
    }
    // Forced Account 1 for >12 GiB never advances round-robin cursor again.

    // A failed OAuth token refresh cannot have copied a file, so safely try
    // another configured account. DO NOT retry after starting files.copy.
    for (let offset = 0; offset < accounts.length; offset++) {
        const account = accounts[(start + offset) % accounts.length];
        try {
            const token = await getAccessToken(
                account.clientId, account.clientSecret, account.refreshToken
            );
            // Before copying, verify THIS account can read the source.
            // Trying another account after this check is safe; no copy exists yet.
            const sourceCheck = await fetch(
                `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}?fields=id&supportsAllDrives=true`,
                { headers: { "Authorization": `Bearer ${token}` } }
            );
            if (!sourceCheck.ok) {
                console.warn(`[DRIVE POOL] Account ${account.number} cannot access source (HTTP ${sourceCheck.status})`);
                continue;
            }
            // Check the destination folder with the SAME identity before
            // performing any irreversible files.copy operation.
            const folderCheck = await fetch(
                `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(account.folderId)}?fields=id,mimeType,capabilities(canAddChildren)&supportsAllDrives=true`,
                { headers: { "Authorization": `Bearer ${token}` } }
            );
            if (!folderCheck.ok) {
                console.warn(`[DRIVE POOL] Account ${account.number} cannot access its folder (HTTP ${folderCheck.status})`);
                continue;
            }
            const folder = await folderCheck.json();
            if (folder?.id !== account.folderId ||
                folder?.mimeType !== "application/vnd.google-apps.folder" ||
                folder?.capabilities?.canAddChildren === false) {
                console.warn(`[DRIVE POOL] Account ${account.number} folder is not writable`);
                continue;
            }
            return { account, token };
        } catch (error) {
            console.error(`[DRIVE POOL] Account ${account.number} OAuth unavailable:`,
                error?.message || "token failed");
        }
    }
    throw new Error("All configured Drive accounts failed OAuth token refresh");
}

function formatFileSize(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) return "Unknown";
    if (size > 1024 * 1024 * 1024) {
        return (size / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    }
    return (size / (1024 * 1024)).toFixed(2) + " MB";
}

export async function selectDriveCopyAccount(sourceFileId, env, options = {}) {
    if (typeof sourceFileId !== "string" || !/^[A-Za-z0-9_-]{10,}$/.test(sourceFileId)) {
        throw new Error("Invalid original Drive file ID");
    }
    const requiredAccountNumber = options.requiredAccountNumber == null
        ? null : Number(options.requiredAccountNumber);
    if (requiredAccountNumber != null &&
        (!Number.isSafeInteger(requiredAccountNumber) || requiredAccountNumber < 1)) {
        throw new Error("Invalid required Drive account");
    }
    return chooseDriveAccount(env, sourceFileId, requiredAccountNumber);
}

export async function copyFileToSCloud(
    driveUrl, env, onCopyCreated = null, onCopyAttempted = null, preparedAccount = null
) {
    if (!driveUrl || typeof driveUrl !== "string") {
        throw new Error("Invalid Google Drive Link");
    }
    const match = driveUrl.match(/[-\w]{25,}/);
    if (!match) throw new Error("Invalid Google Drive Link");
    const sourceFileId = match[0];

    // The upload route can preselect one account to read metadata and copy
    // with the SAME credentials. Direct callers may let this function select.
    const { account, token } = preparedAccount || await chooseDriveAccount(env, sourceFileId);
    console.log(`[DRIVE POOL] Copy started | account=${account.number}`);

    // One selected identity + its matching destination folder are used for
    // the ENTIRE copy and permissions flow. No fallback after this request.
    if (typeof onCopyAttempted === "function") onCopyAttempted();
    const copyRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}/copy?supportsAllDrives=true`,
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ parents: [account.folderId] })
        }
    );
    let copyData;
    try { copyData = await copyRes.json(); }
    catch (_) { throw new Error(`Google copy returned invalid JSON (HTTP ${copyRes.status})`); }
    if (!copyRes.ok || copyData?.error) {
        throw new Error(`Google Drive copy rejected (HTTP ${copyRes.status}); account=${account.number}`);
    }
    const newFileId = copyData?.id;
    if (typeof newFileId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(newFileId)) {
        throw new Error("Google copy response lacks a valid file ID; manual review required");
    }

    // Save copied ID AND account/folder immediately. On a later permission
    // error, same-user dedupe claim remains and never silently recopies.
    if (typeof onCopyCreated === "function") {
        await onCopyCreated(newFileId, {
            accountNumber: account.number,
            folderId: account.folderId
        });
    }

    const permRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(newFileId)}/permissions?supportsAllDrives=true`,
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ type: "anyone", role: "reader" })
        }
    );
    let permData;
    try { permData = await permRes.json(); }
    catch (_) { throw new Error(`Google permission response invalid (HTTP ${permRes.status})`); }
    if (!permRes.ok || permData?.error) {
        throw new Error(`Google Drive permission rejected (HTTP ${permRes.status}); account=${account.number}`);
    }

    let fileSize = "Unknown";
    try {
        const metaRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(newFileId)}?fields=size&supportsAllDrives=true`,
            { headers: { "Authorization": `Bearer ${token}` } }
        );
        if (metaRes.ok) {
            const metadata = await metaRes.json();
            if (metadata?.size) fileSize = formatFileSize(metadata.size);
        }
    } catch (error) {
        console.warn(`[DRIVE POOL] Size lookup failed for account=${account.number}`);
    }

    console.log(`[DRIVE POOL] Copy ready | account=${account.number}`);
    return {
        fileId: newFileId,
        fileSize,
        driveAccountNumber: account.number,
        targetFolderId: account.folderId
    };
}


// Delete ONLY a D1-tracked copy, not a user's original source.
// Credentials and folder MUST match the account used at files.copy time.
export async function deleteTrackedDriveCopy(copiedDriveId, accountNumber, folderId, env) {
    const accountId = Number(accountNumber);
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(copiedDriveId || ""))) {
        throw new Error("Invalid tracked copied Drive ID");
    }
    const account = getDrivePoolConfigurations(env).find(item => item.number === accountId);
    if (!account || account.folderId !== folderId) {
        throw new Error("Tracked account/folder does not match live configuration");
    }
    const token = await getAccessToken(account.clientId, account.clientSecret, account.refreshToken);
    const filePath = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(copiedDriveId)}`;
    const response = await fetch(
        `${filePath}?fields=id,parents,mimeType,trashed&supportsAllDrives=true`,
        { headers: { "Authorization": `Bearer ${token}` }, redirect: "manual" }
    );
    if (response.status === 404) return { alreadyMissing: true };
    if (!response.ok) throw new Error(`Drive cleanup metadata HTTP ${response.status}`);
    const meta = await response.json();
    if (meta.id !== copiedDriveId ||
        !Array.isArray(meta.parents) || !meta.parents.includes(folderId) ||
        meta.mimeType === "application/vnd.google-apps.folder") {
        throw new Error("Drive cleanup ownership/parent verification failed");
    }
    const removed = await fetch(`${filePath}?supportsAllDrives=true`, {
        method: "DELETE", headers: { "Authorization": `Bearer ${token}` }, redirect: "manual"
    });
    if (removed.status === 204 || removed.status === 200 || removed.status === 404) {
        return { deleted: true };
    }
    throw new Error(`Drive cleanup delete HTTP ${removed.status}`);
}
