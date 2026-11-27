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

function getDrivePoolConfigurations(env, metadataOnly = false) {
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
        if (!clientId || !clientSecret || !refreshToken || (!metadataOnly && !String(folderRaw || "").trim())) {
            console.warn(`[DRIVE POOL] Account ${number} skipped: incomplete OAuth/folder configuration`);
            continue;
        }
        let folderId;
        try { folderId = metadataOnly ? null : parseDriveFolderId(folderRaw, number); }
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

// Read-only metadata path. No folder write, files.copy or content download.
const metadataTokenCache = new Map();
function metadataError(code) { return Object.assign(new Error(code), {code}); }
async function metadataToken(account, signal, force = false) {
    const credentials = JSON.stringify([account.clientId,account.clientSecret,account.refreshToken]);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(credentials));
    const key=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    const cached=metadataTokenCache.get(key);
    if (!force && cached && cached.expiresAt>Date.now()) return cached.token;
    metadataTokenCache.delete(key);
    const response=await fetch('https://oauth2.googleapis.com/token',{
        method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},signal,
        body:new URLSearchParams({client_id:account.clientId,client_secret:account.clientSecret,
            refresh_token:account.refreshToken,grant_type:'refresh_token'}).toString()
    });
    const data=await response.json().catch(()=>null);
    if(response.status===429) throw metadataError('DRIVE_RATE_LIMIT');
    if(!response.ok||typeof data?.access_token!=='string'||!data.access_token) throw metadataError('DRIVE_OAUTH_UNAVAILABLE');
    const ttl=Number(data.expires_in);
    if(Number.isFinite(ttl)&&ttl>90) {
        if(metadataTokenCache.size>=32) metadataTokenCache.delete(metadataTokenCache.keys().next().value);
        metadataTokenCache.set(key,{token:data.access_token,expiresAt:Date.now()+Math.min(ttl-60,3600)*1000});
    }
    return data.access_token;
}
function driveMetadataError(status, data) {
    const reasons=(data?.error?.errors||[]).map(item=>String(item.reason||''));
    if(reasons.some(reason=>/^(downloadQuotaExceeded|storageQuotaExceeded|quotaExceeded|dailyLimitExceeded)$/i.test(reason))) return 'DRIVE_QUOTA';
    if(status===429||reasons.some(reason=>/rateLimitExceeded/i.test(reason))) return 'DRIVE_RATE_LIMIT';
    if(status===404) return 'DRIVE_NOT_FOUND';
    if(status===403) return 'DRIVE_ACCESS_DENIED';
    if(status===401) return 'DRIVE_OAUTH_UNAVAILABLE';
    return 'DRIVE_METADATA_UNAVAILABLE';
}
export async function selectDriveMetadataAccount(sourceFileId, env, options = {}) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(String(sourceFileId))) throw metadataError('DRIVE_NOT_FOUND');
    const resourceKey=options.resourceKey;
    if(resourceKey!=null&&!/^[A-Za-z0-9_-]{1,200}$/.test(String(resourceKey))) throw metadataError('DRIVE_ACCESS_DENIED');
    let accounts;
    try { accounts=getDrivePoolConfigurations(env,true); }
    catch { throw metadataError('DRIVE_OAUTH_UNAVAILABLE'); }
    // Use configured authorized accounts for access; never rotate to evade a
    // reported quota or API rate restriction. Bound total upstream time.
    const signal=AbortSignal.timeout(12000);
    const failures=[];
    for(const account of accounts) {
        try {
            const headers=token=>({Authorization:`Bearer ${token}`,...(resourceKey?{'X-Goog-Drive-Resource-Keys':`${sourceFileId}/${resourceKey}`}:{})});
            const url=`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceFileId)}?fields=id,name,size,mimeType,trashed&supportsAllDrives=true`;
            let token=await metadataToken(account,signal);
            let response=await fetch(url,{headers:headers(token),signal});
            if(response.status===401) {
                await response.body?.cancel();
                token=await metadataToken(account,signal,true);
                response=await fetch(url,{headers:headers(token),signal});
            }
            const metadata=await response.json().catch(()=>null);
            if(!response.ok) {
                const code=driveMetadataError(response.status,metadata);
                console.warn('[DRIVE METADATA]',{account:account.number,http:response.status,code});
                if(code==='DRIVE_RATE_LIMIT'||code==='DRIVE_QUOTA') throw metadataError(code);
                failures.push(code);
                continue;
            }
            if(metadata?.id!==sourceFileId||!metadata?.name) {
                failures.push('DRIVE_METADATA_UNAVAILABLE'); continue;
            }
            return {account,token,metadata};
        } catch(error) {
            if(error?.code==='DRIVE_RATE_LIMIT'||error?.code==='DRIVE_QUOTA') throw error;
            failures.push(error?.code||'DRIVE_METADATA_UNAVAILABLE');
            if(signal.aborted) throw metadataError('DRIVE_METADATA_UNAVAILABLE');
        }
    }
    for(const code of ['DRIVE_METADATA_UNAVAILABLE','DRIVE_ACCESS_DENIED','DRIVE_NOT_FOUND','DRIVE_OAUTH_UNAVAILABLE']) {
        if(failures.includes(code)) throw metadataError(code);
    }
    throw metadataError('DRIVE_METADATA_UNAVAILABLE');
}
// Keep old exports fail-closed so an accidental legacy caller cannot copy.
export async function selectDriveCopyAccount() { throw new Error('Google Drive copy mode is permanently disabled for new uploads'); }
export async function copyFileToSCloud() { throw new Error('Google Drive copy mode is permanently disabled for new uploads'); }

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
