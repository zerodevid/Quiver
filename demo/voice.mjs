// Narasi (VO) per adegan -> out/vo/<lang>/<key>.wav + out/vo-<lang>.json (durasi).
//   QLANG=en node voice.mjs          Inggris: Kokoro (neural, lokal) — QVOICE=af_heart|am_michael|bf_emma|…
//   QLANG=id node voice.mjs          Indonesia: suara sistem macOS "Damayanti" (Kokoro belum punya bahasa Indonesia)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { COPY } from './copy.mjs';
import { probeDur } from './capture.mjs';

const LANG = process.env.QLANG || 'en';
const C = COPY[LANG];
const DIR = path.resolve('out/vo', LANG); fs.mkdirSync(DIR, { recursive: true });

// Kalimat yang sama dipakai untuk subtitle & VO; singkatan dibaca supaya tidak dieja aneh.
const spoken = (s) => s
  .replace(/\bPnL\b/g, LANG === 'en' ? 'P and L' : 'P N L')
  .replace(/\bLP\b/g, LANG === 'en' ? 'L-P' : 'L P')
  .replace(/\bv3\b/g, LANG === 'en' ? 'v3' : 'v tiga').replace(/\bv4\b/g, LANG === 'en' ? 'v4' : 'v empat')
  .replace(/\bntfy\b/g, 'ntfy')
  .replace(/ — /g, LANG === 'en' ? ', ' : ', ').replace(/—/g, ',');

const lines = { intro: C.introVo, outro: C.outroVo };
for (const [k, v] of Object.entries(C)) if (Array.isArray(v) && v.length === 3 && typeof v[2] === 'string' && !/^\d\d$/.test(v[0])) lines[k] = v[2];

let synth;
if (LANG === 'en') {
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  const voice = process.env.QVOICE || 'af_heart';
  synth = async (text, out) => { const a = await tts.generate(text, { voice, speed: Number(process.env.QSPEED || 1.0) }); await a.save(out); };
} else {
  const voice = process.env.QVOICE || 'Damayanti';
  synth = async (text, out) => {
    const aiff = out.replace(/\.wav$/, '.aiff');
    execFileSync('say', ['-v', voice, '-r', process.env.QRATE || '178', '-o', aiff, text]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '24000', '-ac', '1', out]); fs.unlinkSync(aiff);
  };
}

const durs = {};
for (const [k, text] of Object.entries(lines)) {
  const out = path.join(DIR, k + '.wav');
  await synth(spoken(text), out);
  durs[k] = probeDur(out);
  console.log(`${k.padEnd(9)} ${durs[k].toFixed(1)}s`);
}
fs.writeFileSync(path.resolve(`out/vo-${LANG}.json`), JSON.stringify(durs, null, 1));
console.log('total VO', Object.values(durs).reduce((a, b) => a + b, 0).toFixed(1) + 's');
