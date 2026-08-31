const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());
const app = express();
const PORT = process.env.PORT || 7860;

app.get('/', (req, res) => {
    res.send("S-Cloud Stealth Engine is Running (Ultra Optimized)!");
});

app.get('/bypass', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "URL is required (e.g., /bypass?url=...)" });

    let browser;
    try {
        console.log(`[*] Scraping started for: ${targetUrl}`);
        
        // RAM bachane ke liye ultimate flags (single-process hata diya)
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
        
        // RAM BACHANE KA MASTERSTROKE: Images aur Fonts ko block karna
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (req.resourceType() === 'image' || req.resourceType() === 'font' || req.resourceType() === 'media') {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setViewport({ width: 1280, height: 720 });
        
        console.log("[*] Page load ho raha hai (Without Images)...");
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
        
        console.log("[*] Waiting 8 seconds for Cloudflare Challenge...");
        await new Promise(r => setTimeout(r, 8000));
        
        const html = await page.content();
        
        const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a')).map(a => a.href);
        });

        console.log("[✔️] Scraping Successful!");
        res.json({
            status: "Success",
            target: targetUrl,
            html_length: html.length,
            extracted_links: links
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
