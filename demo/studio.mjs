// Aset komposisi: latar, bingkai, kartu intro/outro.
//   QLANG=en node studio.mjs  -> out/studio/{bg,shadow,mask}.png, out/{intro,outro}-<lang>.mp4
//
// Gaya mengikuti dasbornya sendiri: hitam datar #0c0c0e, garis 1px, Inter,
// logo panah dari layar pembuka. Tanpa gradien, glow, atau hiasan.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { EXE, sleep, startCapture, framesToMp4 } from './capture.mjs';
import { COPY, AUTHOR } from './copy.mjs';

const LANG = process.env.QLANG || 'en';
const C = COPY[LANG];
const OUT = path.resolve('out'); const ST = path.join(OUT, 'studio');
fs.mkdirSync(ST, { recursive: true });
const FONT = new URL('../web/public/fonts/inter-var-latin.woff2', import.meta.url);
export const FRAME = { x: 128, y: 72, w: 1664, h: 936, r: 12 };
// token warna dasbor (index.css, mode gelap)
export const TOK = { bg: '#08080a', app: '#0c0c0e', surface: '#121215', border: '#33333a', muted: '#8a8a93', accent: '#6096ff' };

const MARK = `<svg class="mark" viewBox="0 0 73 48"><path class="arrow" d="M0 19H26L16 8L24 0L46 24L24 48L16 40L26 30H0Z"/><path class="chev" d="M43 11L51 3L73 24L51 46L43 38L56 24Z"/></svg>`;
const WORD = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').match(/<svg class="sp-word"[\s\S]*?<\/svg>/)[0].replace('class="sp-word"', 'class="word"');

const CSS = `
@font-face{font-family:Inter;src:url(/inter.woff2) format('woff2');font-weight:100 900}
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden}
body{background:${TOK.app};font-family:Inter,system-ui,sans-serif;color:#fff;-webkit-font-smoothing:antialiased;letter-spacing:-.011em}
.stage{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.paused *{animation-play-state:paused!important}
.logo{display:flex;align-items:center;gap:12px;height:58px}
.logo svg{fill:#fff;height:58px;width:auto;overflow:visible}
.arrow{animation:ax .6s cubic-bezier(.2,.8,.2,1) .1s both}
.chev{animation:cx .5s cubic-bezier(.2,.8,.2,1) .34s both;transform-origin:center}
.word{animation:up .55s cubic-bezier(.2,.8,.2,1) .5s both}
.sub{margin-top:14px;font-size:19px;color:${TOK.muted};display:flex;align-items:center;gap:9px}
.sub img{width:19px;height:19px;border-radius:50%}
h1{margin:52px 0 0;font-size:52px;line-height:1.14;font-weight:600;letter-spacing:-.032em;max-width:1180px;text-align:center}
.lead{margin-top:18px;font-size:23px;line-height:1.5;color:${TOK.muted};max-width:900px;text-align:center}
.chips{display:flex;gap:8px;margin-top:40px}
.chip{font-size:16px;color:#d7d7dd;padding:7px 14px;border-radius:8px;border:1px solid ${TOK.border};background:${TOK.surface}}
.rule{width:520px;height:1px;background:${TOK.border};margin-top:44px}
.specs{margin-top:38px;width:820px;border:1px solid ${TOK.border};border-radius:10px;background:${TOK.surface};overflow:hidden}
.row{display:flex;gap:26px;padding:15px 22px;font-size:18px;border-top:1px solid ${TOK.border}}
.row:first-child{border-top:0}
.row .k{width:190px;color:${TOK.muted};flex:none}
.row .v{color:#e6e6ea}
.extra{margin-top:34px;font-size:19px;color:${TOK.muted}}
.author{margin-top:16px;font-size:20px;color:#e6e6ea}
.note{position:absolute;bottom:46px;left:0;right:0;text-align:center;font-size:14px;color:#5c5c66}
.fade{animation:up .6s cubic-bezier(.2,.8,.2,1) both}
.exit{animation:out .7s cubic-bezier(.55,0,.45,1) forwards!important}
@keyframes ax{from{opacity:0;transform:translateX(-26px)}to{opacity:1;transform:none}}
@keyframes cx{from{opacity:0;transform:translateX(-8px) scale(.86)}to{opacity:1;transform:none}}
@keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes out{to{opacity:0;transform:translateY(-14px)}}
`;

