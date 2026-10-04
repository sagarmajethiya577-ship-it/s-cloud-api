// gdflix-scraper.js
// Auto-Retry + Multi-Key + BusyCDN + QuickFox Powered

const sleep = (ms) =>
    new Promise(resolve => setTimeout(resolve, ms));

const RETRY_DELAY_MS = 1000;

const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function extractGoogleLinks(html) {
    if (!html) {
        return [];
    }

    const links = [];

    const googleRegex =
        /https:\/\/[a-zA-Z0-9-]+\.googleusercontent\.com\/[^"'<>\s]+/gi;

    let match;

    while (
        (match = googleRegex.exec(html)) !== null
    ) {
        links.push(match[0]);
    }

    return [
        ...new Set(links)
    ];
}

function extractBusyCDNLinks(html) {
    if (!html) {
        return [];
    }

    const links = [];

    const regex =
        /href=["'](https:\/\/instant\.busycdn\.xyz\/[^"']*)["']/gi;

    let match;

    while (
        (match = regex.exec(html)) !== null
    ) {
        links.push(
            match[1]
        );
    }

    return [
        ...new Set(links)
    ];
}

function extractQuickFoxLinks(html) {
    if (!html) {
        return [];
    }

    const links = [];

    const regex =
        /href=["'](https:\/\/quick\.foxcloud\.rest\/\?[^"']*)["']/gi;

    let match;

    while (
        (match = regex.exec(html)) !== null
    ) {
        let link =
            match[1]
                .replace(
                    /&amp;/gi,
                    "&"
                );

        links.push(link);
    }

    return [
        ...new Set(links)
    ];
}

async function processBusyCDN(
    link,
    timer
) {
    console.log(
        `[FAST-TIMER] BUSYCDN START | elapsed=${Date.now() - timer}ms`
    );

    try {
        const busyRes =
            await fetch(
                link,
                {
                    method: "GET",
                    redirect: "follow",
                    headers: {
                        "User-Agent":
                            USER_AGENT
                    }
                }
            );

        let targetUrl =
            busyRes.url;

        console.log(
            `[FAST-TIMER] BUSYCDN RESPONSE | status=${busyRes.status} | elapsed=${Date.now() - timer}ms`
        );

        // --------------------------------------
        // FASTDL REDIRECT
        // --------------------------------------

        if (
            targetUrl.includes(
                "fastdl-one.pages.dev"
            )
        ) {
            try {
                const parsedUrl =
                    new URL(targetUrl);

                const realUrl =
                    parsedUrl.searchParams.get(
                        "url"
                    );

                if (
                    realUrl &&
                    realUrl.startsWith(
                        "http"
                    )
                ) {
                    console.log(
                        `[FAST-TIMER] BUSYCDN → FASTDL → REAL | elapsed=${Date.now() - timer}ms`
                    );

                    return realUrl;
                }

            } catch (error) {
                console.log(
                    "[FAST-TIMER] FastDL redirect parse failed:",
                    error.message
                );
            }
        }

        // --------------------------------------
        // DIRECT GOOGLE REDIRECT
        // --------------------------------------

        if (
            targetUrl.includes(
                "googleusercontent.com"
            )
        ) {
            console.log(
                `[FAST-TIMER] BUSYCDN → GOOGLE | elapsed=${Date.now() - timer}ms`
            );

            return targetUrl;
        }

        // --------------------------------------
        // READ RESPONSE HTML
        // --------------------------------------

        const busyHtml =
            await busyRes.text();

        // --------------------------------------
        // FASTDL URL INSIDE HTML
        // --------------------------------------

        const fastDlRegex =
            /https:\/\/fastdl-one\.pages\.dev\/\?url=([^"'<>\s]+)/i;

        const fastDlMatch =
            busyHtml.match(
                fastDlRegex
            );

        if (
            fastDlMatch &&
            fastDlMatch[1]
        ) {
            try {
                const realUrl =
                    decodeURIComponent(
                        fastDlMatch[1]
                    );

                if (
                    realUrl.startsWith(
                        "http"
                    )
                ) {
                    console.log(
                        `[FAST-TIMER] BUSYCDN HTML → FASTDL → REAL | elapsed=${Date.now() - timer}ms`
                    );

                    return realUrl;
                }

            } catch (error) {
                console.log(
                    "[FAST-TIMER] FastDL HTML decode failed:",
                    error.message
                );
            }
        }

        // --------------------------------------
        // DIRECT GOOGLE URL INSIDE HTML
        // --------------------------------------

        const googleLinks =
            extractGoogleLinks(
                busyHtml
            );

        if (
            googleLinks.length > 0
        ) {
            console.log(
                `[FAST-TIMER] BUSYCDN HTML → GOOGLE | elapsed=${Date.now() - timer}ms`
            );

            return googleLinks[0];
        }

        console.log(
            `[FAST-TIMER] BUSYCDN NO FINAL LINK | elapsed=${Date.now() - timer}ms`
        );

        return targetUrl;

    } catch (error) {

        console.log(
            "[FAST-TIMER] BUSYCDN FAILED:",
            error.message
        );

        return link;
    }
}

async function processQuickFox(
    quickFoxUrl,
    timer
) {
    console.log(
        `[FAST-TIMER] QUICKFOX START | elapsed=${Date.now() - timer}ms`
    );

    try {
        const parsedUrl =
            new URL(
                quickFoxUrl
            );

        const token =
            parsedUrl.searchParams.get(
                "url"
            );

        if (!token) {
            console.log(
                "[FAST-TIMER] QUICKFOX token missing."
            );

            return null;
        }

        // --------------------------------------
        // QUICKFOX DIRECT UPLOAD ENDPOINT
        // --------------------------------------
        //
        // Instead of opening:
        //
        // quick.foxcloud.rest/?url=TOKEN
        //
        // which waits for JavaScript redirect,
        // directly request:
        //
        // quick.foxcloud.rest/upload?url=TOKEN
        //
        // --------------------------------------

        const uploadUrl =
            `https://quick.foxcloud.rest/upload?url=${encodeURIComponent(token)}`;

        console.log(
            `[FAST-TIMER] QUICKFOX /upload START | elapsed=${Date.now() - timer}ms`
        );

        const uploadRes =
            await fetch(
                uploadUrl,
                {
                    method: "GET",
                    redirect: "follow",
                    headers: {
                        "User-Agent":
                            USER_AGENT,
                        "Accept":
                            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                    }
                }
            );

        console.log(
            `[FAST-TIMER] QUICKFOX /upload RESPONSE | status=${uploadRes.status} | elapsed=${Date.now() - timer}ms`
        );

        if (!uploadRes.ok) {
            const errorText =
                await uploadRes.text();

            console.log(
                `[FAST-TIMER] QUICKFOX /upload FAILED | status=${uploadRes.status} | body=${errorText.slice(0, 300)}`
            );

            return null;
        }

        const uploadHtml =
            await uploadRes.text();

        // --------------------------------------
        // FINAL GOOGLE URL
        // --------------------------------------

        const googleLinks =
            extractGoogleLinks(
                uploadHtml
            );

        if (
            googleLinks.length > 0
        ) {
            console.log(
                `[FAST-TIMER] QUICKFOX → GOOGLE SUCCESS | elapsed=${Date.now() - timer}ms`
            );

            return googleLinks[0];
        }

        console.log(
            `[FAST-TIMER] QUICKFOX → GOOGLE NOT FOUND | elapsed=${Date.now() - timer}ms`
        );

        return null;

    } catch (error) {

        console.log(
            "[FAST-TIMER] QUICKFOX FAILED:",
            error.message
        );

        return null;
    }
}

export async function bypassGDFlix(
    gdflixUrl,
    env
) {
    const scraperStartedAt =
        Date.now();

    if (!gdflixUrl) {
        throw new Error(
            "GDFlix URL missing."
        );
    }

    console.log(
        `[FAST-TIMER] START | GDFlix=${gdflixUrl}`
    );

    const saKeysString =
        env && env.SA_KEYS
            ? env.SA_KEYS
            : "";

    const saKeys =
        saKeysString
            .split(",")
            .map(
                key => key.trim()
            )
            .filter(
                key => key.length > 0
            );

    if (
        saKeys.length === 0
    ) {
        throw new Error(
            "Cloudflare Secrets me SA_KEYS variable nahi mila!"
        );
    }

    const encodedUrl =
        encodeURIComponent(
            gdflixUrl
        );

    let busyLinks = [];
    let quickFoxLinks = [];

    const maxRetries = 3;

    // ==========================================
    // SCRAPINGANT / GDFLIX HTML
    // ==========================================

    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {
        const API_KEY =
            saKeys[
                Math.floor(
                    Math.random() *
                    saKeys.length
                )
            ];

        const saUrl =
            `https://api.scrapingant.com/v2/general?url=${encodedUrl}&browser=true`;

        const attemptStartedAt =
            Date.now();

        console.log(
            `[FAST-TIMER] SCRAPINGANT attempt=${attempt} START | total=${Date.now() - scraperStartedAt}ms`
        );

        try {
            const response =
                await fetch(
                    saUrl,
                    {
                        method: "GET",
                        headers: {
                            "x-api-key":
                                API_KEY,
                            "accept":
                                "text/html, application/xhtml+xml, application/xml;q=0.9,*/*;q=0.8",
                            "User-Agent":
                                USER_AGENT
                        }
                    }
                );

            const attemptElapsed =
                Date.now() -
                attemptStartedAt;

            console.log(
                `[FAST-TIMER] SCRAPINGANT attempt=${attempt} RESPONSE | status=${response.status} | elapsed=${attemptElapsed}ms | total=${Date.now() - scraperStartedAt}ms`
            );

            if (!response.ok) {
                const errText =
                    await response.text();

                if (
                    response.status === 409 ||
                    response.status === 429
                ) {
                    if (
                        attempt ===
                        maxRetries
                    ) {
                        throw new Error(
                            `ScrapingAnt API Reject (${response.status}): ${errText}`
                        );
                    }

                    console.log(
                        `[FAST-TIMER] RETRY WAIT ${RETRY_DELAY_MS}ms | attempt=${attempt}`
                    );

                    await sleep(
                        RETRY_DELAY_MS
                    );

                    continue;
                }

                throw new Error(
                    `ScrapingAnt API Reject (${response.status}): ${errText}`
                );
            }

            const html =
                await response.text();

            console.log(
                `[FAST-TIMER] GDFLIX HTML RECEIVED | bytes=${html.length} | total=${Date.now() - scraperStartedAt}ms`
            );

            // ----------------------------------
            // BUSYCDN
            // ----------------------------------

            busyLinks =
                extractBusyCDNLinks(
                    html
                );

            // ----------------------------------
            // QUICKFOX
            // ----------------------------------

            quickFoxLinks =
                extractQuickFoxLinks(
                    html
                );

            console.log(
                `[FAST-TIMER] LINKS FOUND | busycdn=${busyLinks.length} | quickfox=${quickFoxLinks.length} | total=${Date.now() - scraperStartedAt}ms`
            );

            // ----------------------------------
            // SUCCESS
            // ----------------------------------

            if (
                busyLinks.length > 0 ||
                quickFoxLinks.length > 0
            ) {
                break;
            }

            console.log(
                `[FAST-TIMER] NO BUSYCDN/QUICKFOX | attempt=${attempt}`
            );

            if (
                attempt <
                maxRetries
            ) {
                console.log(
                    `[FAST-TIMER] RETRY WAIT ${RETRY_DELAY_MS}ms`
                );

                await sleep(
                    RETRY_DELAY_MS
                );
            }

        } catch (error) {

            console.log(
                `[FAST-TIMER] SCRAPINGANT attempt=${attempt} FAILED | ${error.message} | total=${Date.now() - scraperStartedAt}ms`
            );

            if (
                attempt ===
                maxRetries
            ) {
                throw new Error(
                    error.message
                );
            }

            console.log(
                `[FAST-TIMER] RETRY WAIT ${RETRY_DELAY_MS}ms`
            );

            await sleep(
                RETRY_DELAY_MS
            );
        }
    }

    busyLinks =
        [
            ...new Set(
                busyLinks
            )
        ];

    quickFoxLinks =
        [
            ...new Set(
                quickFoxLinks
            )
        ];

    if (
        busyLinks.length === 0 &&
        quickFoxLinks.length === 0
    ) {
        throw new Error(
            "ScrapingAnt ko BusyCDN ya QuickFox links nahi mile."
        );
    }

    console.log(
        `[FAST-TIMER] PARSE COMPLETE | busycdn=${busyLinks.length} | quickfox=${quickFoxLinks.length} | total=${Date.now() - scraperStartedAt}ms`
    );

    // ==========================================
    // PROCESS BUSYCDN + QUICKFOX
    // ==========================================

    let finalGoogleLinks = [];

    // ------------------------------------------
    // BUSYCDN
    // ------------------------------------------

    for (
        const link of busyLinks
    ) {
        const result =
            await processBusyCDN(
                link,
                scraperStartedAt
            );

        if (
            result &&
            result.startsWith(
                "http"
            )
        ) {
            finalGoogleLinks.push(
                result
            );
        }
    }

    // ------------------------------------------
    // QUICKFOX
    // ------------------------------------------

    for (
        const link of quickFoxLinks
    ) {
        const result =
            await processQuickFox(
                link,
                scraperStartedAt
            );

        if (
            result &&
            result.startsWith(
                "http"
            )
        ) {
            finalGoogleLinks.push(
                result
            );
        }
    }

    // ==========================================
    // CLEAN URL WRAPPERS
    // ==========================================

    const cleanedLinks =
        finalGoogleLinks.map(
            link => {
                let current =
                    link;

                while (
                    current.includes(
                        "?url="
                    ) ||
                    current.includes(
                        "&url="
                    )
                ) {
                    try {
                        const parts =
                            current.split(
                                /[?&]url=/
                            );

                        if (
                            parts.length >
                            1
                        ) {
                            current =
                                decodeURIComponent(
                                    parts[1]
                                );
                        } else {
                            break;
                        }

                    } catch (error) {
                        break;
                    }
                }

                return current;
            }
        );

    const uniqueLinks =
        [
            ...new Set(
                cleanedLinks
            )
        ];

    console.log(
        `[FAST-TIMER] COMPLETE | links=${uniqueLinks.length} | total=${Date.now() - scraperStartedAt}ms`
    );

    if (
        uniqueLinks.length === 0
    ) {
        throw new Error(
            "BusyCDN/QuickFox se final download link nahi mili."
        );
    }

    return uniqueLinks;
}
