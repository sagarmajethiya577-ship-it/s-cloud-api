// S-Cloud Jobs Cron Worker — scheduling only.
// Provider OAuth/API credentials stay on the existing Main Worker.
// Cloudflare bindings: DB (same D1 as dashboard), MAIN (service: dashboard),
// JOB_WORKER_SECRET (same 32+ character secret on both workers).
const INTERNAL = "https://scloud-job-service.invalid/__scloud_jobs";

async function postMain(env, pathname, payload = {}) {
    const result = await env.MAIN.fetch(new Request(INTERNAL + pathname, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-SCloud-Job-Secret": env.JOB_WORKER_SECRET
        },
        body: JSON.stringify(payload)
    }));
    if (!result.ok) throw new Error(`Main Worker job route ${pathname}: HTTP ${result.status}`);
    return result.json();
}

async function tick(env) {
    if (!env.MAIN || !env.DB ||
        typeof env.JOB_WORKER_SECRET !== "string" || env.JOB_WORKER_SECRET.length < 32) {
        throw new Error("Jobs Worker is missing MAIN, DB or JOB_WORKER_SECRET bindings");
    }
    await postMain(env, "/reconcile");

    // At most 3 concurrent provider jobs; each must atomically claim its own
    // D1 row before any third-party upload request is sent.
    const due = await env.DB.prepare(`SELECT file_id, provider FROM scloud_mirror_jobs
        WHERE state='queued' AND available_at <= ?
        ORDER BY available_at ASC LIMIT 3`).bind(Date.now()).all();
    const providerResults = await Promise.allSettled((due.results || []).map(row =>
        postMain(env, "/run", { file_id:row.file_id, provider:row.provider })
    ));
    for (const result of providerResults) {
        if (result.status === "rejected") console.error("[SCLOUD CRON] Provider job:", result.reason?.message);
    }

    // Deletion requires opt-in on the Main Worker. Don't perform any Drive
    // deletion here: all OAuth credentials and folder validation remain there.
    const queued = await env.DB.prepare(`SELECT copied_drive_id
        FROM scloud_drive_cleanup_jobs WHERE state='queued' AND available_at <= ?
        ORDER BY available_at ASC LIMIT 2`).bind(Date.now()).all();
    const cleanupResults = await Promise.allSettled((queued.results || []).map(row =>
        postMain(env, "/cleanup", { copied_drive_id:row.copied_drive_id })
    ));
    for (const result of cleanupResults) {
        if (result.status === "rejected") console.error("[SCLOUD CRON] Cleanup job:", result.reason?.message);
    }
    console.log("[SCLOUD CRON] cycle", {
        providers:providerResults.length, cleanup:cleanupResults.length
    });
}

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(tick(env));
    },
    async fetch() {
        // No public invocation of the jobs engine.
        return new Response("Not Found", {status:404});
    }
};
