import { useEffect, useState } from 'react';
import { Button, toast } from '@heroui/react';
import { get, post, withChain } from './api';
import { ask, tableKey } from './components/ui';
import { muteClose } from './components/TargetAlerts';
import { usd, short, txHref } from './fmt';
import { useI18n, reason } from './i18n';
import { LiveCloseEstimate } from './components/LiveQuote';

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 4 });

// The close-position flow from the dashboard, used by the list and detail pages. The server only
// replies after the transaction is actually accepted on chain (can be ~1 minute),
// so during that time the button spins and the "closing" toast stays visible.
// There are three outcomes, not two: closed, failed (the server answers with a reason),
// or uncertain — the connection dropped / a proxy cut the long request before the
// server could answer, although the transaction may still have landed.
// Exit quotes for several positions (read-only, ~1–3 s each; three at a time). A position whose
// quote cannot be read stays in the list as `q: null` and is counted as unquoted, never guessed.
async function quoteMany(list) {
  const out = list.map((p) => ({ p, q: null }));
  let next = 0;
  const worker = async () => {
    while (next < out.length) {
      const item = out[next++];
      try {
        const q = await get(withChain(`/api/position/exit-quote?id=${item.p.id}`, item.p.chain));
        if (q && !q.error) item.q = q;
      } catch { /* shown as unquoted */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, out.length) }, worker));
  return out;
}

// The summed estimate for a batch close, with one line per position.
function BatchEstimate({ items, t }) {
  const quoted = items.filter((x) => x.q);
  if (!quoted.length) return null;
  const sum = (f) => quoted.reduce((a, x) => a + (f(x.q) || 0), 0);
  const cost = quoted.reduce((a, x) => a + (x.p.costUsd || 0), 0);
  const pnl = sum((q) => q.pnlUsd);
  const sign = (v) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;
  const row = (label, v, cls = '') => <div className="flex justify-between gap-4"><span>{label}</span><span className={`num ${cls}`}>{v}</span></div>;
  const sell = sum((q) => q.sellCostUsd), claimed = sum((q) => q.claimedUsd);
  return <div className="space-y-1 rounded-lg border border-border p-2.5 text-[0.8125rem]">
    <div className="font-medium text-foreground">{t('Estimasi jika ditutup sekarang')}</div>
    {row(t('Diterima di wallet'), usd(sum((q) => q.receiveUsd)))}
    {sell > 0.005 && row(t('Kerugian jual memecoin'), `−${usd(sell)}`, 'text-danger')}
    {row(t('Gas'), `−${usd(sum((q) => q.gasUsd))}`)}
    {claimed > 0.005 && row(t('Fee yang sudah diklaim'), `+${usd(claimed)}`)}
    {row(t('PnL riil'), `${sign(pnl)}${cost > 0 ? ` (${pnl >= 0 ? '+' : ''}${(pnl / cost * 100).toFixed(1)}%)` : ''}`, pnl >= 0 ? 'text-success font-medium' : 'text-danger font-medium')}
    <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto border-t border-border pt-1.5 text-xs text-muted">
      {items.map(({ p, q }) => <div key={p.id} className="flex justify-between gap-3">
        <span className="truncate">{p.symbol0}/{p.symbol1} #{p.id}</span>
        <span className="num whitespace-nowrap">{q ? `${usd(q.receiveUsd)} · ${sign(q.pnlUsd)}` : t('tidak terbaca')}</span>
      </div>)}
    </div>
    {quoted.length < items.length && <div className="text-xs text-warning">{t('{n} posisi belum bisa dihitung estimasinya — tidak termasuk dalam angka di atas.', { n: items.length - quoted.length })}</div>}
    {quoted.some((x) => !x.q.quoted) && <div className="text-xs text-warning">{t('Quote jual belum terbaca, memakai harga tengah.')}</div>}
    <div className="text-xs text-muted">{t('Perkiraan sekarang; hasil akhir mengikuti harga saat tiap transaksi masuk.')}</div>
  </div>;
}

// The dialog opens at once and the confirm button works throughout; the estimate fills in
// below as the quotes arrive (or never, if the owner confirms first).
function LiveBatchEstimate({ list }) {
  const { t } = useI18n();
  const [items, setItems] = useState(null);
  useEffect(() => {
    let alive = true;
    quoteMany(list).then((r) => { if (alive) setItems(r); });
    return () => { alive = false; };
  }, [list]);
  if (!items) return <div className="flex items-center gap-2 rounded-lg border border-border p-2.5 text-xs text-muted" role="status">
    <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
    {t('Menghitung estimasi hasil tutup…')} <span>{t('Kamu bisa langsung menutup tanpa menunggu.')}</span>
  </div>;
  return <BatchEstimate items={items} t={t} />;
}

