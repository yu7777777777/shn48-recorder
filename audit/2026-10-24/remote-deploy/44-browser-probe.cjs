// Open the official member page in the installed Chrome and record every
// network request, so we can see which backend actually serves the roster.
const { chromium } = require("/app/server/node_modules/playwright");

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const seen = [];
  page.on("response", (response) => {
    const url = response.url();
    const type = response.request().resourceType();
    if (["xhr", "fetch", "script", "document"].includes(type)) seen.push(`${response.status()} ${type} ${url.slice(0, 160)}`);
  });
  await page.goto("https://www.snh48.com/member_list.html", { waitUntil: "networkidle", timeout: 60000 }).catch(e => console.log("goto:", e.message));
  await page.waitForTimeout(4000);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 400).replace(/\s+/g, " "));
  console.log("page text head:", text);
  const names = await page.evaluate(() => {
    const items = [...document.querySelectorAll("[class*=member] img, [class*=member] a")];
    return items.length;
  });
  console.log("candidate member nodes:", names);
  console.log("--- network ---");
  for (const line of [...new Set(seen)]) console.log(line);
  await page.screenshot({ path: "/tmp/official.png", fullPage: false });
  await browser.close();
})();
