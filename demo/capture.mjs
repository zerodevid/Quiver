// Perekam frame lewat CDP screencast + perakit frame -> MP4 berkecepatan tetap.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Chromium dari cache Playwright (`npx playwright install chromium`); atau tunjuk biner lain lewat QCHROME.
export const EXE = process.env.QCHROME
  || process.env.HOME + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startCapture(page, dir, { width = 1920, height = 1080 } = {}) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = []; let n = 0; let live = false;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!live) return;
    const f = path.join(dir, String(n++).padStart(6, '0') + '.jpg');
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    frames.push([f, metadata.timestamp]);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  return {
    go() { live = true; return Date.now() / 1000; },
    async stop() { const end = Date.now() / 1000; await cdp.send('Page.stopScreencast').catch(() => {}); live = false; return { frames, end }; },
  };
}

// Frame beserta timestamp -> video 60fps. `start` (epoch dtk) jadi t=0 video;
// frame sebelum start dibuang, frame terakhir sebelum start dipakai sebagai frame awal.
export function framesToMp4({ frames, end }, out, { start, fps = 60 } = {}) {
  if (!frames.length) throw new Error('tidak ada frame');
  start ??= frames[0][1];
  let i = frames.findIndex(([, ts]) => ts >= start);
  if (i < 0) i = frames.length - 1;
  const list = frames.slice(Math.max(0, i - 1));
  if (list.length > 1 && list[0][1] < start) list[0] = [list[0][0], start];
  let ff = 'ffconcat version 1.0\n';
  list.forEach(([f, ts], k) => {
    const next = k + 1 < list.length ? list[k + 1][1] : end;
    ff += `file '${f}'\nduration ${Math.max(0.001, next - Math.max(ts, start)).toFixed(4)}\n`;
  });
  ff += `file '${list.at(-1)[0]}'\n`;
  const lf = out.replace(/\.mp4$/, '.txt');
  fs.writeFileSync(lf, ff);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lf,
    '-vf', `fps=${fps},scale=1920:1080:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', out], { stdio: 'inherit' });
  return end - start;
}

export const probeDur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
