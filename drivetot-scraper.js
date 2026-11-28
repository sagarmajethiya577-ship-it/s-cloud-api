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

// Classify only an explicit negative provider response. A missing ID alone
// is not proof of rejection. Never log raw provider bodies or request URLs.
function durableDrivetotResult(response, data, parsed) {
    const status = response.status;
    const objects = [data, data?.data, data?.result].filter(x => x && typeof x === "object");
    const hasAcceptance = objects.some(x => x.share_id || x.id || x.download_url || x.url ||
        x.success === true || x.accepted === true || x.exists === true ||
        /^(success|ok|accepted|pending|processing|queued|created|completed)$/i.test(String(x.status || "")));
    if (response.ok && /^[A-Za-z0-9_-]{4,200}$/.test(String(data?.share_id || ""))) {
        return {share_id: String(data.share_id)};
    }
    const errors = objects.flatMap(x => [x.error, x.error?.code, x.error?.reason,
        x.error?.message, x.code, x.reason, x.message]).filter(x => typeof x === "string");
    const explicitlyRejected = parsed && objects.some(x => x.success === false ||
        /^(error|failed|failure|rejected)$/i.test(String(x.status || "")) ||
        (typeof x.error === "string" && x.error.trim().length > 0) ||
        (x.error && typeof x.error === "object"));
    const errorText = errors.join(" ");
    const rate = /RATE_LIMIT_EXCEEDED|rate[ _-]*limit[ _-]*exceeded|too many requests/i.test(errorText);
    const quota = /quota/i.test(errorText);
    const retryKind = !hasAcceptance && explicitlyRejected && (status === 200 || status === 403 || status === 429) && (rate || quota)
        ? (quota ? "quota" : "rate_limit") : null;
    return {failureKind: retryKind || "uncertain", httpStatus: status};
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

    const maxRetries = options.singleAttempt ? 1 : 4;

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

            options.onResponse?.(response);
            const responseText =
                await response.text();

            let data;
            let parsed = true;

            try {
                data = JSON.parse(responseText);
            } catch (e) {
                parsed = false;
                data = {
                    error: responseText
                };
            }

            if (options.singleAttempt) return durableDrivetotResult(response, data, parsed);

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
            if (options.singleAttempt) return {failureKind: "uncertain", httpStatus: null};

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

    options.onResponse?.(res1);
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

    options.onResponse?.(res2);
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
