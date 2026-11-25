// S-Cloud job orchestration V2; no OAuth credentials live in this file.
// Externally irreversible provider submissions are never blindly retried.
import { queuePDLinkFile } from "./pdlink.js";
import { uploadToToxCloud } from "./toxcloud.js";
import { uploadToDrivetot, extractLinksFromDrivetot } from "./drivetot-scraper.js";
import { deleteTrackedDriveCopy } from "./drive-handler.js";

const PROVIDERS = new Set(["pdlink", "toxcloud", "drivetot", "extract"]);
const isRealLink = value => typeof value === "string" &&
  value.length > 12 && value !== "Not Found" && /^https:\/\//i.test(value);
const nowMs = () => Date.now();

export async function ensureScloudJobTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scloud_mirror_jobs (
    file_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('pdlink','toxcloud','drivetot','extract')),
    state TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    lease_token TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(file_id, provider)
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_scloud_mirror_job_due
    ON scloud_mirror_jobs(state, available_at)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS scloud_drive_cleanup_jobs (
    copied_drive_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    account_number INTEGER NOT NULL,
    folder_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    available_at INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    lease_token TEXT,
    last_error TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_scloud_cleanup_due
    ON scloud_drive_cleanup_jobs(state, available_at)`).run();
}

export function newMirrorJobStatements(fileId, env) {
  if (!/^[a-zA-Z0-9_-]{6,128}$/.test(String(fileId))) {
    throw new Error("Invalid job file ID");
  }
  return ["pdlink", "toxcloud", "drivetot"].map(provider => env.DB.prepare(`
    INSERT OR IGNORE INTO scloud_mirror_jobs
      (file_id, provider, state, available_at)
    VALUES (?, ?, 'queued', ?)
  `).bind(fileId, provider, nowMs()));
}

export async function hasCronMirrorJobs(fileId, env) {
  try {
    const existing = await env.DB.prepare(
      `SELECT 1 AS present FROM scloud_mirror_jobs WHERE file_id = ? LIMIT 1`
    ).bind(fileId).first();
    return !!existing;
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ""))) return false;
    // Fail closed: don't start duplicate legacy uploads if uncertain.
    console.error("[SCLOUD JOBS] Could not check mirror jobs", error?.message || error);
    return true;
  }
}

function parseJobDriveId(url) {
  const text = String(url || "");
  const match = /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,200})\/view(?:\?.*)?$/.exec(text);
  if (!match) throw new Error("Invalid tracked Google Drive source URL");
  return match[1];
}

async function markJob(env, fileId, provider, token, state, error = null, availableAt = null) {
  await env.DB.prepare(`UPDATE scloud_mirror_jobs
    SET state = ?, last_error = ?, available_at = COALESCE(?, available_at),
        lease_until = NULL, lease_token = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE file_id = ? AND provider = ? AND state = 'running' AND lease_token = ?`
  ).bind(state, error, availableAt, fileId, provider, token).run();
}

// Existing Main Worker handles the API keys and the canonical sync format.
export async function executeScloudMirrorJob(fileId, provider, env, uploadPolicy, syncDownloadMetadata, options = {}) {
  if (!PROVIDERS.has(provider)) throw new Error("Unsupported job provider");
  const token = crypto.randomUUID();
  const now = nowMs();
  const claim = await env.DB.prepare(`UPDATE scloud_mirror_jobs
    SET state = 'running', attempts = attempts + 1,
        lease_token = ?, lease_until = ?, updated_at = CURRENT_TIMESTAMP
    WHERE file_id = ? AND provider = ? AND state = 'queued' AND available_at <= ?
    RETURNING attempts`
  ).bind(token, now + 480000, fileId, provider, now).first();
  if (!claim) return { state: "not_due" };

  let outboundStarted = false;
  try {
    const record = await env.DB.prepare(`SELECT * FROM files
      WHERE (short_id = ? OR id = ?) LIMIT 1`).bind(fileId,fileId).first();
    if (!record || record.status === "deleted") {
      await markJob(env, fileId, provider, token, "cancelled");
      return { state: "cancelled" };
    }
    if (options.publicEntry && (record.status !== 'active' || Number(record.sharing_enabled ?? 1) === 0)) {
      await markJob(env,fileId,provider,token,'queued',null,nowMs());
      return {state:'not_public'};
    }
    const policy = await uploadPolicy(record.user_id, env);
    if (provider === "pdlink" && !policy.pdlink ||
        provider === "toxcloud" && !policy.toxcloud) {
      await markJob(env, fileId, provider, token, "paused");
      return { state: "paused" };
    }
    let didWrite = false;
    if (provider === "pdlink") {
      if (!record.pdlink_share_id) {
        const driveId = parseJobDriveId(record.drive_url);
        if (!env.PDLINK_API_KEY) throw new Error("PDLINK_API_KEY missing");
        outboundStarted = true;
        const result = await queuePDLinkFile(driveId, env);
        if (!result?.share_id) throw new Error("PDLink returned no share_id");
        const write = await env.DB.prepare(`UPDATE files SET pdlink_share_id = ?
          WHERE (id = ? OR short_id = ?) AND COALESCE(pdlink_share_id,'') = ''
          AND COALESCE(status,'') <> 'deleted'`
        ).bind(result.share_id,fileId,fileId).run();
        didWrite = Number(write.meta?.changes||0)>0;
      }
    } else if (provider === "toxcloud") {
      if (!record.toxcloud_url) {
        const driveId = parseJobDriveId(record.drive_url);
        if (!env.TOXCLOUD_API_KEY) throw new Error("TOXCLOUD_API_KEY missing");
        outboundStarted = true;
        const result = await uploadToToxCloud(driveId, env);
        if (!isRealLink(result?.download_url)) {
          // Provider may have already accepted the upload. No blind retry.
          throw new Error("TOXCloud accepted/pending but URL unavailable; needs review");
        }
        const write = await env.DB.prepare(`UPDATE files SET toxcloud_url = ?
          WHERE (id = ? OR short_id = ?) AND COALESCE(toxcloud_url,'') = ''
          AND COALESCE(status,'') <> 'deleted'`
        ).bind(result.download_url,fileId,fileId).run();
        didWrite = Number(write.meta?.changes||0)>0;
      }
    } else if (provider === "drivetot") {
      let shareId = null;
      if (isRealLink(record.drivetot_url)) {
        shareId = new URL(record.drivetot_url).pathname.split("/").filter(Boolean)[0];
      } else {
        const driveId = parseJobDriveId(record.drive_url);
        if (!env.DRIVETOT_API_KEY) throw new Error("DRIVETOT_API_KEY missing");
        outboundStarted = true;
        const result = await uploadToDrivetot(driveId, env, {singleAttempt:true});
        if (!result?.share_id || !/^[A-Za-z0-9_-]{4,200}$/.test(String(result.share_id))) {
          throw new Error("Drivetot returned no usable share_id; needs review");
        }
        shareId = String(result.share_id);
        const write = await env.DB.prepare(`UPDATE files SET drivetot_url = ?
          WHERE (id = ? OR short_id = ?) AND COALESCE(drivetot_url,'') = ''
          AND COALESCE(status,'') <> 'deleted'`
        ).bind(`https://drivetot.website/${shareId}`,fileId,fileId).run();
        didWrite = Number(write.meta?.changes||0)>0;
      }
      // Extraction is read-only and may be safely retried independently.
      await env.DB.prepare(`INSERT OR IGNORE INTO scloud_mirror_jobs
        (file_id, provider, state, available_at) VALUES (?, 'extract', 'queued', ?)`
      ).bind(fileId,nowMs()).run();
    } else if (provider === "extract") {
      if (isRealLink(record.hubcloud_url) && isRealLink(record.gdflix_url)) {
        await markJob(env,fileId,provider,token,"done");
        return {state:"done"};
      }
      let shareId = null;
      if (isRealLink(record.drivetot_url)) {
        const link = new URL(record.drivetot_url);
        if (link.hostname === "drivetot.website") {
          shareId = link.pathname.split("/").filter(Boolean)[0];
        }
      }
      if (!shareId) throw new Error("Missing Drivetot share ID for read-only extraction");
      const result = await extractLinksFromDrivetot(shareId, env);
      const hub = isRealLink(result?.hubcloud_url) ? result.hubcloud_url : null;
      const gd = isRealLink(result?.gdflix_url) ? result.gdflix_url : null;
      const updated = await env.DB.prepare(`UPDATE files SET
        hubcloud_url = CASE WHEN ? IS NOT NULL AND
          (hubcloud_url IS NULL OR hubcloud_url = '' OR hubcloud_url = 'Not Found')
          THEN ? ELSE hubcloud_url END,
        gdflix_url = CASE WHEN ? IS NOT NULL AND
          (gdflix_url IS NULL OR gdflix_url = '' OR gdflix_url = 'Not Found')
          THEN ? ELSE gdflix_url END
        WHERE (id = ? OR short_id = ?) AND COALESCE(status,'') <> 'deleted'`
      ).bind(hub,hub,gd,gd,fileId,fileId).run();
      didWrite = Number(updated.meta?.changes||0)>0;
      const check = await env.DB.prepare(`SELECT hubcloud_url, gdflix_url FROM files
        WHERE (id = ? OR short_id = ?) LIMIT 1`).bind(fileId,fileId).first();
      if (!isRealLink(check?.hubcloud_url) || !isRealLink(check?.gdflix_url)) {
        // Avoid 2nd Drivetot upload; only repeat read-only page scraping.
        const attempts = Number(claim.attempts||1);
        if (attempts < 12) {
          await markJob(env,fileId,provider,token,"queued",
            "Waiting for Drivetot mirrors",nowMs()+Math.min(3600000,60000*2**Math.min(attempts,5)));
          if (didWrite) {
            const fresh = await env.DB.prepare(`SELECT * FROM files WHERE short_id = ? LIMIT 1`).bind(fileId).first();
            if (fresh) await syncDownloadMetadata(fresh,env);
          }
          return { state:"retry_scrape" };
        }
        throw new Error("Drivetot mirror extraction exhausted; manual review");
      }
    }

    // Return provider success even if separate metadata sync temporarily fails.
    // /d/:id also re-syncs on every entry.
    await markJob(env,fileId,provider,token,"done");
    if (didWrite) {
      const fresh = await env.DB.prepare(`SELECT * FROM files WHERE short_id = ? LIMIT 1`).bind(fileId).first();
      if (fresh) await syncDownloadMetadata(fresh, env);
    }
    return { state:"done" };
  } catch (error) {
    // An external upload may have succeeded even if its response was lost.
    // Never automatically submit a second request for that same provider.
    const reason = String(error?.message||"failed").slice(0,250);
    const attempts = Number(claim.attempts||1);
    if ((provider === 'extract' && attempts < 12) || (!outboundStarted && provider !== 'extract' && attempts < 4)) {
      await markJob(env,fileId,provider,token,'queued',reason,nowMs()+Math.min(3600000,60000*2**Math.min(attempts,5)));
      return {state:'retry_safe'};
    }
    await markJob(env,fileId,provider,token,
      !outboundStarted && provider !== "extract" ? "safe_review" : "review",reason);
    console.error(`[SCLOUD JOBS] ${provider} needs review:`, reason);
    return { state:"review" };
  }
}

