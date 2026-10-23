// A modal that follows a dashboard action sending transactions (open an LP, close a position)
// while the server works on it: the steps of the flow (fund → zap → approvals → mint → leftover,
// or withdraw → sell), each lit by the transactions the server actually sends for it
// (GET /api/progress, src/progress.js), with its hash and receipt, then the outcome.
//
// Usage: const op = trackTx({ title, subtitle, flow: 'open', chain });
//        const r = await post(url, { ...body, opId: op.id });
//        op.finish(r, details);   // details: optional lines shown under the outcome
import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import { Check, X, Minus, Loader2, ExternalLink, TriangleAlert } from 'lucide-react';
import { get, withChain } from '../api';
import { short, txHref } from '../fmt';
import { translate as t } from '../i18n';

// [id, label, transaction kinds]
const FLOWS = {
  open: [
    ['fund', 'Siapkan dana', ['bridge_swap', 'wrap_eth', 'unwrap_weth', 'gas_topup', 'swap_manual']],
    ['zap', 'Zap ke token pasangan', ['zap_swap']],
    ['approve', 'Izin token untuk mint', ['approve_erc20', 'approve_permit2']],
    ['mint', 'Mint posisi LP', ['lain', 'mint', 'increase']],
    ['leftover', 'Jual sisa token', ['sell_leftover']],
  ],
  close: [
    ['withdraw', 'Tarik likuiditas + klaim fee', ['burn', 'decrease', 'claim_fees']],
    ['sell', 'Jual hasil', ['sell_leftover', 'bridge_swap', 'zap_swap', 'unwrap_weth', 'wrap_eth', 'swap_manual']],
  ],
};
const SWAPS = new Set(['bridge_swap', 'zap_swap', 'sell_leftover', 'swap_manual', 'gas_topup']);

const KIND_LABEL = {
  bridge_swap: 'Tukar ke aset kuotasi', wrap_eth: 'Wrap ETH', unwrap_weth: 'Unwrap WETH', gas_topup: 'Isi gas',
  zap_swap: 'Swap zap', approve_erc20: 'Izin token', approve_permit2: 'Izin Permit2', approve_kyber: 'Izin router swap',
  mint: 'Mint posisi', increase: 'Tambah likuiditas', lain: 'Buat pool', sell_leftover: 'Jual token', swap_manual: 'Swap',
  burn: 'Tarik & tutup posisi', decrease: 'Tarik likuiditas', claim_fees: 'Klaim fee',
};

