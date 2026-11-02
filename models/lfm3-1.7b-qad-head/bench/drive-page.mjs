// Opens one bench page in headless Chromium (Playwright, GPU enabled through ANGLE's Metal backend) and prints its #out text
// when it says ALL DONE (or after the timeout).
// usage: node drive-page.mjs <url> [timeout minutes]     env: PW (path of playwright-core's index.js)
const pw = await import(process.env.PW ?? "playwright-core"); const chromium = pw.chromium ?? pw.default.chromium
const [url, minutes] = process.argv.slice(2)
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader=false", "--disable-background-timer-throttling"]
})
const page = await browser.newPage()
page.on("pageerror", (e) => console.log("PAGEERROR", String(e)))
await page.goto(url)
const sel = () => document.querySelector("pre")?.textContent ?? ""
try {
  await page.waitForFunction(() => /ALL DONE|renderer /.test(document.querySelector("pre")?.textContent ?? "") &&
    (document.querySelector("pre").textContent.includes("ALL DONE") || location.pathname.endsWith("gl-info.html")),
    null, { timeout: Number(minutes ?? 30) * 60000, polling: 1000 })
} catch (e) { console.log("TIMEOUT", String(e).slice(0, 200)) }
if (url.includes("gl-info.html")) await page.waitForTimeout(2000)
console.log(await page.evaluate(sel))
await browser.close()