// V4.1: public entry can accelerate due jobs, but uses exactly the same D1
// atomic claim as Cron. Never infer an unsubmitted upload from a missing URL.
export async function healScloudMirrorJobs(fileId, env, uploadPolicy, syncDownloadMetadata) {
  if (String(env.SCLOUD_JOBS_ENABLED || "false").toLowerCase() !== "true") return;
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(fileId))) return;
  const record = await env.DB.prepare(`SELECT * FROM files WHERE short_id=? LIMIT 1`).bind(fileId).first();
  if (!record || record.status !== "active" || Number(record.sharing_enabled ?? 1) === 0 || record.user_id == null) return;
  const jobs = await env.DB.prepare(`SELECT provider,state,attempts,available_at FROM scloud_mirror_jobs WHERE file_id=?`).bind(fileId).all();
  if (!(jobs.results || []).length) return; // legacy records stay on legacy path
  const policy = await uploadPolicy(record.user_id, env);
  const now = nowMs();
  const hasDrivetot = isRealLink(record.drivetot_url);
  const needsExtract = hasDrivetot && (!isRealLink(record.hubcloud_url) || !isRealLink(record.gdflix_url));
  const eligible = [];
  if (!record.pdlink_share_id && policy.pdlink) eligible.push("pdlink");
  if (!record.toxcloud_url && policy.toxcloud) eligible.push("toxcloud");
  if (!hasDrivetot) eligible.push("drivetot");
  if (needsExtract) eligible.push("extract");
  if (!eligible.length) return;

  // Read-only recovery: an existing Drivetot URL is sufficient; no new upload.
  if (needsExtract) {
    await env.DB.prepare(`INSERT OR IGNORE INTO scloud_mirror_jobs
      (file_id,provider,state,available_at) VALUES (?,'extract','queued',?)`).bind(fileId,now).run();
    // Bounded additional attempts after the normal Cron extraction budget.
    // Enforce cooldown atomically; simultaneous viewers cannot reset attempts.
    await env.DB.prepare(`UPDATE scloud_mirror_jobs SET state='queued',available_at=?,updated_at=CURRENT_TIMESTAMP
      WHERE file_id=? AND provider='extract' AND state IN ('review','done')
      AND attempts < 16 AND updated_at <= datetime('now','-30 minutes')`).bind(now,fileId).run();
  }
  for (const provider of eligible.filter(p=>p!=="extract")) {
    // Paused uploads did not submit. Only explicitly marked pre-submission
    // failures can be reopened, and only after a bounded cooldown.
    await env.DB.prepare(`UPDATE scloud_mirror_jobs SET state='queued',available_at=?,updated_at=CURRENT_TIMESTAMP
      WHERE file_id=? AND provider=? AND (state='paused' OR
        (state='safe_review' AND attempts<8
          AND updated_at<=datetime('now','-15 minutes')))`).bind(now,fileId,provider).run();
  }
  const due = await env.DB.prepare(`SELECT provider FROM scloud_mirror_jobs
    WHERE file_id=? AND state='queued' AND available_at<=?`).bind(fileId,nowMs()).all();
  const chosen = (due.results || []).map(row=>row.provider).filter(p=>eligible.includes(p));
  // A viewer can trigger at most three independent jobs in parallel; any
  // fourth due job remains available to Cron. Atomic claim is authoritative.
  const results = await Promise.allSettled(chosen.slice(0,3).map(provider=>
    executeScloudMirrorJob(fileId,provider,env,uploadPolicy,async()=>{},{publicEntry:true})));
  if (results.some(r=>r.status==='fulfilled' && ['done','retry_scrape'].includes(r.value?.state))) {
    const fresh=await env.DB.prepare(`SELECT * FROM files WHERE short_id=? LIMIT 1`).bind(fileId).first();
    if (fresh) await syncDownloadMetadata(fresh,env);
  }
  for (const result of results) if (result.status === 'rejected') {
    console.error('[SCLOUD HEAL] Job failed:',result.reason?.message || 'unknown');
  }
}

