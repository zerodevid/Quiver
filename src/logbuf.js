// In-memory tail of the process log, for the dashboard's live log page. Every line the bot
// prints (src/index.js log()) lands here with a growing sequence number, so a client can ask
// "what is new since #N" instead of re-downloading the tail. Lost on restart; the pm2 log
// file stays the durable record.
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

const lines = [];   // [{ seq, line }]
let seq = 0;

function push(line) {
  seq += 1;
  lines.push({ seq, line: String(line).slice(0, MAX_LINE_CHARS) });
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

// Lines after `after` (a sequence number), at most `limit`, oldest first. `after` null/NaN = the
// newest `limit` lines. `last` is the newest sequence number overall, to continue from.
function since(after, limit = 500) {
  const n = Math.max(1, Math.min(MAX_LINES, limit));
  const from = Number.isFinite(after) ? lines.findIndex((l) => l.seq > after) : Math.max(0, lines.length - n);
  const out = from < 0 ? [] : lines.slice(from, from + n);
  return { lines: out, last: seq, reset: Number.isFinite(after) && after > seq };
}

module.exports = { push, since };
