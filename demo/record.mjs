// Perekam adegan aplikasi Quiver.
//   QTOKEN=… QLANG=en node record.mjs  -> out/app-<lang>.mp4 + out/timeline-<lang>.json
//
// Kit sutradara disuntik ke halaman: kamera (zoom #root), kursor macOS dengan
// lintasan melengkung, spotlight, subtitle per kata, kartu bab. Setiap adegan
// menunggu narasinya (out/vo-<lang>.json) selesai sebelum lanjut, jadi VO dan
// gambar selalu sinkron. Semua kejadian dicatat ke timeline untuk SFX & SRT.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { EXE, sleep, startCapture, framesToMp4 } from './capture.mjs';
import { BASE, buildMask, attach, censorScript, leakCheck } from './privacy.mjs';
import { COPY } from './copy.mjs';
import { TOK } from './studio.mjs';

const LANG = process.env.QLANG || 'en';
const C = COPY[LANG];
const W = 1440, H = 810, DSF = 4 / 3;          // keluaran 1920×1080
const OUT = path.resolve('out');
const VO = fs.existsSync(path.join(OUT, `vo-${LANG}.json`)) ? JSON.parse(fs.readFileSync(path.join(OUT, `vo-${LANG}.json`), 'utf8')) : {};
const T = (id, en) => (LANG === 'en' ? en : id); // teks UI untuk selektor

