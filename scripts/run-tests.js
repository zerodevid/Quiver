'use strict';
// Runs every standalone test file in test/ in its own process and reports the failures.
// Run: npm test   (or: node scripts/run-tests.js [name-substring])
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'test');
const filter = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && (!filter || f.includes(filter))).sort();

const failed = [];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(dir, file)], { encoding: 'utf8', timeout: 120000 });
  const ok = r.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}`);
  if (!ok) {
    failed.push(file);
    console.log(((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-15).map((l) => '     ' + l).join('\n'));
  }
}
console.log(`\n${files.length - failed.length}/${files.length} test files passed`);
process.exit(failed.length ? 1 : 0);
