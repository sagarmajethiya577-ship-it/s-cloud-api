// gdflix-scraper.js
// Auto-Retry & Multi-Key Powered

const sleep = (ms) =>
    new Promise(resolve => setTimeout(resolve, ms));


// --------------------------------------------------
// GDFLIX BYPASS
// --------------------------------------------------

export async function bypassGDFlix(
    gdflixUrl,
    env
) {
    if (!gdflixUrl) {
        throw new Error(
            "GDFlix URL missing."
        );
    }

    // ----------------------------------------------
    // MULTIPLE SCRAPINGANT API KEYS
    // ----------------------------------------------

    const saKeysString =
        env && env.SA_KEYS
            ? env.SA_KEYS
            : "";

    const saKeys =
        saKeysString
            .split(",")
            .map(key => key.trim())
            .filter(
                key => key.length > 0
            );

    if (saKeys.length === 0) {
        throw new Error(
            "Cloudflare Secrets me SA_KEYS variable nahi mila!"
        );
    }

    const encodedUrl =
        encodeURIComponent(gdflixUrl);

    let fastLinks = [];

    // ----------------------------------------------
    // MAX RETRIES
    // ----------------------------------------------

    const maxRetries = 3;

    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {
        // Har attempt par random API key
        const API_KEY =
            saKeys[
                Math.floor(
                    Math.random() *
                    saKeys.length
                )
            ];

        const saUrl =
            `https://api.scrapingant.com/v2/general?url=${encodedUrl}&browser=true`;

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
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                        }
                    }
                );

            // --------------------------------------
            // API ERROR
            // --------------------------------------

            if (!response.ok) {
                const errText =
                    await response.text();

                // 409 / 429 = retry
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
                        `Attempt ${attempt} failed (${response.status}). Waiting 2s before retry...`
                    );

                    await sleep(2000);

                    continue;
                }

                throw new Error(
                    `ScrapingAnt API Reject (${response.status}): ${errText}`
                );
            }

            // --------------------------------------
            // READ HTML
            // --------------------------------------

            const html =
                await response.text();

            // --------------------------------------
            // FIND FAST LINKS
            // --------------------------------------

            const regex =
                /href=["'](https:\/\/[^"']*(?:busycdn\.xyz|filesgram\.xyz|filebee\.xyz|gdflix\.io\/cloud)[^"']*)["']/gi;

            let match;

            while (
                (match =
                    regex.exec(html)) !== null
            ) {
                fastLinks.push(
                    match[1]
                );
            }

            // --------------------------------------
            // IF FOUND, STOP RETRY
            // --------------------------------------

            if (
                fastLinks.length > 0
            ) {
                break;
            }

            console.log(
                `Attempt ${attempt}: GDFlix page loaded but fast links not found.`
            );

            if (
                attempt <
                maxRetries
            ) {
                await sleep(2000);
            }

        } catch (error) {

            console.log(
                `GDFlix scraping attempt ${attempt} failed:`,
                error.message
            );

            if (
                attempt ===
                maxRetries
            ) {
                throw new Error(
                    error.message
                );
            }

            await sleep(2000);
        }
    }

    // Remove duplicates
    fastLinks =
        [...new Set(fastLinks)];

    // ----------------------------------------------
    // NO LINKS
    // ----------------------------------------------

    if (
        fastLinks.length === 0
    ) {
        throw new Error(
            "ScrapingAnt ko fast links nahi mili."
        );
    }

    // ----------------------------------------------
    // FOLLOW FAST LINKS
    // ----------------------------------------------

    let finalGoogleLinks = [];

    for (
        const link of fastLinks
    ) {
        try {
            const busyRes =
                await fetch(
                    link,
                    {
                        method: "GET",
                        redirect: "follow",
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                        }
                    }
                );

            let targetUrl =
                busyRes.url;

            // --------------------------------------
            // DIRECT GOOGLE CONTENT URL
            // --------------------------------------

            if (
                targetUrl.includes(
                    "googleusercontent.com"
                )
            ) {
                finalGoogleLinks.push(
                    targetUrl
                );

                continue;
            }

            // --------------------------------------
            // READ REDIRECT PAGE
            // --------------------------------------

            const busyHtml =
                await busyRes.text();

            const googleRegex =
                /(https:\/\/[a-zA-Z0-9-]+\.googleusercontent\.com\/[^"'<>\s]+)/i;

            const googleMatch =
                busyHtml.match(
                    googleRegex
                );

            if (
                googleMatch &&
                googleMatch[1]
            ) {
                finalGoogleLinks.push(
                    googleMatch[1]
                );
            } else {
                finalGoogleLinks.push(
                    targetUrl
                );
            }

        } catch (e) {

            console.log(
                "Fast link follow failed:",
                e.message
            );

            // Original link preserve
            finalGoogleLinks.push(
                link
            );
        }
    }

    // ----------------------------------------------
    // ROBUST URL UNWRAPPER
    // ----------------------------------------------

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

                    } catch (e) {
                        break;
                    }
                }

                return current;
            }
        );

    // ----------------------------------------------
    // FINAL UNIQUE LINKS
    // ----------------------------------------------

    return [
        ...new Set(
            cleanedLinks
        )
    ];
}
