// drivetot-scraper.js

const sleep = (ms) =>
    new Promise(resolve => setTimeout(resolve, ms));


// --------------------------------------------------
// SMART BASE64 DECODER
// --------------------------------------------------

function robustBase64Decode(str) {
    let b64 = String(str)
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    while (b64.length % 4) {
        b64 += "=";
    }

    return atob(b64);
}


// --------------------------------------------------
// UPLOAD FILE TO DRIVETOT
// --------------------------------------------------

// The durable queue owns retries. Do not retry a possibly accepted request
// inside this helper, or expose API keys/raw provider response bodies in logs.
async function submitDrivetotOnce(fileId, apiKey, options) {
    const validId = value => {
        if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
        if (typeof value !== "number" && typeof value !== "string") return null;
        const id = String(value).trim();
        return /^[A-Za-z0-9_-]{4,200}$/.test(id) ? id : null;
    };
    let response, data;
    try {
        response = await fetch(
            `https://drivetot.website/v4/api/file/add/${encodeURIComponent(fileId)}?key=${encodeURIComponent(apiKey)}`,
            { method:"GET", redirect:"manual", signal:options.signal || AbortSignal.timeout(18000),
              headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"} }
        );
        const body = await response.text();
        try { data = JSON.parse(body); } catch { data = null; }
    } catch (error) {
        const kind = ["AbortError","TimeoutError"].includes(error?.name) ? "timeout" : "network_error";
        console.warn("[SCLOUD DRIVETOT] response unavailable", {kind,http_status:response?.status || null});
        return {error:`Drivetot ${kind}; acceptance unknown`, kind};
    }
    const http_status = response.status;
    const objects = [data, data?.data, data?.result].filter(v => v && typeof v === "object" && !Array.isArray(v));
    const values = objects.map(v=>v.share_id).filter(v=>v !== undefined && v !== null && v !== "");
    const ids = [...new Set(values.map(validId).filter(Boolean))];
    const explicitFailure = objects.some(v => v.success === false || v.status === false ||
        ["error","failed","failure","rejected"].includes(String(v.status || "").toLowerCase()) ||
        (v.error != null && v.error !== false && v.error !== ""));
    const shape = data === null ? "non_json" : Array.isArray(data) ? "array" : typeof data;
    // Only accept an explicit share_id field, never arbitrary IDs or URLs.
    if (response.ok && !explicitFailure && ids.length === 1 && values.every(v=>validId(v)===ids[0])) {
        console.log("[SCLOUD DRIVETOT] accepted", {http_status,shape});
        return {share_id:ids[0]};
    }
    const markers = objects.flatMap(v => [v.code,v.error_code,v.reason,v.message,
        typeof v.error === "string" ? v.error : v.error?.code,
        v.error?.reason,v.error?.message]).filter(v=>typeof v === "string").join(" ").toLowerCase();
    // Log categories only; arbitrary provider messages may contain credentials.
    const exactRateCode = objects.some(v => [v.code,v.error_code,v.reason,v.error?.code,v.error?.reason]
        .some(x=>typeof x === "string" && ["rate_limit_exceeded","ratelimitexceeded","too_many_requests"].includes(x.toLowerCase())));
    const kind = http_status === 401 || /invalid.?api.?key|unauthori[sz]ed/.test(markers) ? "authentication" :
        /downloadquotaexceeded|download.quota|storage.quota|quota/.test(markers) ? "quota" :
        http_status === 429 || /rate.limit|too many requests/.test(markers) ? "rate_limit" :
        http_status === 403 ? "forbidden" : http_status >= 500 ? "server_error" :
        http_status >= 300 && http_status < 400 ? "redirect" :
        explicitFailure ? "provider_rejected" : ids.length > 1 ? "conflicting_share_ids" : "missing_share_id";
    // Only an explicit structured 429 rejection with no returned ID is
    // eligible for a bounded delayed retry; quota and unknown outcomes stay review.
    const retryAfter = response.headers.get("Retry-After");
    let retryDelay = 120000;
    if (retryAfter) {
        const seconds = /^\d+$/.test(retryAfter) ? Number(retryAfter)*1000 : Date.parse(retryAfter)-Date.now();
        if (Number.isFinite(seconds)) retryDelay = Math.max(retryDelay, seconds);
    }
    const retrySafe = http_status === 429 && explicitFailure && exactRateCode && kind === "rate_limit" &&
        values.length === 0 && retryDelay <= 86400000;
    console.warn("[SCLOUD DRIVETOT] rejected or unconfirmed", {http_status,kind,shape,
        explicit_failure:explicitFailure,has_share_field:values.length>0,retry_safe:retrySafe});
    return {error:`Drivetot HTTP ${http_status}: ${kind}; ${retrySafe ? "rate-limit rejection" : "needs review"}`,
        kind,http_status,retrySafe,retryDelay};
}

export async function uploadToDrivetot(fileId, env, options = {}) {
    const apiKey = env.DRIVETOT_API_KEY;

    if (!apiKey) {
        throw new Error(
            "DRIVETOT_API_KEY Cloudflare Secret me nahi mila."
        );
    }

    if (!fileId) {
        throw new Error(
            "Drivetot upload ke liye Google Drive File ID missing hai."
        );
    }

    if (options.singleAttempt) return submitDrivetotOnce(fileId, apiKey, options);
    const maxRetries = 4;

    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {
        try {
            const targetUrl =
                `https://drivetot.website/v4/api/file/add/${encodeURIComponent(fileId)}?key=${encodeURIComponent(apiKey)}`;

            const response = await fetch(
                targetUrl,
                {
                    method: "GET",
                    ...(options.signal ? {signal: options.signal} : {}),
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    }
                }
            );

            const responseText =
                await response.text();

            let data;

            try {
                data = JSON.parse(responseText);
            } catch (e) {
                data = {
                    error: responseText
                };
            }

            const dataString =
                JSON.stringify(data);

            // --------------------------------------
            // SUCCESS
            // --------------------------------------

            if (data && data.share_id) {
                return data;
            }

            // --------------------------------------
            // QUOTA / RATE LIMIT
            // --------------------------------------

            if (
                dataString.includes(
                    "RATE_LIMIT_EXCEEDED"
                ) ||
                dataString
                    .toLowerCase()
                    .includes("quota")
            ) {
                console.log(
                    `Attempt ${attempt}: Quota limit hit. Waiting 7s for retry...`
                );

                if (attempt === maxRetries) {
                    throw new Error(
                        "Google Drive Quota Limit reached. Drivetot SAs are busy."
                    );
                }

                await sleep(7000);
                continue;
            }

            // --------------------------------------
            // OTHER FAILURE
            // --------------------------------------

            if (attempt === maxRetries) {
                return data;
            }

            console.log(
                `Attempt ${attempt}: Drivetot did not return share_id. Retrying in 5s...`
            );

            await sleep(5000);

        } catch (e) {

            console.log(
                `Drivetot attempt ${attempt} failed:`,
                e.message
            );

            if (attempt === maxRetries) {
                return {
                    error: e.message
                };
            }

            await sleep(5000);
        }
    }

    return {
        error: "Drivetot upload failed."
    };
}