const CHAIN = 'data:image/jpeg;base64,' + fs.readFileSync(new URL('../web/public/robinhood-chain.jpg', import.meta.url)).toString('base64');

const introHtml = () => `<div class="stage" id="s">
  <div class="logo">${MARK}${WORD}</div>
  <div class="sub fade" style="animation-delay:.85s"><img src="${CHAIN}" alt="">${C.introEyebrow}</div>
  <h1 class="fade" style="animation-delay:1.15s">${C.introHead[0]}</h1>
  <div class="lead fade" style="animation-delay:1.45s">${C.introLead}</div>
  <div class="chips">${C.introChips.map((c, i) => `<div class="chip fade" style="animation-delay:${(1.75 + i * 0.1).toFixed(2)}s">${c}</div>`).join('')}</div>
</div>`;

const outroHtml = () => `<div class="stage" id="s">
  <div class="logo">${MARK}${WORD}</div>
  <div class="sub fade" style="animation-delay:.85s"><img src="${CHAIN}" alt="">${C.outroTag}</div>
  <div class="specs fade" style="animation-delay:1.2s">
    ${C.specs.map(([k, v]) => `<div class="row"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
  </div>
  <div class="extra fade" style="animation-delay:1.6s">${C.outroExtra}</div>
  ${AUTHOR ? `<div class="author fade" style="animation-delay:1.9s">${AUTHOR}</div>` : ''}
  <div class="note fade" style="animation-delay:2.1s">${C.note}</div>
</div>`;

const doc = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body class="paused">${body}</body></html>`;

export async function buildStudio({ introMs = 6000, outroMs = 6500 } = {}) {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const docs = {
    '/bg': `<!doctype html><html><head><style>html,body{margin:0;width:1920px;height:1080px;background:${TOK.bg}}</style></head><body></body></html>`,
    '/shadow': `<!doctype html><html><head><style>html,body{margin:0;background:transparent;width:1920px;height:1080px}
      .f{position:absolute;left:${FRAME.x}px;top:${FRAME.y}px;width:${FRAME.w}px;height:${FRAME.h}px;border-radius:${FRAME.r}px;
      box-shadow:0 0 0 1px ${TOK.border},0 24px 60px -20px rgba(0,0,0,.8)}</style></head><body><div class="f"></div></body></html>`,
    '/mask': `<!doctype html><html><head><style>html,body{margin:0;background:#000;width:${FRAME.w}px;height:${FRAME.h}px}
      .m{width:100%;height:100%;background:#fff;border-radius:${FRAME.r}px}</style></head><body><div class="m"></div></body></html>`,
    '/intro': doc(introHtml()),
    '/outro': doc(outroHtml()),
  };
  await ctx.route('http://studio.local/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/inter.woff2') return route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/woff2' });
    return route.fulfill({ body: docs[p] || '', contentType: 'text/html' });
  });
  const pg = await ctx.newPage();
  await pg.goto('http://studio.local/bg'); await pg.screenshot({ path: path.join(ST, 'bg.png') });
  await pg.goto('http://studio.local/shadow'); await pg.screenshot({ path: path.join(ST, 'shadow.png'), omitBackground: true });
  await pg.setViewportSize({ width: FRAME.w, height: FRAME.h });
  await pg.goto('http://studio.local/mask'); await pg.screenshot({ path: path.join(ST, 'mask.png') });
  await pg.setViewportSize({ width: 1920, height: 1080 });

  const card = async (name, holdMs) => {
    await pg.goto('http://studio.local/' + name);
    await pg.evaluate(() => document.fonts.ready); await sleep(350);
    const cap = await startCapture(pg, path.join(OUT, `frames-${name}-${LANG}`));
    await sleep(250);
    const t0 = cap.go();
    await pg.evaluate(() => document.body.classList.remove('paused'));
    await sleep(Math.max(1200, holdMs - 750));
    await pg.evaluate(() => document.getElementById('s').classList.add('exit'));
    await sleep(750);
    return framesToMp4(await cap.stop(), path.join(OUT, `${name}-${LANG}.mp4`), { start: t0 });
  };
  const intro = await card('intro', introMs);
  const outro = await card('outro', outroMs);
  await browser.close();
  console.log('studio:', { intro: intro.toFixed(2), outro: outro.toFixed(2) });
  return { intro, outro };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildStudio({ introMs: Number(process.env.QINTRO || 6000), outroMs: Number(process.env.QOUTRO || 6500) });
}
