const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());
const app = express();
const PORT = process.env.PORT || 7860;

app.get('/', (req, res) => {
    res.send("S-Cloud Stealth Engine is Running (Speed Optimized)!");
});

app.get('/bypass', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "URL is required" });

    let browser;
    try {
        console.log(`[*] Scraping started for: ${targetUrl}`);
        
        browser = await puppeteer.launch({
            headless: true, 
            executablePath: '/usr/bin/google-chrome',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--disable-accelerated-2d-canvas',
                '--disable-software-rasterizer',
                '--mute-audio'
            ]
        });
        
        const page = await browser.newPage();
        
        // RAM bachane ke liye Images/Media block
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        console.log("[*] Page load ho raha hai...");
        
        // Timeout kam kiya, aur seedha DOM load hote hi aage badhega
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // SMART WAIT: Ab hum fixed 8 seconds wait nahi karenge. 
        // Hum code ko bolenge: "Jaise hi busycdn ya filesgram link aaye, waise hi ruk jao!"
        try {
            await page.waitForFunction(
                () => {
                    const links = Array.from(document.querySelectorAll('a')).map(a => a.href);
                    return links.some(l => l.includes('busycdn') || l.includes('filesgram') || l.includes('cloud'));
                },
                { timeout: 15000 } // Maximum 15 second wait karega, par agar link 1 second me aayi toh 1 second me hi aage badh jayega
            );
        } catch (e) {
            console.log("[-] Fast links didn't appear quickly, checking anyway...");
        }
        
        // Saari links nikal kar filter karna (Sirf kaam ki links bhejna)
        const allLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a')).map(a => a.href);
        });

        const fastLinks = allLinks.filter(link => 
            link.includes('busycdn') || 
            link.includes('filesgram') || 
            link.includes('gdflix.io/cloud/')
        );

        console.log(`[✔️] Scraping Done! Found ${fastLinks.length} Fast Links.`);
        res.json({
            status: "Success",
            target: targetUrl,
            download_links: fastLinks // Ab sirf main links aayengi, kachra nahi
        });

    } catch (err) {
        console.error("[X] Error:", err.message);
        res.status(500).json({ status: "Error", message: err.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Stealth API listening on port ${PORT}`);
});
