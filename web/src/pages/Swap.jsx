import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Spinner, Modal, Input, toast } from '@heroui/react';
import { ArrowDownUp, ArrowRight, Brush, Check, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, RefreshCw, CircleCheck, CircleX, Clock, Plus, Search, TriangleAlert, X } from 'lucide-react';
import { get, post } from '../api';
import { useStatus } from '../App';
import { usePoll } from '../hooks';
import { PageHeader, Notice, Loading, KV, Panel, Empty, Refreshing, TxHash } from '../components/ui';
import TokenIcon, { TokenSym } from '../components/TokenIcon';
import { usd, num, pct, short, ago, TXSTATUS } from '../fmt';
import { useI18n } from '../i18n';
import { isAddr, canonAddr, isSolana } from '../chain';

const PORTION = [['25%', '25%'], ['50%', '50%'], ['75%', '75%'], ['semua', 'Maks']];

// One token row in the picker: icon, symbol (+ "manual" marker), short address,
// balance and its value on the right.
function TokenRow({ x, onPick, disabled }) {
  const { t } = useI18n();
  return (
    <button type="button" disabled={disabled} onClick={() => onPick(x.address)}
      className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-default disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent">
      <TokenIcon address={x.address} symbol={x.symbol} size={30} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-semibold">{x.symbol}</span>
          {x.custom && <span className="rounded bg-default px-1.5 py-px text-[0.6875rem] font-medium text-muted">{t('manual')}</span>}
        </span>
        <span className="mono block truncate text-xs text-muted">{x.native ? 'native' : short(x.address)}</span>
      </span>
      <span className="shrink-0 text-end">
        <span className={`num block text-sm ${x.amount > 0 ? 'font-medium' : 'text-muted'}`}>{num(x.amount, 6)}</span>
        {x.usd != null && x.amount > 0 && <span className="num block text-xs text-muted">{usd(x.usd)}</span>}
      </span>
    </button>
  );
}