export async function reconcileScloudJobs(env, uploadPolicy) {
  await ensureScloudJobTables(env);
  const now = nowMs();
  // A crashed operation may have reached provider API: mark uncertain uploads
  // for review rather than restarting them. Extraction is safe to restart.
  await env.DB.prepare(`UPDATE scloud_mirror_jobs SET state = 'review',
    last_error = 'Lease expired; check provider for existing submission',
    lease_token = NULL, lease_until = NULL
    WHERE state = 'running' AND lease_until < ? AND provider <> 'extract'`
  ).bind(now).run();
  await env.DB.prepare(`UPDATE scloud_mirror_jobs SET state = 'queued',
    lease_token = NULL, lease_until = NULL, available_at = ?
    WHERE state = 'running' AND lease_until < ? AND provider = 'extract'`
  ).bind(now,now).run();
  // Google deletion may have completed before a network acknowledgment.
  // Do not automatically issue a second destructive call after lease expiry.
  await env.DB.prepare(`UPDATE scloud_drive_cleanup_jobs
    SET state='review', last_error='Cleanup lease expired; verify file before retry',
        lease_token=NULL, lease_until=NULL
    WHERE state='running' AND lease_until < ?`).bind(now).run();
  const paused = await env.DB.prepare(`SELECT j.file_id,j.provider,f.user_id
    FROM scloud_mirror_jobs j INNER JOIN files f ON f.short_id = j.file_id
    WHERE j.state = 'paused' LIMIT 30`).all();
  for (const j of paused.results||[]) {
    const rule = await uploadPolicy(j.user_id,env);
    if (j.provider === 'pdlink' && rule.pdlink ||
        j.provider === 'toxcloud' && rule.toxcloud) {
      await env.DB.prepare(`UPDATE scloud_mirror_jobs
        SET state='queued',available_at=? WHERE file_id=? AND provider=? AND state='paused'`
      ).bind(now,j.file_id,j.provider).run();
    }
  }

  // No automatic deletion without explicit opt-in. Never delete merely
  // because files.copy returned: both HubCloud and GDFlix must be resolved.
  if (String(env.DRIVE_CLEANUP_ENABLED||'false').toLowerCase() !== 'true') {
    return { cleanup_enabled:false };
  }
  const rawHours = Number(env.DRIVE_RETENTION_HOURS||168);
  const hours = Number.isFinite(rawHours) && rawHours>=24 && rawHours<=8760 ? rawHours : 168;
  const eligible = await env.DB.prepare(`SELECT r.user_id,r.source_hash,
       r.copied_drive_id,r.account_number,r.folder_id,s.file_short_id,
       f.hubcloud_url,f.gdflix_url
    FROM scloud_drive_copy_registry r
    JOIN scloud_upload_sources s ON s.user_id=r.user_id AND s.source_hash=r.source_hash
    JOIN files f ON f.short_id=s.file_short_id AND f.user_id=r.user_id
    WHERE r.created_at < datetime('now', ?)
      AND COALESCE(f.status,'') <> 'deleted'
      AND NOT EXISTS (SELECT 1 FROM scloud_drive_cleanup_jobs c
        WHERE c.copied_drive_id=r.copied_drive_id)
      AND EXISTS (SELECT 1 FROM scloud_mirror_jobs j WHERE
        j.file_id=s.file_short_id AND j.provider='drivetot' AND j.state='done')
      AND EXISTS (SELECT 1 FROM scloud_mirror_jobs j WHERE
        j.file_id=s.file_short_id AND j.provider='extract' AND j.state='done')
      AND NOT EXISTS (SELECT 1 FROM scloud_mirror_jobs j WHERE
        j.file_id=s.file_short_id AND j.state NOT IN ('done','paused'))
    LIMIT 20`).bind(`-${hours} hours`).all();
  let queued=0;
  for (const rec of eligible.results||[]) {
    if (!isRealLink(rec.hubcloud_url) || !isRealLink(rec.gdflix_url)) continue;
    const result=await env.DB.prepare(`INSERT OR IGNORE INTO scloud_drive_cleanup_jobs
      (copied_drive_id,user_id,account_number,folder_id,state,available_at)
      VALUES (?,?,?,?,'queued',?)`
    ).bind(rec.copied_drive_id,rec.user_id,rec.account_number,rec.folder_id,now).run();
    queued+=Number(result.meta?.changes||0);
  }
  return { cleanup_enabled:true, cleanup_queued:queued };
}

