'use strict';
// Live progress of one dashboard action (open an LP, close a position): every transaction the
// action sends — its kind, its hash, whether it landed — so the dashboard can show the steps as
// they happen (bridge, zap, approvals, mint, selling the leftover) instead of a silent wait.
//
// The action runs inside run(id, fn); the executor reports through emit() without knowing who
// asked. AsyncLocalStorage carries the id across every await, including the executor's send
// queue (a promise reaction keeps the context it was attached in), and keeps actions running at
// the same time — or the copier's own trades — out of each other's lists.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
const ops = new Map();         // id -> { started, done, error, events: [{ ts, phase, kind, hash, ok }] }
const KEEP_MS = 10 * 60_000;   // a finished action stays readable this long
const MAX_OPS = 200;

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id);

function prune() {
  const now = Date.now();
  for (const [id, op] of ops) if (op.done && now - op.done > KEEP_MS) ops.delete(id);
  while (ops.size > MAX_OPS) ops.delete(ops.keys().next().value);
}

// Runs fn as the action `id`; without a valid id it just runs fn.
async function run(id, fn) {
  if (!validId(id)) return fn();
  prune();
  const op = { started: Date.now(), done: null, error: null, events: [] };
  ops.set(id, op);
  try {
    const r = await als.run(op, fn);
    if (r?.error) op.error = String(r.error);
    return r;
  } catch (e) {
    op.error = e.message;
    throw e;
  } finally {
    op.done = Date.now();
  }
}

// phase: 'prepare' (estimating / signing), 'sent' (broadcast, hash known), 'done' (receipt: ok).
function emit(ev) {
  const op = als.getStore();
  if (!op) return;
  // the receipt of a hash the action sent marks that step, not a new one
  if (ev.phase === 'done' && ev.hash) {
    const step = [...op.events].reverse().find((x) => x.hash === ev.hash);
    if (step) { step.phase = 'done'; step.ok = ev.ok; step.doneTs = Date.now(); return; }
    return;
  }
  if (ev.phase === 'sent') {
    const step = [...op.events].reverse().find((x) => x.phase === 'prepare' && x.kind === ev.kind);
    if (step) { step.phase = 'sent'; step.hash = ev.hash; return; }
  }
  op.events.push({ ts: Date.now(), ...ev });
}

// A prepared step that never got sent (the estimate reverted) is marked failed.
function fail(kind, error) {
  const op = als.getStore();
  if (!op) return;
  const step = [...op.events].reverse().find((x) => x.phase === 'prepare' && x.kind === kind);
  if (step) { step.phase = 'done'; step.ok = false; step.error = String(error).slice(0, 200); }
}

function get(id) {
  const op = validId(id) ? ops.get(id) : null;
  if (!op) return null;
  return { started: op.started, done: op.done, error: op.error, steps: op.events.map((e) => ({ ...e })) };
}

module.exports = { run, emit, fail, get };
