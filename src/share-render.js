'use strict';
// Rasterises one share card in its own short-lived process (spawned by renderAsync in
// src/share-card.js). resvg takes 80–150 MB at its peak for a large card, and inside the bot
// that counted against pm2's max_memory_restart: sharing a card restarted the trading bot.
// Here the memory goes away with the process.
//
// stdin: JSON { svg, width, fonts, family } · stdout: the PNG bytes · exit code ≠ 0 on failure.
const { Resvg } = require('@resvg/resvg-js');

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const { svg, width, fonts, family } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const png = new Resvg(svg, {
      fitTo: { mode: 'width', value: width },
      font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: family },
    }).render().asPng();
    process.stdout.write(Buffer.from(png), () => process.exit(0));
  } catch (e) {
    process.stderr.write(String(e?.message || e));
    process.exit(1);
  }
});
