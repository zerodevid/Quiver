// Perakit akhir: intro + adegan (dalam bingkai) + outro, transisi silang, narasi,
// efek suara dari timeline, subtitle SRT.
//   QLANG=en node compose.mjs  -> out/quiver-demo-en.mp4 + out/quiver-demo-en.srt
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeDur } from './capture.mjs';
import { FRAME } from './studio.mjs';

const LANG = process.env.QLANG || 'en';
const OUT = path.resolve('out'); const SFX = path.join(OUT, 'sfx'); fs.mkdirSync(SFX, { recursive: true });
const f = (n) => path.join(OUT, n);
const tl = JSON.parse(fs.readFileSync(f(`timeline-${LANG}.json`), 'utf8'));
const dIntro = probeDur(f(`intro-${LANG}.mp4`)), dApp = probeDur(f(`app-${LANG}.mp4`)), dOutro = probeDur(f(`outro-${LANG}.mp4`));
const X1 = 0.7, X2 = 0.8;                       // durasi transisi silang
const appStart = dIntro - X1;                   // t video saat adegan mulai
const outroStart = appStart + dApp - X2;
const total = outroStart + dOutro;
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });

// ── efek suara sintetis (pelan, "UI", bukan film aksi) ──
const sfx = {
  click: ["aevalsrc=(random(0)-0.5)*exp(-t*700)*0.9:s=48000:d=0.06", 'highpass=f=1200,lowpass=f=6500,volume=0.55'],
  whoosh: ["aevalsrc=(random(0)-0.5)*sin(PI*t/0.6):s=48000:d=0.6", 'lowpass=f=1100,highpass=f=180,volume=0.32'],
  pop: ["aevalsrc=0.5*sin(2*PI*1480*t)*exp(-t*38):s=48000:d=0.18", 'volume=0.22'],
};
for (const [k, [src, filt]] of Object.entries(sfx)) ff(['-f', 'lavfi', '-i', src, '-af', filt, path.join(SFX, k + '.wav')]);

// ── daftar klip audio: [file, t mulai, volume] ──
const cues = [];
const voDir = path.join(OUT, 'vo', LANG);
const vo = (key, t) => { const p = path.join(voDir, key + '.wav'); if (fs.existsSync(p)) cues.push([p, t, 1.0]); };
vo('intro', 0.5);
for (const v of tl.vo) vo(v.key, appStart + v.at);
vo('outro', outroStart + 0.9);
for (const t of tl.clicks) cues.push([path.join(SFX, 'click.wav'), appStart + t, 1]);
for (const t of tl.whoosh) cues.push([path.join(SFX, 'whoosh.wav'), appStart + t, 1]);
for (const t of tl.pops) cues.push([path.join(SFX, 'pop.wav'), appStart + t, 1]);
cues.push([path.join(SFX, 'whoosh.wav'), appStart - 0.2, 0.8], [path.join(SFX, 'whoosh.wav'), outroStart - 0.2, 0.8]);

// ── pass 1: adegan dalam bingkai ──
const framed = f(`framed-${LANG}.mp4`);
ff(['-i', f(`app-${LANG}.mp4`), '-framerate', '60', '-loop', '1', '-i', path.join(OUT, 'studio', 'bg.png'),
  '-framerate', '60', '-loop', '1', '-i', path.join(OUT, 'studio', 'shadow.png'), '-framerate', '60', '-loop', '1', '-i', path.join(OUT, 'studio', 'mask.png'),
  '-filter_complex', [
    '[3:v]format=gray[mk]', `[0:v]scale=${FRAME.w}:${FRAME.h}:flags=lanczos,format=rgba[a0]`, '[a0][mk]alphamerge[app]',
    '[1:v][2:v]overlay=0:0:format=auto[bgsh]', `[bgsh][app]overlay=${FRAME.x}:${FRAME.y}:format=auto:shortest=1,format=yuv420p[v]`].join(';'),
  '-map', '[v]', '-t', dApp.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', framed]);

// ── pass 2: audio dicampur dulu (banyak klip) ──
const mix = f(`mix-${LANG}.wav`);
{
  const inputs = []; for (const [file] of cues) inputs.push('-i', file);
  const af = cues.map(([, t, vol], i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol},adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[a${i}]`);
  af.push(`${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[a]`);
  ff([...inputs, '-filter_complex', af.join(';'), '-map', '[a]', '-c:a', 'pcm_s16le', mix]);
}

// ── pass 3: transisi silang + audio ──
ff(['-i', f(`intro-${LANG}.mp4`), '-i', framed, '-i', f(`outro-${LANG}.mp4`), '-i', mix,
  '-filter_complex', [
    '[0:v]format=yuv420p,fps=60[in]', '[1:v]format=yuv420p,fps=60[mid]', '[2:v]format=yuv420p,fps=60[out]',
    `[in][mid]xfade=transition=fade:duration=${X1}:offset=${(dIntro - X1).toFixed(3)}[v1]`,
    `[v1][out]xfade=transition=fade:duration=${X2}:offset=${outroStart.toFixed(3)}[v2]`,
    `[v2]fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.9).toFixed(2)}:d=0.9[v]`].join(';'),
  '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), f(`quiver-demo-${LANG}.mp4`)]);

// ── SRT ──
const ts = (s) => { const d = new Date(Math.max(0, s) * 1000).toISOString(); return d.slice(11, 23).replace('.', ','); };
let srt = '', n = 1;
for (const c of tl.captions) srt += `${n++}\n${ts(appStart + c.a)} --> ${ts(appStart + (c.b ?? c.a + 4))}\n${c.k} — ${c.t}\n\n`;
fs.writeFileSync(f(`quiver-demo-${LANG}.srt`), srt);
console.log(`✔ quiver-demo-${LANG}.mp4 ${total.toFixed(1)}s (intro ${dIntro.toFixed(1)} · app ${dApp.toFixed(1)} · outro ${dOutro.toFixed(1)}) · ${cues.length} klip audio`);