// ───────────────────────── kit di dalam halaman ─────────────────────────
const director = (TOK) => {
  if (window.top !== window) return;
  const css = `
  #qd{position:fixed;inset:0;pointer-events:none;z-index:2147483646;font-family:Inter,ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:-.011em}
  #qd-spot{position:absolute;left:0;top:0;width:0;height:0;border-radius:10px;opacity:0;
    box-shadow:0 0 0 1.5px ${TOK.accent},0 0 0 4000px rgba(0,0,0,.52);
    transition:left .7s cubic-bezier(.65,0,.35,1),top .7s cubic-bezier(.65,0,.35,1),width .7s cubic-bezier(.65,0,.35,1),height .7s cubic-bezier(.65,0,.35,1),opacity .5s ease}
  #qd-cap{position:absolute;left:50%;bottom:28px;transform:translate(-50%,10px);max-width:1080px;padding:12px 20px 14px;border-radius:10px;
    background:rgba(18,18,21,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid ${TOK.border};
    color:#fff;opacity:0;transition:opacity .4s ease,transform .5s cubic-bezier(.2,.8,.2,1);text-align:left}
  #qd-cap.on{opacity:1;transform:translate(-50%,0)}
  #qd-cap .k{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${TOK.accent};margin-bottom:4px}
  #qd-cap .t{font-size:19px;line-height:1.4;font-weight:500;white-space:nowrap}
  #qd-cap .t span{display:inline-block;opacity:0;transform:translateY(6px);transition:opacity .4s ease,transform .5s cubic-bezier(.2,.8,.2,1)}
  #qd-cap.on .t span{opacity:1;transform:none}
  #qd-ch{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;opacity:0;
    background:rgba(12,12,14,0);backdrop-filter:blur(0);-webkit-backdrop-filter:blur(0);transition:all .55s ease}
  #qd-ch.on{opacity:1;background:rgba(12,12,14,.78);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
  #qd-ch .n{font-size:14px;font-weight:600;letter-spacing:.08em;color:${TOK.accent};margin-bottom:14px;opacity:0;transition:opacity .5s ease .1s}
  #qd-ch .h{font-size:50px;font-weight:600;letter-spacing:-.032em;color:#fff;opacity:0;transform:translateY(14px);transition:all .6s cubic-bezier(.2,.8,.2,1) .12s}
  #qd-ch .s{margin-top:10px;font-size:20px;color:${TOK.muted};opacity:0;transform:translateY(10px);transition:all .6s cubic-bezier(.2,.8,.2,1) .28s}
  #qd-ch.on .n,#qd-ch.on .h,#qd-ch.on .s{opacity:1;transform:none}
  #qd-cur{position:absolute;left:0;top:0;width:26px;height:26px;transform:translate3d(-60px,-60px,0);z-index:3;transition:opacity .3s ease}
  #qd-cur .in{width:100%;height:100%;transform-origin:5px 3px;transition:transform .1s ease}
  #qd-cur.down .in{transform:scale(.85)}
  #qd-cur svg{position:absolute;inset:0;width:26px;height:26px;filter:drop-shadow(0 1.5px 2px rgba(0,0,0,.45))}
  #qd-cur .hand{opacity:0}#qd-cur.ptr .hand{opacity:1}#qd-cur.ptr .arrow{opacity:0}
  #qd-cur.hide{opacity:0}
  #qd-rip{position:absolute;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;opacity:0;border:1.5px solid ${TOK.accent}}
  #qd-rip.go{animation:qdr .5s cubic-bezier(.2,.8,.2,1)}
  @keyframes qdr{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(1.3)}}
  html.qd-theme *,html.qd-theme *::before{transition:background-color .6s ease,border-color .6s ease,color .6s ease,fill .6s ease!important}
  #root{transform-origin:0 0;will-change:transform}`;
  const ARROW = `<svg class="arrow" viewBox="0 0 28 28"><path d="M6 3.5v18.2l4.6-4.4 3 7 3.2-1.4-3-6.8h6.4z" fill="#0b0b0f" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  const HAND = `<svg class="hand" viewBox="0 0 28 28"><path d="M10.5 13V5.8a1.7 1.7 0 013.4 0V12m0-1.2a1.7 1.7 0 013.4 0V13m0-1a1.7 1.7 0 013.4 0v1.4m0-.3a1.7 1.7 0 013.1 1v4.6c0 4.2-2.9 7.3-7 7.3h-1.3c-2.4 0-4-1-5.3-2.8l-3.9-5.6a1.8 1.8 0 012.8-2.2l2 2.3V13" fill="#fff" stroke="#0b0b0f" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  const mount = () => {
    if (document.getElementById('qd')) return;
    const st = document.createElement('style'); st.textContent = css; document.documentElement.appendChild(st);
    const o = document.createElement('div'); o.id = 'qd';
    o.innerHTML = `<div id="qd-spot"></div><div id="qd-ch"><div class="n"></div><div class="h"></div><div class="s"></div></div>
      <div id="qd-cap"><div class="k"></div><div class="t"></div></div><div id="qd-rip"></div>
      <div id="qd-cur" class="hide"><div class="in">${ARROW}${HAND}</div></div>`;
    document.documentElement.appendChild(o);
    const $ = (s) => o.querySelector(s);
    const cur = $('#qd-cur'), rip = $('#qd-rip');
    addEventListener('mousemove', (e) => {
      cur.style.transform = `translate3d(${e.clientX - 6}px,${e.clientY - 3.5}px,0)`;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      let ptr = false;
      try { ptr = !!el && (getComputedStyle(el).cursor === 'pointer' || !!el.closest('a,button,[role=button],[role=radio],[role=switch],label')); } catch {}
      cur.classList.toggle('ptr', ptr);
    }, true);
    addEventListener('mousedown', (e) => { cur.classList.add('down'); rip.style.left = e.clientX + 'px'; rip.style.top = e.clientY + 'px'; rip.classList.remove('go'); void rip.offsetWidth; rip.classList.add('go'); }, true);
    addEventListener('mouseup', () => cur.classList.remove('down'), true);
    window.qd = {
      cursor(show) { cur.classList.toggle('hide', !show); },
      spot(r) {
        const s = $('#qd-spot');
        if (!r) { s.style.opacity = '0'; return; }
        const first = s.style.opacity !== '1';
        if (first) s.style.transition = 'none';
        Object.assign(s.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        if (first) { void s.offsetWidth; s.style.transition = ''; }
        s.style.opacity = '1';
      },
      caption(k, t) {
        const c = $('#qd-cap');
        if (!k) { c.classList.remove('on'); return; }
        const set = () => {
          c.querySelector('.k').textContent = k;
          c.querySelector('.t').innerHTML = t.split(' ').map((w, i) => `<span style="transition-delay:${(0.1 + i * 0.03).toFixed(3)}s">${w.replace(/</g, '&lt;')}</span>`).join(' ');
          void c.offsetWidth; c.classList.add('on');
        };
        if (c.classList.contains('on')) { c.classList.remove('on'); setTimeout(set, 360); } else set();
      },
      chapter(n, h, s) {
        const ch = $('#qd-ch');
        if (!n) { ch.classList.remove('on'); return; }
        ch.querySelector('.n').textContent = n; ch.querySelector('.h').textContent = h; ch.querySelector('.s').textContent = s;
        void ch.offsetWidth; ch.classList.add('on');
      },
      // Kamera: skala #root di titik asal O; fokus P digeser 55% ke tengah, O dijepit agar tepi halaman tak terlihat.
      zoom(x, y, s, ms = 1100, keep) {
        const r = document.getElementById('root'); if (!r) return;
        const ease = 'cubic-bezier(.65,0,.35,1)';
        if (s <= 1) { r.style.transition = `transform ${ms}ms ${ease}`; r.style.transform = 'none'; return; }
        const W = innerWidth, H = innerHeight;
        const qx = x + (W / 2 - x) * 0.55, qy = y + (H / 2 - y) * 0.55;
        let ox = Math.min(W, Math.max(0, (qx - s * x) / (1 - s)));
        let oy = Math.min(H, Math.max(0, (qy - s * y) / (1 - s)));
        // tepi layar setelah zoom = O(1-1/s) … O(1-1/s)+W/s; jaga kotak `keep` tetap utuh terlihat
        if (keep) {
          const k = 1 - 1 / s, pad = 18;
          const clamp = (o, lo, hi, span) => { const a = (hi + pad - span) / k, b = (lo - pad) / k; return a > b ? (a + b) / 2 : Math.min(b, Math.max(a, o)); };
          ox = Math.min(W, Math.max(0, clamp(ox, keep.x, keep.x + keep.w, W / s)));
          oy = Math.min(H, Math.max(0, clamp(oy, keep.y, keep.y + keep.h, H / s)));
        }
        const base = r.getBoundingClientRect();
        r.style.transition = 'none';
        r.style.transformOrigin = `${ox - base.left}px ${oy - base.top}px`;
        void r.offsetWidth;
        r.style.transition = `transform ${ms}ms ${ease}`;
        r.style.transform = `scale(${s})`;
      },
      themeAnim(on) { document.documentElement.classList.toggle('qd-theme', on); },
    };
  };
  if (document.documentElement) mount();
  else new MutationObserver((_, mo) => { if (document.documentElement) { mo.disconnect(); mount(); } }).observe(document, { childList: true });
};

// ───────────────────────── helper sutradara ─────────────────────────
let page, t0;
let mx = W * 0.62, my = H * 0.58, bendSign = 1, zoomed = false, spotOn = false;
const tl = { clicks: [], whoosh: [], pops: [], captions: [], vo: [] };
const at = () => Date.now() / 1000 - t0;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const qd = (fn, ...a) => page.evaluate(([fn, a]) => window.qd?.[fn](...a), [fn, a]).catch((e) => console.warn('  qd', fn, String(e.message).split('\n')[0]));

async function glide(x, y, ms) {
  const sx = mx, sy = my, dx = x - sx, dy = y - sy, d = Math.hypot(dx, dy);
  if (d < 3) return;
  ms ??= Math.min(1100, Math.max(450, 300 + d * 0.55));
  bendSign = -bendSign;
  const bend = Math.min(70, d * 0.12) * bendSign;
  const cx = sx + dx / 2 - (dy / d) * bend, cy = sy + dy / 2 + (dx / d) * bend;
  const n = Math.max(14, Math.round(ms / 16)), start = Date.now();
  for (let i = 1; i <= n; i++) {
    const t = ease(i / n), u = 1 - t;
    await page.mouse.move(u * u * sx + 2 * u * t * cx + t * t * x, u * u * sy + 2 * u * t * cy + t * t * y);
    const wait = start + (ms * i) / n - Date.now(); if (wait > 0) await sleep(wait);
  }
  mx = x; my = y;
}
// Target: selektor Playwright, Locator, atau { text, minW, minH, nth, prefix } (naik ke leluhur sampai cukup besar)
async function rect(target) {
  if (target && typeof target === 'object' && 'text' in target) {
    return page.evaluate(({ text, minW = 0, minH = 0, nth = 0, prefix }) => {
      const hits = [...document.querySelectorAll('#root *')].filter((e) => {
        if (e.children.length) return false;
        const s = (e.textContent || '').trim();
        return (prefix ? s.startsWith(text) : s === text) && e.getClientRects().length;
      });
      let el = hits[nth]; if (!el) return null;
      while (el.parentElement && el.parentElement.id !== 'root') {
        const r = el.getBoundingClientRect();
        if (r.width >= minW && r.height >= minH) break;
        el = el.parentElement;
      }
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, target);
  }
  if (target && typeof target === 'object' && 'sel' in target) {
    return page.evaluate(({ sel, minW = 0, minH = 0, nth = 0 }) => {
      let el = document.querySelectorAll(sel)[nth]; if (!el) return null;
      while (el.parentElement && el.parentElement.id !== 'root') {
        const r = el.getBoundingClientRect(); if (r.width >= minW && r.height >= minH) break; el = el.parentElement;
      }
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, target);
  }
  const l = typeof target === 'string' ? page.locator(target).first() : target;
  try { await l.waitFor({ state: 'visible', timeout: 5000 }); } catch { return null; }
  return l.boundingBox();
}
async function find(target) {
  let r = await rect(target);
  if (!r) { console.warn('  ⚠ tidak ketemu:', typeof target === 'string' ? target : JSON.stringify(target) || String(target)); return null; }
  if (r.y < 64 || r.y + Math.min(r.height, H * 0.7) > H - 110) {
    const top = r.height > H - 200 ? 80 : Math.max(80, (H - r.height) * 0.38);
    await scrollBy(r.y - top);
    r = await rect(target);
  }
  return r;
}
async function hover(target, ms) { const r = await find(target); if (r) await glide(r.x + r.width / 2, r.y + r.height / 2, ms); return r; }
async function click(target, ms) {
  const r = await hover(target, ms); if (!r) return false;
  await sleep(140); tl.clicks.push(at());
  await page.mouse.down(); await sleep(90); await page.mouse.up();
  return true;
}
async function scrollBy(dy, ms) {
  if (Math.abs(dy) < 4) return;
  if (zoomed) await zoomOut();
  ms ??= Math.min(1800, Math.max(650, Math.abs(dy) * 1.5));
  await page.evaluate(async ({ dy, ms }) => {
    const s = scrollY, max = document.documentElement.scrollHeight - innerHeight;
    const e = Math.max(0, Math.min(max, s + dy)), t0 = performance.now();
    const f = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    await new Promise((res) => { const step = (now) => { const k = Math.min(1, (now - t0) / ms); scrollTo(0, s + (e - s) * f(k)); k < 1 ? requestAnimationFrame(step) : res(); }; requestAnimationFrame(step); });
  }, { dy, ms });
  await sleep(120);
}
const scrollTop = async (ms) => scrollBy(-(await page.evaluate(() => scrollY)), ms);
async function zoomIn(target, s = 1.45, ms = 1100) {
  if (zoomed) await zoomOut();
  const r = await find(target); if (!r) return null;
  s = Math.min(s, (W - 40) / r.width, (H - 40) / r.height);   // seluruh target harus tetap muat di layar
  await qd('zoom', r.x + r.width / 2, r.y + r.height / 2, s, ms, { x: r.x, y: r.y, w: r.width, h: r.height });
  zoomed = true; await sleep(ms + 60);
  return r;
}
async function zoomOut(ms = 850) { if (!zoomed) return; await qd('zoom', 0, 0, 1, ms); zoomed = false; await sleep(ms + 40); }
async function spot(target, pad = 8) {
  const r = await find(target); if (!r) return null;
  await qd('spot', { x: r.x - pad, y: r.y - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
  if (!spotOn) tl.pops.push(at());
  spotOn = true; await sleep(650); return r;
}
async function unspot() { if (!spotOn) return; await qd('spot', null); spotOn = false; await sleep(420); }

// Subtitle + narasi. `until()` menahan adegan sampai narasinya selesai (+ jeda napas).
let capOpen = null, voEnd = 0;
async function say(key) {
  const [k, t] = C[key];
  if (capOpen) capOpen.b = at();
  await qd('caption', k, t);
  const a = at() + (capOpen ? 0.36 : 0);
  capOpen = { a, k, t }; tl.captions.push(capOpen);
  if (VO[key]) { tl.vo.push({ key, at: a + 0.15 }); voEnd = a + 0.15 + VO[key]; }
  await sleep(450);
}
async function until(extra = 0.7) { const w = voEnd + extra - at(); if (w > 0) await sleep(w * 1000); }
async function hush() { if (!capOpen) return; capOpen.b = at(); capOpen = null; await qd('caption', null); await sleep(400); }

async function waitLoaded(timeout = 7000) {
  await page.waitForFunction(() => !/(^|\n)\s*(Loading…|Memuat…)\s*(\n|$)/.test(document.getElementById('root')?.innerText || ''), null, { timeout }).catch(() => {});
}
async function chapter(key, hash) {
  const [n, h, s] = C[key];
  await until(0.5); await hush(); await unspot(); await zoomOut();
  await qd('cursor', false);
  tl.whoosh.push(at());
  await qd('chapter', n, h, s);
  await sleep(650);
  await page.evaluate((hh) => { location.hash = hh; }, hash);
  await sleep(200);
  await page.evaluate(() => scrollTo(0, 0));
  await waitLoaded();
  await sleep(1250);
  await qd('chapter', null);
  await sleep(250);
  await qd('cursor', true);
  await sleep(400);
}
async function navSidebar(hash) {
  await until(0.4);
  await click(`aside a[href="#${hash}"]`);
  await sleep(250); await waitLoaded(); await sleep(600);
}
const row = (i, tbody = 0) => page.locator('tbody').nth(tbody).locator('tr').nth(i);

// ───────────────────────── naskah ─────────────────────────
async function scenario() {
  await sleep(1100);
  releaseOverview();
  await waitLoaded();
  await sleep(2200);
  await page.mouse.move(mx, my); await qd('cursor', true);

  // 01 — Ringkasan
  await say('overview');
  await zoomIn({ text: T('Total portofolio', 'Total portfolio'), minW: 1000, minH: 80 }, 1.5);
  await hover({ text: T('Total portofolio', 'Total portfolio') }, 700); await sleep(600);
  await hover({ text: T('PnL bersih', 'Net PnL') }, 600); await sleep(600);
  await hover({ text: T('Fee didapat', 'Fees earned') }, 600); await sleep(600);
  await hover({ text: 'Win rate' }, 600); await sleep(900);
  await zoomOut();
  await until();

  await say('growth');
  await spot({ text: T('Pertumbuhan portofolio', 'Portfolio growth'), minW: 700, minH: 380 });
  const chart = await rect('.recharts-wrapper');
  if (chart) {
    await glide(chart.x + chart.width * 0.12, chart.y + chart.height * 0.55, 650);
    await glide(chart.x + chart.width * 0.62, chart.y + chart.height * 0.35, 1500);
    await glide(chart.x + chart.width * 0.93, chart.y + chart.height * 0.4, 900);
  }
  const seg = (label) => `button:has-text("${label}"), [role=radio]:has-text("${label}")`;
  await click(seg(T('30 hari', '30d'))); await sleep(1100);
  await click(seg(T('PnL kumulatif', 'Cumulative PnL'))); await sleep(1400);
  await click(seg(T('PnL bersih', 'Net PnL'))); await sleep(600);
  await unspot();
  await until();

  await say('source');
  await find({ text: T('Kalender PnL', 'PnL calendar'), minW: 600, minH: 400 });
  await spot({ text: T('Kinerja per sumber', 'Performance by source'), minW: 400, minH: 250 });
  await hover({ text: T('Kinerja per sumber', 'Performance by source') }, 800);
  await sleep(1500);
  await spot({ text: T('Kalender PnL', 'PnL calendar'), minW: 600, minH: 400 });
  await sleep(1200);
  await unspot();
  await until();

  await say('drill');
  await scrollTop(1200);
  const active = { text: T('Posisi aktif', 'Active positions'), prefix: true, minW: 900, minH: 150 };
  await find(active); await spot(active, 6); await sleep(300); await unspot();
  if (await click('a[href^="#positions/"]')) {
    await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
    await sleep(900);
    const cv = await zoomIn('canvas', 1.3);
    if (cv) { await glide(cv.x + cv.width * 0.2, cv.y + cv.height * 0.5, 700); await glide(cv.x + cv.width * 0.75, cv.y + cv.height * 0.4, 1600); await sleep(400); }
    await zoomOut();
    await scrollBy(430); await sleep(1200);
  }
  await until();

  // 02 — Posisi
  await chapter('ch2', 'positions');
  await say('positions');
  await hover(row(0), 800); await sleep(600);
  await hover(row(1), 500); await sleep(700);
  await find({ text: T('Posisi tertutup', 'Closed positions'), prefix: true }); await sleep(500);
  await until();
  await say('history');
  const target = (await page.locator('tbody').count()) > 1 ? row(1, 1) : row(3);
  if (await click(target)) {
    tl.pops.push(at());
    await page.waitForFunction(() => { const d = document.querySelector('[role=dialog]'); return d && !/Loading…|Memuat…/.test(d.innerText); }, null, { timeout: 9000 }).catch(() => {});
    await sleep(700);
    const dlg = await rect('[role=dialog]');
    if (dlg) { await glide(dlg.x + dlg.width * 0.45, dlg.y + dlg.height * 0.45, 800); await sleep(900); await glide(dlg.x + dlg.width * 0.55, dlg.y + dlg.height * 0.7, 900); }
    await until(0.3);
    await page.keyboard.press('Escape');
    await sleep(600);
  }

  // 03 — Aktivitas
  await chapter('ch3', 'activity');
  await say('activity');
  const firstRow = await rect('tbody tr');
  if (firstRow) {
    await qd('zoom', firstRow.x + firstRow.width * 0.55, firstRow.y + 110, 1.4, 1100); zoomed = true; await sleep(1150);
    for (const i of [0, 1, 2]) { await hover(row(i), 650); await sleep(700); }
    await zoomOut();
  }
  await scrollBy(360); await sleep(1000);
  await until();

  // 04 — Mesin copy
  await chapter('ch4', 'targets');
  await say('targets');
  await spot({ sel: 'a[href^="#targets/"]', minW: 900, minH: 300 }, 6);
  for (const i of [0, 2, 4]) { await hover({ sel: 'a[href^="#targets/"]', nth: i * 2, minW: 900, minH: 40 }, 650); await sleep(550); }
  await hover('[role=switch], input[type=checkbox]', 700); await sleep(900);
  await unspot();
  await navSidebar('rules');
  await say('rules');
  await hover('input', 800); await sleep(600);
  await scrollBy(420); await sleep(800);
  await hover(page.locator('input').nth(3), 700); await sleep(800);
  await scrollBy(420); await sleep(900);
  await until();

  // 05 — Riset
  await chapter('ch5', 'wallet');
  await say('research');
  await hover('input', 800); await sleep(600);
  await spot('table', 6);
  for (const i of [0, 1, 2]) { await hover(row(i), 600); await sleep(550); }
  await unspot();
  await until();

  // 06 — Harian
  await chapter('ch6', 'manual-lp');
  await say('manual');
  await hover({ text: T('Pilih pool', 'Pick a pool') }, 800); await sleep(500);
  for (const i of [0, 1, 2]) { await hover(row(i), 550); await sleep(450); }
  await navSidebar('summary');
  await say('polish');
  const foot = await rect('aside > div:last-child');
  if (foot) { await qd('spot', { x: foot.x + 4, y: foot.y + 4, w: foot.width - 8, h: foot.height - 8 }); spotOn = true; tl.pops.push(at()); }
  await sleep(500);
  await qd('themeAnim', true);
  await click(`aside button[aria-label="${T('Ganti tema', 'Toggle theme')}"]`); await sleep(1600);
  await click(`aside button[aria-pressed="false"]:text-is("${LANG === 'en' ? 'id' : 'en'}")`); await sleep(1600);
  await click(`aside button[aria-pressed="false"]:text-is("${LANG}")`); await sleep(500);
  await click(`aside button[aria-label="${T('Ganti tema', 'Toggle theme')}"]`); await sleep(1000);
  await qd('themeAnim', false);
  await unspot();
  await until(0.4);
  await hush();
  await glide(W * 0.66, H * 0.52, 900);
  await sleep(700);
}

// ───────────────────────── rekam ─────────────────────────
let releaseOverview; const held = new Promise((r) => { releaseOverview = r; });
const mask = await buildMask();
console.log('sensor:', mask.counts, '· VO:', Object.keys(VO).length, 'klip');
const browser = await chromium.launch({ executablePath: EXE, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DSF, colorScheme: 'dark' });
ctx.setDefaultNavigationTimeout(240000);
let holdArmed = false;
await attach(ctx, mask, { hold: async () => { if (holdArmed) { holdArmed = false; await held; } } });
await ctx.addInitScript((l) => { try { localStorage.setItem('lpcopy-lang', l); localStorage.setItem('lpcopy-theme', 'dark'); } catch {} }, LANG);
await ctx.addInitScript(censorScript(mask.pseudonyms));
await ctx.addInitScript(director, TOK);

{ // pemanasan cache
  const warm = await ctx.newPage();
  for (const h of ['summary', 'positions', 'activity', 'targets', 'rules', 'wallet', 'manual-lp']) {
    await warm.goto(BASE + '/#' + h, { waitUntil: 'commit' }); await warm.waitForLoadState('load').catch(() => {}); await warm.waitForTimeout(h === 'summary' ? 5000 : 2500);
  }
  await warm.goto(BASE + '/#summary'); await warm.waitForTimeout(3000);
  for (const r of ['24h', '30d', 'all']) await warm.evaluate((r) => fetch('/api/portfolio?range=' + r).catch(() => {}), r);
  await warm.waitForTimeout(2500);
  const href = await warm.locator('a[href^="#positions/"]').first().getAttribute('href').catch(() => null);
  if (href) { await warm.goto(BASE + '/' + href); await warm.waitForTimeout(6000); }
  await warm.close();
  console.log('pemanasan selesai');
}

page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const leaks = []; let boundary = false;
const auditor = setInterval(async () => {
  try {
    const l = await leakCheck(page, mask.secrets); if (l.length) leaks.push(...l);
    if (await page.evaluate(() => /Halaman gagal dimuat|failed to load/i.test(document.getElementById('root')?.innerText || ''))) boundary = true;
  } catch { /* sedang navigasi */ }
}, 600);

await page.goto('about:blank');
const cap = await startCapture(page, path.join(OUT, 'frames-app-' + LANG));
holdArmed = true;
await page.goto(BASE + '/#summary', { waitUntil: 'commit' });
await page.waitForFunction(() => document.getElementById('splash'), null, { timeout: 15000 });
await sleep(120);
t0 = cap.go();
await scenario();
const res = await cap.stop();
clearInterval(auditor);
const finalLeaks = await leakCheck(page, mask.secrets);
await browser.close();

if (pageErrors.length) console.warn('galat halaman:', [...new Set(pageErrors)].slice(0, 5));
if (boundary) { console.error('✖ aplikasi menampilkan halaman galat — tidak dirakit'); process.exit(2); }
if (leaks.length || finalLeaks.length) { console.error('✖ KEBOCORAN:', [...new Set([...leaks, ...finalLeaks])]); process.exit(1); }

const dur = framesToMp4(res, path.join(OUT, `app-${LANG}.mp4`), { start: t0 });
if (capOpen) capOpen.b = dur;
fs.writeFileSync(path.join(OUT, `timeline-${LANG}.json`), JSON.stringify({ duration: dur, ...tl }, null, 1));
console.log(`✔ app-${LANG}.mp4 ${dur.toFixed(1)}s · ${res.frames.length} frame · ${tl.clicks.length} klik · ${tl.captions.length} subtitle · bocor: 0`);
