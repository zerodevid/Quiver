// Cuplikan cepat beberapa halaman dengan sensor aktif — untuk memeriksa hasil sensor.
//   QBASE=… QTOKEN=… QLANG=en node shots.mjs summary,positions,targets
import { chromium } from 'playwright-core';
import { BASE, buildMask, attach, censorScript, leakCheck } from './privacy.mjs';
import { EXE } from './capture.mjs';
const mask = await buildMask();
const b = await chromium.launch({ executablePath: EXE });
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' });
ctx.setDefaultNavigationTimeout(120000);
await attach(ctx, mask); await ctx.addInitScript(censorScript(mask.pseudonyms));
await ctx.addInitScript((l) => { try { localStorage.setItem('lpcopy-lang', l); localStorage.setItem('lpcopy-theme', 'dark'); } catch {} }, process.env.QLANG || 'en');
const p = await ctx.newPage();
for (const h of (process.argv[2] || 'summary').split(',')) {
  await p.goto(BASE + '/#' + h, { waitUntil: 'commit' }); await p.waitForTimeout(h === 'summary' ? 7000 : 4000);
  if (h === 'detail') { await p.goto(BASE + '/#summary'); await p.waitForTimeout(6000); await p.locator('tbody tr').first().click(); await p.waitForTimeout(3000); await p.locator('[role=dialog] button:has-text("Detail page")').click(); await p.waitForTimeout(7000); }
  if (h === 'drawer') { await p.goto(BASE + '/#summary'); await p.waitForTimeout(6000); await p.locator('tbody tr').first().click(); await p.waitForTimeout(4000); }
  await p.screenshot({ path: `out/shot-${h}.png`, fullPage: h !== 'drawer' });
  console.log(h, 'leaks:', (await leakCheck(p, mask.secrets)).length);
}
await b.close();