export function useClosePosition(reload) {
  const { t } = useI18n();
  const [closing, setClosing] = useState(null);   // ids of the positions being closed
  // One position: send the request, wait for the chain, report via toast. Used
  // by both close-one and close-all; the confirmation is with the caller.
  const run = async (p, { force = false, sellTo = null } = {}) => {
    const pair = `${p.symbol0}/${p.symbol1}`;
    setClosing(p.id);
    muteClose(p.id);   // the toast for the result comes from this flow; the alert feed must not repeat it
    const wait = toast(t('Menutup posisi {pair}…', { pair }), {
      description: t('Menunggu konfirmasi di chain, bisa sampai 1–2 menit.'), isLoading: true, timeout: 0,
    });
    let r;
    const body = { id: p.id, ...(force ? { force: true } : {}), ...(sellTo ? { sellTo } : {}) };
    try { r = await post(withChain('/api/positions/close', p.chain), body); }
    catch (e) { r = { error: e.message, lost: true }; }
    toast.close(wait);
    if (r.lost || /^HTTP 5\d\d$/.test(r.error || '')) {
      toast.warning(t('Status penutupan {pair} belum pasti', { pair }), {
        description: t('Koneksi ke server terputus sebelum ada jawaban. Transaksinya mungkin tetap diproses — cek lagi posisinya sebentar lagi.'),
        timeout: 15000,
      });
    } else if (r.error) {
      toast.danger(t('Gagal menutup {pair}', { pair }), { description: r.error, timeout: 12000 });
    } else {
      // One fact per line: amounts first, then the memecoin sale (route id dropped), then the tx link.
      // Older engines print big amounts as 7.535e+5; show those as 753.5K too.
      const sales = r.sold ? String(r.sold).split(' · ').map((m) => reason(m)
        .replace(/(\$[\d.,]+) \([\w.-]+\)$/, '$1')
        .replace(/\b\d+(?:\.\d+)?e\+\d+\b/g, (n) => COMPACT.format(Number(n)))) : [];
      const description = <div className="space-y-0.5">
        {(r.outUsd != null || r.pnlUsd != null) && <div className="num">
          {r.outUsd != null && t('Diterima {v}', { v: usd(r.outUsd) })}
          {r.outUsd != null && r.pnlUsd != null && ' · '}
          {r.pnlUsd != null && <span className={r.pnlUsd >= 0 ? 'text-success' : 'text-danger'}>PnL {r.pnlUsd >= 0 ? '+' : '−'}{usd(Math.abs(r.pnlUsd))}</span>}
        </div>}
        {sales.map((m, i) => <div key={i}>{m}</div>)}
        {r.tx && <a className="text-xs text-muted underline-offset-2 hover:underline" href={txHref(r.tx, p.chain)} target="_blank" rel="noreferrer">tx {short(r.tx)}</a>}
      </div>;
      toast.success(t('Posisi {pair} ditutup', { pair }), { description, timeout: 10000 });
    }
    return r;
  };
  const close = async (p) => {
    if (closing != null) return;
    const pair = `${p.symbol0}/${p.symbol1}`;
    const pick = { sellTo: null };   // filled by the "sell into" choice in the estimate
    const base = p.feeUsd > 0.005
      ? t('Likuiditas ditarik dan fee diklaim dalam satu transaksi. Nilai sekarang {v} + fee {f}.', { v: usd(p.valueUsd), f: usd(p.feeUsd) })
      : t('Likuiditas ditarik dan fee diklaim dalam satu transaksi. Nilai sekarang {v}.', { v: usd(p.valueUsd) });
    const ok = await ask({
      title: t('Tutup posisi {pair}?', { pair }),
      // The dialog opens at once; the estimate fills in as the quote arrives (see LiveQuote.jsx).
      body: <div className="space-y-2"><div>{base}</div><LiveCloseEstimate p={p} state={pick} /></div>,
      confirm: t('Tutup posisi'), danger: true,
    });
    if (!ok) return;
    await run(p, { sellTo: pick.sellTo });
    setClosing(null);
    reload?.();
  };
  // All positions in the list, one by one — not in parallel, so the wallet nonces
  // do not overtake each other and if one fails the others are still tried. One confirmation
  // for all; each position's result is still reported individually.
  // `pair` (optional): the pool name if the list is only one pool's positions (Monitor),
  // so the confirmation does not read like closing the entire portfolio. `picked`: the list is
  // the rows the owner ticked in a table, not every open position.
  const closeAll = async (list, { pair = null, picked = false } = {}) => {
    if (closing != null || !list?.length) return;
    const value = list.reduce((s, p) => s + (p.valueUsd || 0), 0);
    const fee = list.reduce((s, p) => s + (p.feeUsd || 0), 0);
    const ok = await ask({
      title: pair ? t('Tutup semua {n} posisi {pair}?', { n: list.length, pair })
        : picked ? t('Tutup {n} posisi terpilih?', { n: list.length })
        : t('Tutup semua {n} posisi terbuka?', { n: list.length }),
      body: <div className="space-y-2">
        <div>{fee > 0.005
          ? t('Ditutup satu per satu; tiap posisi satu transaksi. Nilai sekarang {v} + fee {f}.', { v: usd(value), f: usd(fee) })
          : t('Ditutup satu per satu; tiap posisi satu transaksi. Nilai sekarang {v}.', { v: usd(value) })}</div>
        <LiveBatchEstimate list={list} />
      </div>,
      confirm: picked ? t('Tutup terpilih') : t('Tutup semua'), danger: true,
    });
    if (!ok) return false;
    for (const p of list) {
      await run(p);
      reload?.();   // the table shrinks while the rest is still running
    }
    setClosing(null);
    reload?.();
    return true;
  };
  // Force-close all open positions (the emergency button on the Positions page). The difference from
  // closeAll: the server bypasses the compound/claim guards that are still waiting, burns
  // liquidity according to the chain (not the records), and positions that are already empty on chain
  // are booked immediately. A failed position is skipped, the rest are still tried; at the end
  // it reports how many closed and how many failed.
  const forceCloseAll = async (list) => {
    if (closing != null || !list?.length) return;
    const value = list.reduce((s, p) => s + (p.valueUsd || 0), 0);
    const ok = await ask({
      title: t('Tutup paksa semua {n} posisi terbuka?', { n: list.length }),
      body: <div className="space-y-2">
        <div>{t('Semua posisi ditutup satu per satu tanpa menunggu compound/claim yang tertunda, dan likuiditas dibakar sesuai chain. Nilai sekarang {v}. Tidak bisa dibatalkan setelah berjalan.', { v: usd(value) })}</div>
        <LiveBatchEstimate list={list} />
      </div>,
      confirm: t('Tutup paksa semua'), danger: true,
    });
    if (!ok) return;
    let done = 0, failed = 0;
    for (const p of list) {
      const r = await run(p, { force: true });
      if (r?.ok) done++; else failed++;
      reload?.();
    }
    setClosing(null);
    reload?.();
    if (failed) toast.warning(t('Tutup paksa selesai: {d} tertutup, {f} gagal', { d: done, f: failed }), { timeout: 12000 });
    else toast.success(t('Tutup paksa selesai: {d} posisi tertutup', { d: done }), { timeout: 10000 });
  };
  return { close, closeAll, forceCloseAll, closing };
}