export async function executeScloudCleanupJob(copiedDriveId,env) {
  if (String(env.DRIVE_CLEANUP_ENABLED||'false').toLowerCase() !== 'true') {
    return { state:'cleanup_disabled' };
  }
  const token = crypto.randomUUID();
  const now = nowMs();
  const job = await env.DB.prepare(`UPDATE scloud_drive_cleanup_jobs
    SET state='running', attempts=attempts+1, lease_token=?, lease_until=?
    WHERE copied_drive_id=? AND state='queued' AND available_at <= ?
    RETURNING copied_drive_id,user_id,account_number,folder_id`
  ).bind(token,now+480000,copiedDriveId,now).first();
  if (!job) return { state:'not_due' };
  try {
    // The original upload registry must still identify this copy,
    // unless it was explicitly queued by a user deleting its file record.
    const registry = await env.DB.prepare(`SELECT copied_drive_id,account_number,folder_id
      FROM scloud_drive_copy_registry WHERE copied_drive_id=? LIMIT 1`
    ).bind(copiedDriveId).first();
    if (registry && (Number(registry.account_number)!==Number(job.account_number) ||
                     registry.folder_id!==job.folder_id)) {
      throw new Error('Copy registry does not match cleanup job');
    }
    const result = await deleteTrackedDriveCopy(
      job.copied_drive_id,job.account_number,job.folder_id,env
    );
    if (!result?.deleted && !result?.alreadyMissing) {
      throw new Error('Google Drive did not confirm deletion');
    }
    await env.DB.prepare(`UPDATE scloud_drive_cleanup_jobs
      SET state='done', deleted_at=CURRENT_TIMESTAMP, lease_token=NULL,
          lease_until=NULL, last_error=NULL
      WHERE copied_drive_id=? AND lease_token=? AND state='running'`
    ).bind(copiedDriveId,token).run();
    return { state:'done' };
  } catch (error) {
    const reason=String(error?.message||'failed').slice(0,250);
    await env.DB.prepare(`UPDATE scloud_drive_cleanup_jobs
      SET state='review',last_error=?,lease_token=NULL,lease_until=NULL
      WHERE copied_drive_id=? AND lease_token=? AND state='running'`
    ).bind(reason,copiedDriveId,token).run();
    console.error('[SCLOUD JOBS] Cleanup needs review:',reason);
    return { state:'review' };
  }
}
