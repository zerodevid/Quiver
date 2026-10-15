// Deterministic frame renderer for the promo scene.
//   node render.mjs stills 1.5,5,8   -> out/stills/t-<sec>.png
//   node render.mjs video            -> out/frames/%05d.jpg (30 fps)
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const [mode = "stills", arg = ""] = process.argv.slice(2);
const FPS = 30;
const out = join(here, "out");

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = join(os.homedir(), "Library/Caches/ms-playwright");
  const dir = readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
  const sub = readdirSync(join(base, dir)).find((d) => d.startsWith("chrome-headless-shell"));
  return join(base, dir, sub, "chrome-headless-shell");
}

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL(join(here, "scene.html")).href);
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);

if (mode === "stills") {
  const dir = join(out, "stills");
  mkdirSync(dir, { recursive: true });
  for (const s of arg.split(",").filter(Boolean)) {
    await page.evaluate((t) => window.renderAt(t), Number(s));
    await page.screenshot({ path: join(dir, `t-${Number(s).toFixed(2)}.png`) });
  }
} else {
  const dir = join(out, "frames");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const n = Math.round(duration * FPS);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.renderAt(t), i / FPS);
    await page.screenshot({ path: join(dir, `${String(i).padStart(5, "0")}.jpg`), type: "jpeg", quality: 94 });
    if (i % 60 === 0) console.log(`frame ${i}/${n}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
await browser.close();