// The table toolbar for closing ticked rows. The checkboxes only appear after "Pilih" (select
// mode), so the table is not cluttered day to day: `sel` is null when select mode is off, else
// the DataTable selection (a Set of tableKey strings). `rows` are the rows the table shows;
// keys of rows that have since closed are ignored, not counted.
export function CloseSelected({ rows, sel, setSel, closeAll, closing, busy = false }) {
  const { t } = useI18n();
  if (!rows.length) return null;
  if (!sel) return <Button size="sm" variant="ghost" isDisabled={closing != null} onPress={() => setSel(new Set())}>{t('Pilih')}</Button>;
  const picked = rows.filter((p) => sel.has(String(tableKey(p, p.id))));
  const all = picked.length === rows.length;
  return <>
    <Button size="sm" variant="ghost" isDisabled={closing != null}
      onPress={() => setSel(all ? new Set() : new Set(rows.map((p) => String(tableKey(p, p.id)))))}>
      {all ? t('Batal pilih') : t('Pilih semua')}
    </Button>
    <Button size="sm" variant="danger-soft" isPending={closing != null} isDisabled={!picked.length || closing != null || busy}
      onPress={async () => { if (await closeAll(picked, { picked: true })) setSel(null); }}>
      {t('Tutup terpilih ({n})', { n: picked.length })}
    </Button>
    <Button size="sm" variant="ghost" isDisabled={closing != null} onPress={() => setSel(null)}>{t('Selesai')}</Button>
  </>;
}
