// High-resolution captures of the REAL dashboard UI for the promo video.
// Data goes through demo/privacy.mjs (addresses/labels replaced, money scaled) before it reaches the browser;
// the blur layer is not installed because nothing real ever enters the DOM.
//   cd demo && QBASE=http://127.0.0.1:8799 QTOKEN=promo node promo/shots.mjs
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { BASE, buildMask, attach, leakCheck } from "../privacy.mjs";

const base = join(os.homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
const exe = join(base, dir, readdirSync(join(base, dir)).find((d) => d.startsWith("chrome-headless-shell")), "chrome-headless-shell");

const OUT = "promo/assets/ui";
mkdirSync(OUT, { recursive: true });
const mask = await buildMask();
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: "dark" });
ctx.setDefaultNavigationTimeout(120000);
await attach(ctx, mask);
await ctx.addInitScript(() => { try { localStorage.setItem("lpcopy-lang", "en"); localStorage.setItem("lpcopy-theme", "dark"); } catch {} });
const page = await ctx.newPage();

const shots = [
  ["summary", "summary", 7000, 0],
  ["summary-positions", "summary", 7000, 700],
  ["positions", "positions", 5000, 0],
  ["targets", "targets", 5000, 0],
  ["activity", "activity", 5000, 0],
];
for (const [name, hash, wait, scrollY] of shots) {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: "commit" });
  await page.waitForTimeout(wait);
  // The cache was recorded weeks ago; rewrite the stale relative times so the UI reads as live.
  await page.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const fix = [[/updated 22\.0 days ago/g, "updated 8 s ago"], [/22\.0 days ago/g, "just now"]];
    for (let n = w.nextNode(); n; n = w.nextNode()) for (const [re, to] of fix) if (re.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(re, to);
  });
  if (scrollY) { await page.evaluate((y) => window.scrollTo(0, y), scrollY); await page.waitForTimeout(600); }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, "leaks:", (await leakCheck(page, mask.secrets)).length);
}
await browser.close();