let push = null;
let seq = 0;
const newId = () => `op${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function trackTx({ title, subtitle = null, flow = 'open', chain = null }) {
  const id = newId();
  let finish = () => {};
  if (push) {
    push({ id, title, subtitle, flow, chain, started: Date.now(), result: null });
    finish = (result, details = null) => push((cur) => (cur?.id === id ? { ...cur, result, details, ended: Date.now() } : cur));
  }
  return { id, finish };
}

// Phases with their steps. A swap approval (approve_kyber) belongs to the swap that follows it.
function phasesOf(flow, steps, finished) {
  const defs = FLOWS[flow] || FLOWS.open;
  const byPhase = new Map(defs.map(([id]) => [id, []]));
  const other = [];
  steps.forEach((s, i) => {
    let kind = s.kind;
    if (kind === 'approve_kyber') kind = steps.slice(i + 1).find((x) => SWAPS.has(x.kind))?.kind || (flow === 'close' ? 'sell_leftover' : 'zap_swap');
    const def = defs.find(([, , kinds]) => kinds.includes(kind));
    (def ? byPhase.get(def[0]) : other).push(s);
  });
  const list = defs.map(([id, label]) => ({ id, label, steps: byPhase.get(id) }));
  if (other.length) list.push({ id: 'other', label: 'Transaksi lain', steps: other });
  const lastUsed = list.reduce((m, p, i) => (p.steps.length ? i : m), -1);
  return list.map((p, i) => {
    let state;
    if (p.steps.some((s) => s.phase === 'done' && s.ok === false)) state = 'fail';
    else if (p.steps.length) state = p.steps.every((s) => s.phase === 'done') ? 'done' : 'active';
    else state = finished || i < lastUsed ? 'skip' : 'pending';
    return { ...p, state };
  });
}

function StateIcon({ state }) {
  if (state === 'done') return <span className="flex size-5 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-3" /></span>;
  if (state === 'fail') return <span className="flex size-5 items-center justify-center rounded-full bg-danger/15 text-danger"><X className="size-3" /></span>;
  if (state === 'active') return <span className="flex size-5 items-center justify-center rounded-full bg-accent/15 text-accent"><Loader2 className="size-3 animate-spin" /></span>;
  if (state === 'skip') return <span className="flex size-5 items-center justify-center rounded-full bg-default text-muted"><Minus className="size-3" /></span>;
  return <span className="block size-5 rounded-full border border-border" />;
}

function stepText(s) {
  if (s.phase === 'prepare') return t('menyiapkan…');
  if (s.phase === 'sent') return t('menunggu konfirmasi…');
  return s.ok === false ? t('gagal') : t('terkonfirmasi');
}

export function TxProgressHost() {
  const [op, setOp] = useState(null);
  const [steps, setSteps] = useState([]);
  const [serverDone, setServerDone] = useState(false);
  const [, setNow] = useState(0);
  const last = useRef(null);
  useEffect(() => {
    push = (v) => setOp((cur) => {
      const next = typeof v === 'function' ? v(cur) : v;
      if (next?.id !== cur?.id) { setSteps([]); setServerDone(false); }
      return next;
    });
    return () => { push = null; };
  }, []);

  // Poll the server's list while the action runs, and once more after its reply arrives.
  const id = op?.id, chain = op?.chain, finished = !!op?.result;
  useEffect(() => {
    if (!id || serverDone) return undefined;
    let alive = true, timer = null;
    const tick = async () => {
      try {
        const r = await get(withChain(`/api/progress?id=${id}`, chain));
        if (!alive) return;
        if (r && !r.error) { setSteps(r.steps || []); if (r.done) { setServerDone(true); return; } }
      } catch { /* the next tick tries again */ }
      if (alive && !finished) timer = setTimeout(tick, 800);
      else if (alive) setServerDone(true);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [id, chain, finished, serverDone]);

  // elapsed time ticks while running
  useEffect(() => {
    if (!id || finished) return undefined;
    const h = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [id, finished]);

  if (op) last.current = op;
  const v = op || last.current;
  if (!v) return null;
  const r = v.result;
  const running = !r;
  const phases = phasesOf(v.flow, steps, !running);
  const secs = Math.max(0, Math.round(((r ? v.ended || Date.now() : Date.now()) - v.started) / 1000));
  const lost = r && (r.lost || /^HTTP 5\d\d$/.test(r.error || ''));
  const close = () => setOp(null);

  return (
    <Modal isOpen={!!op} onOpenChange={(o) => { if (!o) close(); }}>
      <Modal.Backdrop isDismissable={!running}>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog aria-busy={running}>
            <Modal.Header>
              <Modal.Heading>{v.title}</Modal.Heading>
              {v.subtitle && <p className="mt-0.5 text-sm text-muted">{v.subtitle}</p>}
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              <ol className="flex flex-col" aria-live="polite">
                <li className="flex gap-3 pb-3">
                  <StateIcon state={steps.length || !running ? 'done' : 'active'} />
                  <span className={`text-sm ${steps.length || !running ? 'text-muted' : 'text-foreground'}`}>{t('Rencana & harga terbaru dari chain')}</span>
                </li>
                {phases.map((p) => (
                  <li key={p.id} className="flex gap-3 pb-3 last:pb-0">
                    <StateIcon state={p.state} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`text-sm ${p.state === 'pending' || p.state === 'skip' ? 'text-muted' : 'text-foreground'} ${p.state === 'fail' ? '!text-danger' : ''}`}>{t(p.label)}</span>
                        {p.state === 'skip' && <span className="text-xs text-muted">{t('tidak perlu')}</span>}
                      </div>
                      {p.steps.length > 0 && (
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {p.steps.map((s, i) => (
                            <li key={s.hash || `${s.kind}${i}`} className="flex items-center justify-between gap-2 text-xs text-muted">
                              <span className="truncate">{t(KIND_LABEL[s.kind] || s.kind)} · <span className={s.ok === false ? 'text-danger' : s.phase === 'done' ? 'text-success' : ''}>{stepText(s)}</span></span>
                              {s.hash && <a href={txHref(s.hash, v.chain)} target="_blank" rel="noreferrer" className="mono inline-flex shrink-0 items-center gap-1 hover:text-foreground">{short(s.hash)}<ExternalLink className="size-3" /></a>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {running ? (
                <p className="text-xs text-muted">{t('Berjalan {s} dtk · biasanya 15–90 detik. Menutup jendela ini tidak membatalkan prosesnya.', { s: secs })}</p>
              ) : lost ? (
                <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-sm text-warning">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  <span>{t('Koneksi ke server terputus sebelum ada jawaban. Transaksinya mungkin tetap diproses — cek lagi posisinya sebentar lagi.')}</span>
                </div>
              ) : r.error ? (
                <div className="flex gap-2 rounded-md border border-danger/40 bg-danger/10 p-2.5 text-sm text-danger">
                  <X className="mt-0.5 size-4 shrink-0" /><span className="break-words">{r.error}</span>
                </div>
              ) : (
                <div className="rounded-md border border-success/40 bg-success/10 p-2.5 text-sm">
                  <div className="flex items-center gap-2 font-medium text-success"><Check className="size-4" />{t(v.flow === 'close' ? 'Posisi berhasil ditutup' : 'Posisi berhasil dibuka')} · {t('{s} dtk', { s: secs })}</div>
                  {v.details && <div className="mt-1 text-muted">{v.details}</div>}
                </div>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant={running ? 'tertiary' : 'primary'} onPress={close}>{running ? t('Sembunyikan') : t('Tutup')}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
