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

    // Bounded waves: prioritize fresh submissions, reserve a separate extraction lane.
    // A row must still be atomically claimed in Main before an external request.
    const batchSize=Math.max(3,Math.min(36,Number.parseInt(env.SCLOUD_JOB_BATCH_SIZE||'18',10)||18));
    const concurrency=Math.max(1,Math.min(4,Number.parseInt(env.SCLOUD_JOB_CONCURRENCY||'3',10)||3));
    const now=Date.now();
    const due=await env.DB.prepare(`SELECT file_id,provider FROM scloud_mirror_jobs WHERE state='queued' AND available_at<=? AND provider<>'extract' ORDER BY available_at ASC LIMIT ?`).bind(now,batchSize).all();
    const extraction=await env.DB.prepare(`SELECT file_id,provider FROM scloud_mirror_jobs WHERE state='queued' AND available_at<=? AND provider='extract' ORDER BY available_at ASC LIMIT 2`).bind(now).all();
    const providerResults=[];
    async function runRows(rows) {
        for(let i=0;i<rows.length;i+=concurrency) {
            if(Date.now()-now>50000) break;
            const result=await Promise.allSettled(rows.slice(i,i+concurrency).map(row=>postMain(env,'/run',{file_id:row.file_id,provider:row.provider})));
            providerResults.push(...result);
            for(const item of result) if(item.status==='rejected') console.error('[SCLOUD CRON] Provider job:',item.reason?.message);
        }
    }
    await runRows(due.results||[]);
    await runRows(extraction.results||[]);

    // Direct-source mode must NEVER delete an original user's Drive file.
    // Legacy cleanup records stay queued, but this scheduler never dispatches
    // Drive deletion, including for old files copied before the switch.
    console.log("[SCLOUD CRON] cycle", {
        providers: providerResults.length, cleanup: 0
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