// A wallet-style token picker: the button is just icon + symbol, the dialog has a search
// box that also accepts 0x… addresses — a token not yet known can be added
// from there without ever having been a position.
function TokenPicker({ value, onChange, list, all, exclude, side, onImport }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [check, setCheck] = useState(null);   // the /api/address result for the pasted address
  const [add, setAdd] = useState(false);
  const cur = all.find((x) => x.address === value);
  const qq = q.trim().toLowerCase();
  const qa = canonAddr(q);   // address: the chain's canonical form (Solana is case-sensitive)

  const shown = useMemo(() => (qq
    ? list.filter((x) => x.symbol.toLowerCase().includes(qq) || x.address.toLowerCase().includes(qq))
    : list), [list, qq]);
  // An address that was pasted but is not in this side's list. If the token is already
  // known (e.g. an empty balance on the "from" side), there is no need to ask the chain.
  const known = isAddr(qa) ? all.find((x) => x.address === qa) : null;
  const needsCheck = isAddr(qa) && !shown.length && !known;

  useEffect(() => {
    setCheck(null);
    if (!needsCheck) return;
    let alive = true;
    setCheck({ loading: true });
    get(`/api/address?a=${qa}`).then((r) => { if (alive) setCheck(r); }).catch((e) => alive && setCheck({ error: e.message }));
    return () => { alive = false; };
  }, [qq, needsCheck]);

  const close = () => { setOpen(false); setQ(''); setCheck(null); };
  const pick = (a) => { onChange(a); close(); };
  const importKey = async () => {
    setAdd(true);
    const ok = await onImport(qq, side);
    setAdd(false);
    if (ok) close();
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={t(side === 'from' ? 'Token yang ditukar' : 'Token yang diterima')}
        className="flex h-10 max-w-40 shrink-0 items-center gap-2 rounded-full border border-border bg-surface pl-1.5 pr-2.5 transition-colors hover:bg-default">
        {cur ? (
          <><TokenIcon address={cur.address} symbol={cur.symbol} size={26} />
            <span className="truncate font-semibold">{cur.symbol}</span></>
        ) : <span className="pl-2 text-sm font-medium">{t('Pilih token')}</span>}
        <ChevronDown className="size-4 shrink-0 text-muted" />
      </button>

      <Modal isOpen={open} onOpenChange={(o) => { if (!o) close(); }}>
        <Modal.Backdrop isDismissable>
          <Modal.Container size="sm" placement="center">
            <Modal.Dialog className="w-[min(24rem,calc(100vw-2rem))]">
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>{t(side === 'from' ? 'Tukar dari' : 'Tukar ke')}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-3 text-foreground">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                  <Input autoFocus variant="secondary" className="w-full pl-9" value={q} onChange={(e) => setQ(e.target.value)}
                    placeholder={t(isSolana() ? 'Cari simbol atau tempel alamat mint…' : 'Cari simbol atau tempel alamat 0x…')} aria-label={t('Cari token')} />
                </div>

                {!qq && side === 'to' && (
                  <div className="flex flex-wrap gap-1.5">
                    {all.filter((x) => x.isQuote).map((x) => (
                      <button key={x.address} type="button" disabled={x.address === exclude} onClick={() => pick(x.address)}
                        className={`flex h-8 items-center gap-1.5 rounded-full border pl-1 pr-3 text-sm font-medium transition-colors disabled:opacity-40 ${x.address === value
                          ? 'border-accent bg-accent/10' : 'border-border hover:bg-default'}`}>
                        <TokenIcon address={x.address} symbol={x.symbol} size={22} />{x.symbol}
                      </button>
                    ))}
                  </div>
                )}

                <div className="-mx-1 max-h-[22rem] overflow-y-auto">
                  {shown.map((x) => (
                    <TokenRow key={x.address} x={x} onPick={pick} disabled={x.address === exclude} />
                  ))}

                  {!shown.length && known && (
                    <div className="px-2.5 py-6 text-center text-sm text-muted">
                      {t('{s} sudah ada di daftar, tapi saldonya kosong — tidak bisa dijadikan sumber swap.', { s: known.symbol })}
                    </div>
                  )}
                  {!shown.length && needsCheck && (
                    check?.loading ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted"><Spinner size="sm" color="current" />{t('Memeriksa alamat…')}</div>
                    ) : check?.kind === 'token' ? (
                      <div className="flex items-center gap-3 rounded-md border border-border p-3">
                        <TokenIcon address={qq} symbol={check.symbol} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold">{check.symbol}</span>
                          <span className="block truncate text-xs text-muted">{check.name || short(qq)}</span>
                        </span>
                        <Button size="sm" onPress={importKey} isPending={add}><Plus className="size-4" />{t('Tambahkan')}</Button>
                      </div>
                    ) : check ? (
                      <div className="px-2.5 py-6 text-center text-sm text-danger">
                        {check.error || (check.kind === 'wallet' ? t('Itu alamat wallet, bukan token.') : t(isSolana() ? 'Alamat ini bukan mint token.' : 'Kontrak ini bukan token ERC-20.'))}
                      </div>
                    ) : null
                  )}
                  {!shown.length && !isAddr(qa) && (
                    <div className="px-2.5 py-6 text-center text-sm text-muted">
                      {!isSolana() && qq.startsWith('0x') ? t('Alamat belum lengkap — 0x diikuti 40 karakter.') : t('Tidak ada yang cocok. Tempel alamat kontraknya untuk menambahkan token baru.')}
                    </div>
                  )}
                </div>

                {!qq && (
                  <p className="text-xs text-muted">
                    {t(side === 'from'
                      ? 'Hanya token yang ada saldonya. Token lain bisa ditambahkan dengan menempel alamat kontraknya.'
                      : 'Token yang tidak ada di daftar bisa ditambahkan dengan menempel alamat kontraknya.')}
                  </p>
                )}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

// Balance panel beside the swap card: what is in the bot wallet, its value, and the
// manual tokens (which can be removed again). Click a row = use it as the "from" side.
const PER_HAL = 5;
// Valued = has a price and its value is at least one cent; the rest (no price / dust)
// are collected below so meaningful assets do not drown among memecoins.
const valued = (x) => x.usd != null && x.usd >= 0.01;
// (A hidden token can still be chosen via the token picker in the swap card.)

function Holdings({ tokens, dari: from, onUse, onRemove, onImport, harga: price, onRetryPrice }) {
  const { t } = useI18n();
  const [addr, setAddr] = useState('');
  const [sendOrig, setSending] = useState(false);
  const [sweepAll, setSweep] = useState(false);
  const [hal, setHal] = useState(0);
  const [every, setAll] = useState(false);
  const allRows = useMemo(() => tokens.filter((x) => x.amount > 0 || x.custom)
    .sort((a, b) => (valued(b) - valued(a)) || (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount), [tokens]);
  const total = allRows.reduce((s, x) => s + (x.usd || 0), 0);
  const hasPrice = allRows.some((x) => x.usd != null);
  const nValued = allRows.filter(valued).length;
  // Tokens without value are hidden — but only after the price has really been read;
  // while loading or if the price failed, hiding would mean an empty panel.
  const hide = price === 'ok' && !every;
  const rows = hide ? allRows.filter(valued) : allRows;
  const nHidden = price === 'ok' ? allRows.length - nValued : 0;
  const nHal = Math.max(1, Math.ceil(rows.length / PER_HAL));
  const halIni = Math.min(hal, nHal - 1);
  const from0 = halIni * PER_HAL;
  const shownVal = rows.slice(from0, from0 + PER_HAL);
  const a = canonAddr(addr);

  const add = async () => {
    setSending(true);
    const ok = await onImport(a, 'panel');
    setSending(false);
    if (ok) setAddr('');
  };

  // Put idle memecoins in the wallet into the automatic sell queue. No transaction is
  // sent here: what sells is still the queue, with the same loss
  // limit. Dust below the threshold is deliberately not queued.
  const sweepLeftover = async () => {
    setSweep(true);
    const r = await post('/api/leftovers/sweep', {});
    setSweep(false);
    if (r.error) return toast.danger(r.error, { timeout: 12000 });
    if (r.queued?.length) {
      return toast.success(t('{n} token masuk antrean jual', { n: r.queued.length }), {
        description: r.queued.map((x) => x.label).join(', '), timeout: 12000,
      });
    }
    return toast.warning(t('Tidak ada sisa yang layak dijual'), {
      description: r.skipped?.length
        ? t('{n} token dilewat: {w}', { n: r.skipped.length, w: r.skipped.slice(0, 3).map((x) => `${x.label} — ${x.why}`).join(' · ') })
        : t('Wallet cuma berisi aset kuotasi dan token posisi yang masih terbuka.'),
      timeout: 14000,
    });
  };

  return (
    <Panel title="Aset di wallet" desc="Klik baris untuk menukarnya."
      action={(
        <span className="flex items-center gap-2">
          {price === 'muat' && <Refreshing loading text="Memuat harga…" />}
          {price === 'gagal' && (
            <Button size="sm" variant="ghost" onPress={onRetryPrice} className="text-danger">
              <RefreshCw className="size-3.5" />{t('Harga gagal — coba lagi')}
            </Button>
          )}
          {hasPrice && <span className="num text-sm font-semibold">{usd(total)}</span>}
          <Button size="sm" variant="outline" onPress={sweepLeftover} isPending={sweepAll}>
            <Brush className="size-3.5" />{t('Sapu sisa')}
          </Button>
        </span>
      )} bodyClass="p-0">
      {rows.length ? (
        <div className="divide-y divide-border">
          {shownVal.map((x, i) => (
            <div key={x.address}>
            {/* group divider: the first row that has no value */}
            {!hide && price === 'ok' && nValued > 0 && from0 + i === nValued && (
              <div className="border-b border-border bg-default/40 px-4 py-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted">
                {t('Tanpa nilai ({n})', { n: nHidden })}
              </div>
            )}
            <div className={`group flex items-center gap-3 px-4 py-2.5 text-sm ${x.address === from ? 'bg-accent/5' : ''}`}>
              <button type="button" disabled={!(x.amount > 0)} onClick={() => onUse(x.address)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default">
                <TokenIcon address={x.address} symbol={x.symbol} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <TokenSym address={x.address} symbol={x.symbol} className="truncate font-medium" />
                    {x.custom && <span className="rounded bg-default px-1.5 py-px text-[0.6875rem] font-medium text-muted">{t('manual')}</span>}
                  </span>
                  <span className="num block truncate text-xs text-muted">
                    {x.priceUsd != null ? usd(x.priceUsd, x.priceUsd < 1 ? 6 : 2) : price === 'muat' ? '…' : t('tanpa harga')}
                  </span>
                </span>
                <span className="shrink-0 text-end">
                  <span className={`num block ${x.amount > 0 ? 'font-medium' : 'text-muted'}`}>{num(x.amount, 6)}</span>
                  <span className="num block text-xs text-muted">{x.usd != null ? usd(x.usd) : ''}</span>
                </span>
              </button>
              {x.custom && (
                <Button size="sm" variant="ghost" isIconOnly aria-label={t('Hapus dari daftar')} onPress={() => onRemove(x)}
                  className="-mr-2 size-7 text-muted">
                  <X className="size-3.5" />
                </Button>
              )}
            </div>
            </div>
          ))}
        </div>
      ) : <div className="p-4"><Empty title={nHidden ? 'Tidak ada aset bernilai' : 'Wallet kosong'} /></div>}

      {(nHal > 1 || nHidden > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-muted">
          <span className="flex items-center gap-2">
            {rows.length > 0 && <span className="num">{t('{a}–{b} dari {n}', { a: from0 + 1, b: Math.min(from0 + PER_HAL, rows.length), n: rows.length })}</span>}
            {nHidden > 0 && (
              <button type="button" onClick={() => { setAll((v) => !v); setHal(0); }}
                className="inline-flex items-center gap-1 rounded px-1 text-accent hover:underline">
                {every ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                {every ? t('Sembunyikan {n} tanpa nilai', { n: nHidden }) : t('Tampilkan {n} tanpa nilai', { n: nHidden })}
              </button>
            )}
          </span>
          {nHal > 1 && <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Sebelumnya')} isDisabled={halIni === 0}
              onPress={() => setHal(halIni - 1)} className="size-7"><ChevronLeft className="size-4" /></Button>
            <span className="num min-w-10 text-center">{halIni + 1} / {nHal}</span>
            <Button size="sm" variant="ghost" isIconOnly aria-label={t('Berikutnya')} isDisabled={halIni >= nHal - 1}
              onPress={() => setHal(halIni + 1)} className="size-7"><ChevronRight className="size-4" /></Button>
          </span>}
        </div>
      )}

      {/* input token manual */}
      <form className="flex gap-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); if (isAddr(a)) add(); }}>
        <Input variant="secondary" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={t(isSolana() ? 'Tambah token: alamat mint…' : 'Tambah token: alamat 0x…')}
          aria-label={t('Alamat token')} className="mono min-w-0 flex-1 text-xs" />
        <Button type="submit" size="sm" variant="outline" className="h-9" isDisabled={!isAddr(a)} isPending={sendOrig}>
          <Plus className="size-4" />{t('Tambah')}
        </Button>
      </form>
    </Panel>
  );
}

// History of all txs that exchange assets, from the txs table (see src/swaplog.js): manual
// swaps, the zap when opening an LP, leftover sale on close, selling back the zap token that
// did not become an LP, fee sales, bridge, gas top-up, WETH — plus fee claims & compounds.
// Old rows (before token & amount were recorded) only have their USD value.
const STATUS_ICON = { sukses: CircleCheck, pending: Clock, gagal: CircleX };
const AGG = { okx: 'OKX', lifi: 'LI.FI', zerox: '0x', oneinch: '1inch', openocean: 'OpenOcean' };
// DEX names from Kyber arrive raw ("uniswapv3", "uniswap-v4"); tidy up only the known ones.
const dexName = (s) => String(s).replace(/^uniswap-?v(\d)$/i, 'Uniswap v$1').replace(/^kyberswap.*/i, 'KyberSwap');
const STATUS_CLS = {
  sukses: 'bg-success/10 text-success', pending: 'bg-warning/10 text-warning', gagal: 'bg-danger/10 text-danger',
};
// Where the swap came from: [label, explanation, badge colour].
const METHOD = {
  manual: ['Manual', 'Dikirim dari halaman ini atau bot Telegram', 'bg-accent/10 text-accent'],
  zap: ['Buka LP', 'Zap: membeli sisi token supaya posisi LP bisa dibuka', 'bg-success/10 text-success'],
  exit: ['Tutup LP', 'Menjual token sisa hasil menutup posisi', 'bg-warning/10 text-warning'],
  unwind: ['Jual balik', 'Token zap yang tidak jadi LP (mint gagal atau kelebihan) dijual kembali', 'bg-danger/10 text-danger'],
  fee_sell: ['Jual fee', 'Menjual sisi memecoin dari fee yang diklaim', 'bg-success/10 text-success'],
  sweep: ['Sapu wallet', 'Token yang tertinggal di wallet dijual', 'bg-default text-muted'],
  leftover: ['Jual sisa', 'Token sisa di wallet (zap tanpa LP atau sapuan)', 'bg-default text-muted'],
  bridge: ['Jembatan', 'Menukar ETH ⇄ stablecoin supaya entry punya aset yang dibutuhkan', 'bg-default text-muted'],
  gas: ['Isi gas', 'Membeli ETH untuk gas dari stablecoin', 'bg-default text-muted'],
  wrap: ['Bungkus ETH', 'ETH → WETH', 'bg-default text-muted'],
  unwrap: ['Buka WETH', 'WETH → ETH', 'bg-default text-muted'],
  claim: ['Klaim fee', 'Fee posisi LP ditarik ke wallet', 'bg-success/10 text-success'],
  compound: ['Compound', 'Fee disetor kembali ke posisi', 'bg-success/10 text-success'],
};
const FILTER = [
  ['', 'Semua'],
  ['swap_manual', 'Manual'],
  ['zap_swap,sell_leftover', 'Posisi LP'],
  ['claim_fees,compound', 'Fee'],
  ['bridge_swap,gas_topup,wrap_eth,unwrap_weth', 'Lainnya'],
];

function SwapRow({ x }) {
  const { t } = useI18n();
  const d = x.detail || {};
  const st = TXSTATUS[x.status];
  const Icon = STATUS_ICON[x.status] || Clock;
  const cls = STATUS_CLS[x.status] || 'bg-default text-muted';
  const m = METHOD[x.method];
  const c = x.claim;
  // Value difference: what percent was lost (or gained) between the value in and out.
  const diff = d.usdIn > 0 && d.usdOut != null ? ((d.usdOut - d.usdIn) / d.usdIn) * 100 : null;
  const meta = [
    m && (
      <span key="m" title={t(m[1])} className={`rounded px-1.5 py-px text-[0.6875rem] font-medium ${m[2]}`}>{t(m[0])}</span>
    ),
    x.position != null && (
      <a key="pos" href={'#positions/' + x.position} className="num hover:text-foreground hover:underline">
        #{x.position}{x.pair ? ` ${x.pair}` : ''}
      </a>
    ),
    (d.usdIn != null && d.usdOut != null) ? <span key="usd" className="num">{usd(d.usdIn)} → {usd(d.usdOut)}</span>
      : (d.usdIn ?? d.usdOut) != null && <span key="usd" className="num">≈ {usd(d.usdIn ?? d.usdOut)}</span>,
    diff != null && Math.abs(diff) >= 0.05 && (
      <span key="pct" className={`num ${diff < -1 ? 'text-danger' : diff > 0 ? 'text-success' : ''}`}>{pct(diff, 2)}</span>
    ),
  ].filter(Boolean);
  // Second row: which route the swap took and its gas cost.
  const routeVal = [
    x.route === 'pool' && <span key="rt">{t('pool langsung')}</span>,
    x.route === 'kyber' && <span key="rt" className="truncate">{d.dex ? t('Kyber lewat {d}', { d: dexName(d.dex) }) : 'Kyber'}</span>,
    x.route && !['pool', 'kyber'].includes(x.route) && <span key="rt" className="truncate">{d.dex ? t('{a} lewat {d}', { a: AGG[x.route] || x.route, d: dexName(d.dex) }) : (AGG[x.route] || x.route)}</span>,
    x.gasUsd != null && <span key="gas" className="num">{t('gas {v}', { v: usd(x.gasUsd, x.gasUsd < 0.01 ? 4 : 2) })}</span>,
  ].filter(Boolean);
  const Chip = () => (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${cls}`}>
      <Icon className="size-3" />{t(st?.[0] || x.status)}
    </span>
  );

  let heading;
  if (c) {
    // Fee claim: the two pool sides withdrawn, not an exchange.
    const sideOf = [[c.amount0, c.token0, c.symbol0], [c.amount1, c.token1, c.symbol1]].filter(([a]) => a == null || a > 0);
    heading = (
      <>
        {sideOf.map(([a, tok, s], i) => (
          <span key={tok} className="whitespace-nowrap">
            {i > 0 && <span className="text-muted">+ </span>}
            {a != null && <><span className="num">{num(a, 6)}</span> </>}<TokenSym address={tok} symbol={s} />
          </span>
        ))}
      </>
    );
  } else if (x.kind === 'compound') {
    heading = <span>{t('Compound fee ke posisi')}</span>;
  } else if (d.symbolIn) {
    heading = (
      <>
        <span className="whitespace-nowrap">{d.amountIn != null && <><span className="num">{num(d.amountIn, 6)}</span> </>}<TokenSym address={d.tokenIn} symbol={d.symbolIn} /></span>
        <ArrowRight className="size-3.5 shrink-0 text-muted" />
        <span className="whitespace-nowrap">
          {d.amountOut > 0 ? <><span className="num">{num(d.amountOut, 6)}</span> </> : null}<TokenSym address={d.tokenOut} symbol={d.symbolOut} />
        </span>
      </>
    );
  } else heading = <span className="num">{d.usdIn != null || d.usdOut != null ? `${usd(d.usdIn)} → ${usd(d.usdOut)}` : t('Swap')}</span>;

  const iconA = c ? c.token0 : d.tokenIn, iconB = c ? c.token1 : d.tokenOut;
  return (
    <div className="flex items-start gap-3 px-4 py-3 text-sm">
      {/* pasangan lambang: token dijual di depan, token diterima menyusul di belakangnya */}
      <span className="mt-0.5 flex shrink-0 items-center">
        <TokenIcon address={iconA} symbol={c ? c.symbol0 : d.symbolIn} size={28} />
        <TokenIcon address={iconB} symbol={c ? c.symbol1 : d.symbolOut} size={28} className="-ml-2" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium">{heading}</div>
        {[meta, routeVal].map((row, j) => row.length > 0 && (
          <div key={j} className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
            {/* the separator dot sticks to the RIGHT of each item except the last: if the row
                wraps, no orphan dot starts the new line */}
            {row.map((el, i) => <span key={el.key} className="flex min-w-0 items-center gap-1.5">{el}{i < row.length - 1 && <span aria-hidden="true">·</span>}</span>)}
          </div>
        ))}
        {x.status === 'gagal' && x.error && (
          <div className="mt-1 flex items-start gap-1 text-xs text-danger">
            <TriangleAlert className="mt-px size-3 shrink-0" /><span className="line-clamp-2 break-words">{x.error}</span>
          </div>
        )}
        {/* on mobile: hash & time move below so the right column does not shrink */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted sm:hidden">
          <Chip /><TxHash hash={x.hash} /><span aria-hidden="true">·</span><span className="tabular-nums">{ago(x.ts)}</span>
        </div>
      </div>

      <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
        <Chip />
        <span className="flex items-center gap-2 text-xs text-muted">
          <TxHash hash={x.hash} /><span aria-hidden="true">·</span><span className="tabular-nums" title={new Date(x.ts).toLocaleString()}>{ago(x.ts)}</span>
        </span>
      </div>
    </div>
  );
}

function History() {
  const { t } = useI18n();
  const [kindName, setKind] = useState('');
  const { data, loading } = usePoll(`/api/manual/swaps?limit=30${kindName ? `&kinds=${kindName}` : ''}`, 15000);
  const list = data?.swaps || [];
  const compact = list.reduce((a, x) => (x.status === 'sukses' ? a + 1 : a), 0);
  return (
    <Panel title="Riwayat swap" desc="Swap manual, zap & jual sisa posisi LP, klaim fee, jembatan dan isi gas."
      action={(
        <span className="flex items-center gap-2 text-xs text-muted">
          <Refreshing loading={loading} />
          {list.length > 0 && <span className="num">{t('{n} sukses', { n: compact })}</span>}
          <a href="#activity" className="inline-flex items-center gap-1 text-accent hover:underline">{t('Semua')}<ChevronRight className="size-3" /></a>
        </span>
      )} bodyClass="p-0">
      <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5" role="tablist" aria-label={t('Jenis swap')}>
        {FILTER.map(([k, label]) => (
          <button key={k || 'semua'} type="button" role="tab" aria-selected={kindName === k} onClick={() => setKind(k)}
            className={`h-7 rounded-md border px-2.5 text-xs font-medium transition-colors ${kindName === k
              ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-foreground'}`}>
            {t(label)}
          </button>
        ))}
      </div>
      {list.length ? (
        <div className="max-h-[36rem] divide-y divide-border overflow-y-auto">
          {list.map((x) => <SwapRow key={x.hash} x={x} />)}
        </div>
      ) : <div className="p-4"><Empty title="Belum ada swap" sub="Swap dari halaman ini, bot Telegram, dan posisi LP muncul di sini." /></div>}
    </Panel>
  );
}

function RouteRow({ active, disabled, onPress, title, sub, right, best }) {
  return (
    <button type="button" disabled={disabled} onClick={onPress}
      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition ${active ? 'border-accent bg-accent/5' : 'border-border hover:bg-default/50'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
      <span className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${active ? 'border-accent' : 'border-border'}`}>
        {active && <span className="size-2 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium">{title}{best && <Check className="size-3.5 text-success" />}</span>
        {sub ? <span className="block truncate text-xs text-muted">{sub}</span> : null}
      </span>
      {right}
    </button>
  );
}

export default function Swap() {
  const { t } = useI18n();
  const { status, reload: reloadStatus } = useStatus();
  const [tokens, setTokens] = useState(null);
  const [price, setPrice] = useState('muat');   // 'loading' | 'ok' | 'failed'
  const [from, setFrom] = useState('');
  const [ke, setKe] = useState('');
  const [qty, setAmount] = useState('');
  const [rawQuote, setQuote] = useState(null);
  const [agg, setAgg] = useState('auto');   // 'auto' = best route, or an aggregator id
  const [take, setTake] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sendOrig, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [flipRate, setFlipRate] = useState(false);
  const seq = useRef(0);
  const loadSeq = useRef(0);

  // Balances first (fast, straight from the chain), USD prices follow — DexScreener can be
  // slow and the page need not wait for it.
  const pasang = (list) => {
    setTokens(list);
    // Initial choice: the asset with the largest balance, swapped to a DIFFERENT quote asset.
    // If the "to" side is chosen without looking at the "from" side, both can land on the same
    // token (USDG has the largest balance and is also the default quote) — the page then
    // goes silent with no quote and no explanation.
    const d0 = list.find((x) => x.amount > 0)?.address || '';
    const k0 = list.find((x) => x.isQuote && x.address !== d0)?.address
      || list.find((x) => x.address !== d0)?.address || '';
    setFrom((v) => v || d0);
    setKe((v) => v || k0);
  };
  const load = async () => {
    const mine = ++loadSeq.current;
    const d = await get('/api/manual/tokens');
    if (mine !== loadSeq.current) return d.tokens || [];
    pasang(d.tokens || []);
    loadPrice(d.tokens || [], mine);
    return d.tokens || [];
  };
  // Prices follow via their own endpoint — it does not re-read balances, so an RPC
  // that is being rate limited does not wipe out all the prices.
  const loadPrice = async (list, mine = loadSeq.current) => {
    const addrs = list.filter((x) => x.amount > 0 || x.isQuote || x.custom).map((x) => x.address);
    if (!addrs.length) return setPrice('ok');
    setPrice('muat');
    const r = await post('/api/manual/prices', { addresses: addrs });
    if (mine !== loadSeq.current) return undefined;
    if (r.error || !r.prices) return setPrice('gagal');
    setTokens((cur) => (cur || []).map((x) => {
      if (!(x.address in r.prices)) return x;
      const priceUsd = r.prices[x.address];
      return { ...x, priceUsd, usd: priceUsd != null ? x.amount * priceUsd : null };
    }));
    return setPrice('ok');
  };
  useEffect(() => { load(); }, []);

  const byAddr = useMemo(() => new Map((tokens || []).map((x) => [x.address, x])), [tokens]);
  const tFrom = byAddr.get(from);
  const tKe = byAddr.get(ke);
  const has = useMemo(() => (tokens || []).filter((x) => x.amount > 0), [tokens]);
  const ready = from && ke && from !== ke && String(qty).trim() !== '';

  // The scan returns every aggregator's quote at once, so picking one is a local switch:
  // the headline numbers follow the chosen row without asking the server again.
  const routes = rawQuote?.routes || null;
  const picked = routes && agg !== 'auto' ? routes.find((r) => r.id === agg) : null;
  const quote = useMemo(() => {
    if (!rawQuote || !picked) return rawQuote;
    if (picked.state !== 'ok') return { ...rawQuote, error: picked.state === 'off' ? `${picked.label}: ${picked.blocker}` : `${picked.label} tidak menemukan rute untuk pasangan ini` };
    return { ...rawQuote, error: undefined, amountOut: picked.amountOut, usdIn: picked.usdIn, usdOut: picked.usdOut, lossBps: picked.lossBps,
      tooLossy: picked.tooLossy, dex: picked.dex, chosen: picked.id, chosenLabel: picked.label };
  }, [rawQuote, picked]);

  // The quote is fetched itself every time the choice changes; stale replies are discarded.
  useEffect(() => {
    setConfirm(false);
    if (!ready) { setQuote(null); return; }
    const mine = ++seq.current;
    setTake(true);
    const id = setTimeout(async () => {
      const r = await post('/api/manual/swap/quote', { tokenIn: from, tokenOut: ke, amount: qty, aggregator: 'auto' });
      if (mine !== seq.current) return;
      setQuote(r); setTake(false);
    }, 450);
    return () => clearTimeout(id);
  }, [from, ke, qty, ready]);

  const flip = () => { setFrom(ke); setKe(from); setAmount(''); };

  // A token from the pasted address. One with an empty balance cannot be a swap
  // source, so on the "from" side (and the panel) it is only placed on the "to" side.
  const importKey = async (address, side) => {
    const r = await post('/api/manual/tokens/add', { address });
    if (r.error) { toast.danger(r.error); return false; }
    const list = await load();
    const tk = list.find((x) => x.address === address);
    const sym = tk?.symbol || r.token?.symbol || short(address);
    if (side !== 'to' && tk?.amount > 0) {
      if (address === ke) setKe(from);
      setFrom(address);
      toast.success(t('{s} ditambahkan', { s: sym }));
    } else {
      if (address === from) setFrom(ke);
      setKe(address);
      toast.success(side === 'to' ? t('{s} ditambahkan', { s: sym })
        : t('{s} ditambahkan — saldonya kosong, jadi dipasang sebagai token tujuan', { s: sym }));
    }
    return true;
  };
  const remove = async (x) => {
    await post('/api/manual/tokens/remove', { address: x.address });
    // A removed token can vanish from the list; an empty choice is refilled
    // with the default by load().
    if (x.address === ke) setKe('');
    if (x.address === from) setFrom('');
    load();
  };
  const use = (a) => {
    if (a === ke) setKe(from);
    setFrom(a); setAmount('');
  };

  const swap = async () => {
    setSending(true);
    const r = await post('/api/manual/swap', { tokenIn: from, tokenOut: ke, amount: qty, aggregator: agg });
    setSending(false); setConfirm(false);
    if (r.error) return toast.danger(r.error);
    setResult(r);
    toast.success(t('Swap selesai'));
    load(); reloadStatus();
  };

  const dry = status?.mode?.dry_run !== false;
  const header = <PageHeader group="Aksi" title="Swap"
    desc={isSolana() ? 'Menukar aset lewat agregator Jupiter — rute yang sama dipakai bot untuk membeli token posisi dan menjual memecoin sisa.' : 'Menukar aset lewat agregator: halaman ini memindai semua agregator yang aktif, memilih rute terbaik, atau kamu pilih sendiri. Kunci dan urutannya diatur di Pengaturan → Agregator swap.'} />;

  if (tokens === null) return (<>{header}<Loading page /></>);

  if (result) {
    return (
      <>
        {header}
        <Card className="mx-auto max-w-lg">
          <Card.Content className="items-center gap-4 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-6" /></span>
            <div>
              <div className="text-lg font-semibold">{t('Swap selesai')}</div>
              <div className="mt-1 text-muted">{result.note}</div>
              {result.dex && <div className="text-sm text-muted">{t('lewat {d}', { d: result.dex })}</div>}
              <div className="mono mt-2 text-sm text-muted">{result.tx}</div>
            </div>
            <Button variant="outline" onPress={() => { setResult(null); setAmount(''); }}>{t('Tukar lagi')}</Button>
          </Card.Content>
        </Card>
      </>
    );
  }

  // Not a single asset with a balance: the swap card cannot be used at all,
  // so it is more honest to explain why than to display empty fields.
  if (!has.length) {
    return (
      <>
        {header}
        <Card className="mx-auto max-w-lg">
          <Card.Content className="items-center gap-4 py-10 text-center">
            <div>
              <div className="font-medium">{t('Belum ada aset yang bisa ditukar')}</div>
              <p className="mt-1 text-sm text-muted">
                {t(isSolana() ? 'Wallet bot kosong. Isi dengan SOL atau USDC dulu — alamatnya ada di Pengaturan.' : 'Wallet bot kosong. Isi dengan ETH atau USDG dulu — alamatnya ada di Pengaturan.')}
              </p>
            </div>
            <Button variant="outline" onPress={() => { location.hash = 'settings'; }}>{t('Buka Pengaturan')}</Button>
          </Card.Content>
        </Card>
      </>
    );
  }

  const usdIn = quote && !quote.error ? quote.usdIn : (tFrom?.priceUsd != null && Number(qty) > 0 ? Number(qty) * tFrom.priceUsd : null);
  const rate = quote && !quote.error && quote.amountIn > 0 && quote.amountOut > 0
    ? (flipRate ? `1 ${quote.symbolOut} = ${num(quote.amountIn / quote.amountOut, 6)} ${quote.symbolIn}`
      : `1 ${quote.symbolIn} = ${num(quote.amountOut / quote.amountIn, 6)} ${quote.symbolOut}`)
    : null;
  const minOut = quote && !quote.error && quote.slippageBps != null ? quote.amountOut * (1 - quote.slippageBps / 10000) : null;

  return (
    <>
      {header}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] xl:gap-6">
        {/* kolom kiri: kartu swap */}
        <div className="flex min-w-0 flex-col gap-3">
          {dry && (
            <Notice status="warning" title={t('Mode simulasi')}>
              {t('Kutipan tetap diambil, tapi transaksi tidak akan dikirim. Nyalakan LIVE di Pengaturan kalau memang mau menukar.')}
            </Notice>
          )}

          <Card className="gap-0! p-2!">
            {/* from */}
            <div className="rounded-md bg-default/50 p-4">
              <div className="flex items-center justify-between gap-3 text-xs text-muted">
                <span className="font-medium">{t('Dari')}</span>
                {tFrom && <span>{t('Saldo')} <span className="num">{num(tFrom.amount, 6)}</span></span>}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <input value={qty} onChange={(e) => setAmount(e.target.value)} placeholder="0" inputMode="decimal"
                  aria-label={t('Jumlah yang ditukar')}
                  className="num h-10 min-w-0 flex-1 bg-transparent text-[1.75rem] font-semibold tracking-tight outline-none placeholder:text-muted/60" />
                <TokenPicker side="from" value={from} onChange={setFrom} list={has} all={tokens} exclude={ke} onImport={importKey} />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span className="num text-xs text-muted">{usdIn != null ? `≈ ${usd(usdIn)}` : ''}</span>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {PORTION.map(([v, label]) => (
                    <button key={v} type="button" onClick={() => setAmount(v)}
                      className={`h-6 rounded-md border px-2 text-xs font-medium transition-colors ${qty === v
                        ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-foreground'}`}>{t(label)}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* pembalik */}
            <div className="relative z-10 -my-2.5 flex justify-center">
              <Button size="sm" variant="outline" isIconOnly aria-label={t('Balik arah')} onPress={flip}
                isDisabled={!(tKe?.amount > 0)}
                className="size-9 rounded-lg! border-4! border-surface! bg-default">
                <ArrowDownUp className="size-4" />
              </Button>
            </div>

            {/* ke */}
            <div className="rounded-md bg-default/50 p-4">
              <div className="flex items-center justify-between gap-3 text-xs text-muted">
                <span className="font-medium">{t('Ke')}</span>
                {tKe && <span>{t('Saldo')} <span className="num">{num(tKe.amount, 6)}</span></span>}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <div className={`num flex h-10 min-w-0 flex-1 items-center truncate text-[1.75rem] font-semibold tracking-tight ${quote?.amountOut != null ? '' : 'text-muted/60'}`}>
                  {take ? <Spinner size="sm" /> : quote?.amountOut != null ? num(quote.amountOut, 6) : '0'}
                </div>
                <TokenPicker side="to" value={ke} onChange={setKe} list={tokens} all={tokens} exclude={from} onImport={importKey} />
              </div>
              <div className="num mt-3 h-4 text-xs text-muted">{quote?.usdOut != null && !take ? `≈ ${usd(quote.usdOut)}` : ''}</div>
            </div>
          </Card>

          {ready && routes && (
            <Card className="gap-0! px-4! py-3!">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t('Rute agregator')}</span>
                <span className="text-xs text-muted">{t('{n} dari {m} menemukan rute', { n: routes.filter((r) => r.state === 'ok').length, m: routes.length })}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <RouteRow active={agg === 'auto'} onPress={() => setAgg('auto')} title={t('Otomatis · terbaik')}
                  sub={rawQuote.chosenLabel && !rawQuote.error ? t('sekarang: {a}', { a: routes.find((r) => r.best)?.label || '—' }) : ''} />
                {routes.map((r) => {
                  const top = routes.find((x) => x.best);
                  const diff = r.state === 'ok' && top?.amountOut > 0 ? (r.amountOut / top.amountOut - 1) * 100 : null;
                  return (
                    <RouteRow key={r.id} active={agg === r.id} disabled={r.state === 'off'} onPress={() => setAgg(r.id)}
                      title={r.label} best={r.best}
                      sub={r.state === 'off' ? t(r.blocker) : r.state === 'noroute' ? t('tidak ada rute') : [r.dex && r.dex.replace(/^[^:]+: ?/, ''), r.ms != null ? `${r.ms} ms` : null].filter(Boolean).join(' · ')}
                      right={r.state === 'ok' ? (
                        <div className="text-right">
                          <div className="num text-sm font-medium">{num(r.amountOut, 6)} {rawQuote.symbolOut}</div>
                          <div className={`num text-xs ${r.tooLossy ? 'text-danger' : 'text-muted'}`}>
                            {diff != null && diff < -0.005 ? `${num(diff, 2)}%` : t('terbaik')}{r.lossBps != null ? ` · ${t('rugi')} ${num(r.lossBps / 100, 2)}%` : ''}
                          </div>
                        </div>
                      ) : null} />
                  );
                })}
              </div>
              {agg !== 'auto' && <p className="mt-2 text-xs text-muted">{t('Swap hanya lewat {a}; kalau gagal tidak pindah ke agregator lain.', { a: picked?.label || agg })}</p>}
            </Card>
          )}

          {ready && quote?.error && <Notice status="danger" title={t('Tidak bisa dikutip')}>{quote.error}</Notice>}

          {quote && !quote.error && (
            <Card className="gap-0! px-4! py-1.5!">
              <div className="divide-y divide-border">
                {rate && (
                  <KV label="Kurs">
                    <button type="button" onClick={() => setFlipRate((v) => !v)} title={t('Balik kurs')}
                      className="inline-flex items-center gap-1 hover:text-accent">{rate}<ArrowDownUp className="size-3 text-muted" /></button>
                  </KV>
                )}
                <KV label="Dikirim">{num(quote.amountIn, 6)} {quote.symbolIn}</KV>
                <KV label="Diterima">{num(quote.amountOut, 6)} {quote.symbolOut}</KV>
                {minOut != null && (
                  <KV label="Minimal diterima">
                    {num(minOut, 6)} {quote.symbolOut}
                    <span className="font-normal text-muted"> · {t('slippage {p}%', { p: num(quote.slippageBps / 100, 2) })}</span>
                  </KV>
                )}
                <KV label="Nilai">{usd(quote.usdIn)} → {usd(quote.usdOut)}</KV>
                <KV label="Biaya rute"><span className={quote.tooLossy ? 'text-danger' : quote.lossBps > 300 ? 'text-warning' : ''}>
                  {quote.lossBps != null ? `${num(quote.lossBps / 100, 2)}%` : '—'}</span></KV>
                {quote.dex && <KV label="Lewat"><span className="font-normal text-muted">{quote.dex}</span></KV>}
              </div>
            </Card>
          )}

          {quote?.tooLossy && (
            <div className="flex items-start gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{t('Rute ini rugi {a}%, di atas batas {b}%. Kecilkan jumlahnya, atau naikkan batas di Aturan → Keluar posisi.', {
                a: num(quote.lossBps / 100, 1), b: num(quote.maxLossBps / 100, 1),
              })}</span>
            </div>
          )}

          {dry ? (
            <Button size="lg" variant="outline" className="w-full" onPress={() => { location.hash = 'settings'; }}>{t('Nyalakan LIVE dulu')}</Button>
          ) : !confirm ? (
            <Button size="lg" className="w-full" isDisabled={!quote || !!quote.error || quote.tooLossy || !!quote.insufficient} onPress={() => setConfirm(true)}>
              {quote?.insufficient && !quote.error ? t('Saldo {s} tidak cukup', { s: quote.insufficient.symbol || '' }) : t('Tukar')}
            </Button>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
              <div className="text-sm font-medium">{t('Kirim transaksi sungguhan?')}</div>
              <div className="text-sm text-muted">
                {num(quote.amountIn, 6)} {quote.symbolIn} → ±{num(quote.amountOut, 6)} {quote.symbolOut}
              </div>
              <div className="flex gap-2">
                <Button className="flex-1" onPress={swap} isPending={sendOrig}>{t('Ya, tukar sekarang')}</Button>
                <Button variant="outline" onPress={() => setConfirm(false)}>{t('Batal')}</Button>
              </div>
            </div>
          )}
        </div>

        {/* kolom kanan: saldo + riwayat */}
        <div className="flex min-w-0 flex-col gap-4">
          <Holdings tokens={tokens} dari={from} onUse={use} onRemove={remove} onImport={importKey}
            harga={price} onRetryPrice={() => loadPrice(tokens || [])} />
          <History />
        </div>
      </div>
    </>
  );
}