// --------------------------------------------------
// EXTRACT HUBCLOUD / GDFLIX LINKS FROM DRIVETOT
// --------------------------------------------------

export async function extractLinksFromDrivetot(
    shareId,
    env,
    options = {}
) {
    if (!shareId) {
        return {
            error: "Drivetot Share ID missing!"
        };
    }

    const page1Url =
        `https://drivetot.website/${shareId}`;

    let gdflix_url = null;
    let hubcloud_url = null;

    const waitMs = Math.max(0, Math.min(15000, options.waitMs ?? 15000));
    if (waitMs) await sleep(waitMs);

    const headers = {
        "User-Agent":
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    };

    // ------------------------------------------------
    // STEP 1 - FETCH PAGE 1
    // ------------------------------------------------

    const res1 = await fetch(
        page1Url,
        {
            method: "GET",
            ...(options.signal ? {signal:options.signal} : {}),
            headers
        }
    );

    if (!res1.ok) {
        return {
            error:
                `Drivetot Page 1 HTTP ${res1.status}`
        };
    }

    const html1 = await res1.text();

    // Find /s/ redirect/action
    const sPageRegex =
        /<form[^>]+action=["']([^"']*\/s\/[^"']*)["']/i;

    const sMatch =
        html1.match(sPageRegex);

    // Find token
    const tokenRegex =
        /name=["']token["'][^>]+value=["']([^"']+)["']/i;

    const tokenMatch =
        html1.match(tokenRegex);

    if (!sMatch) {
        return {
            error:
                "Page 1 pe /s/ redirect link nahi mili!"
        };
    }

    const target = new URL(sMatch[1], page1Url);
    if (target.origin !== "https://drivetot.website" || !target.pathname.startsWith("/s/")) return {error:"Invalid Drivetot extraction target"};
    let page2Url = target.toString();

    // ------------------------------------------------
    // TOKEN ADD
    // ------------------------------------------------

    if (tokenMatch) {
        const token = tokenMatch[1];

        const separator =
            page2Url.includes("?")
                ? "&"
                : "?";

        page2Url +=
            `${separator}token=${encodeURIComponent(token)}`;
    }

    // ------------------------------------------------
    // STEP 2 - FETCH /s/ PAGE
    // ------------------------------------------------

    const res2 = await fetch(
        page2Url,
        {
            method: "GET",
            ...(options.signal ? {signal:options.signal} : {}),
            headers
        }
    );

    if (!res2.ok) {
        return {
            error:
                `Drivetot Page 2 HTTP ${res2.status}`
        };
    }

    const html2 = await res2.text();

    // ------------------------------------------------
    // FIND BASE64 SCANJS LINKS
    // ------------------------------------------------

    const b64Regex =
        /https:\/\/drivetot\.website\/scanjs\/([^"'>\s]+)/gi;

    let b64Match;
    let decodedCount = 0;

    while (
        (b64Match =
            b64Regex.exec(html2)) !== null
    ) {
        try {
            const encodedString =
                b64Match[1];

            const decodedUrl =
                robustBase64Decode(
                    encodedString
                );

            decodedCount++;

            const lowerUrl =
                decodedUrl.toLowerCase();

            // ----------------------------------------
            // GDFLIX
            // ----------------------------------------

            if (
                lowerUrl.includes("gdflix")
            ) {
                gdflix_url =
                    decodedUrl;
            }

            // ----------------------------------------
            // HUBCLOUD
            // ----------------------------------------

            if (
                lowerUrl.includes("hubcloud")
            ) {
                hubcloud_url =
                    decodedUrl;
            }

        } catch (e) {
            console.log(
                "Decode error on a link, skipping..."
            );
        }
    }

    console.log(
        `Drivetot decoded links: ${decodedCount}`
    );

    return {
        success: true,
        gdflix_url,
        hubcloud_url:
            hubcloud_url || "Not Found"
    };
}
