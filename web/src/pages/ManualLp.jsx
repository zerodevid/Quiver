import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, Card, Spinner, toast } from '@heroui/react';
import { Search, Check, TriangleAlert, Anchor, ArrowRight } from 'lucide-react';
import { get, post } from '../api';
import { useStatus } from '../App';
import { usePoll } from '../hooks';
import CandleChart from '../components/CandleChart';
import { PageHeader, Notice, PriceRange, Empty, KV, Segmented } from '../components/ui';
import { orientCandles, TFS, SECS, LiveBadge } from './PositionDetail';
import { useLivePrice, useLiveCandles } from '../liveCandles';
import TokenIcon, { TokenPair, TokenSym, PairName } from '../components/TokenIcon';
import { usd, num, ago, price, tickPrice, locale } from '../fmt';
import { useI18n } from '../i18n';

// Pilihan cepat rentang: [perubahan batas bawah %, perubahan batas atas %, label],
// bertanda dari harga kini. Persennya dalam harga, jadi "±50%" benar-benar setengah
// turun dan setengah naik; "½× – 2×" adalah rentang yang dulu tertulis ±100% (dalam
// tick simetris, dalam harga tidak).
const PRESET = [[-5, 5, '±5%'], [-10, 10, '±10%'], [-25, 25, '±25%'], [-50, 50, '±50%'], [-50, 100, '½× – 2×'], [-25, 0, '1 sisi · bawah −25%'], [0, 25, '1 sisi · atas +25%']];

// Teks rentang untuk ringkasan & konfirmasi. lo/up = perubahan bertanda tiap batas.
const fmtPct = (v) => num(Number(v), 2);
const bertanda = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtPct(Math.abs(v))}%`;
const rentangLabel = (lo, up, full, t) => (full ? t('seluruh rentang')
  : -lo === up ? `±${fmtPct(up)}%` : `${bertanda(lo)} / ${bertanda(up)}`);

// Satu kotak batas: tanda di depan, persen di belakang, harga hasilnya di bawah.
// Tandanya tombol: −/+ memindah batas ke sisi lain harga kini, jadi rentang satu
// sisi tidak harus menempel di harga (misal −30% … −10%). Mengetik "-" atau "+"
// di kotaknya melakukan hal yang sama.
function Batas({ label, arah, onArah, value, onChange, harga, sym, invalid, disabled, aria }) {
  const { t } = useI18n();
  // Label diikat ke input lewat id: tanpa itu tombol tanda (elemen pertama yang
  // bisa dilabeli) ikut terklik setiap kali kotaknya diklik.
  const id = useId();
  return (
    <label htmlFor={id} className={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border p-3 transition-colors
      ${invalid ? 'border-danger/60' : 'border-border focus-within:border-accent'} ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-xs text-muted">{t(label)}</span>
      <span className="flex items-baseline gap-1">
        <button type="button" disabled={disabled} onClick={() => onArah(-arah)}
          aria-label={t(arah < 0 ? 'Di bawah harga kini — klik untuk memindah ke atas' : 'Di atas harga kini — klik untuk memindah ke bawah')}
          title={t(arah < 0 ? 'Di bawah harga kini — klik untuk memindah ke atas' : 'Di atas harga kini — klik untuk memindah ke bawah')}
          className="num w-6 shrink-0 self-center rounded text-lg font-semibold text-muted hover:bg-default/60 hover:text-foreground">
          {arah < 0 ? '−' : '+'}
        </button>
        <input id={id} value={value} disabled={disabled} inputMode="decimal" aria-label={t(aria)} placeholder="0"
          onChange={(e) => {
            const v = e.target.value;
            if (/[-−–]/.test(v)) onArah(-1); else if (v.includes('+')) onArah(1);
            onChange(v.replace(/[^\d.,]/g, ''));
          }}
          className="num w-full min-w-0 bg-transparent text-lg font-semibold outline-none placeholder:text-muted/60" />
        <span className="text-lg text-muted">%</span>
      </span>
      <span className="num h-4 truncate text-xs text-muted">{harga != null ? `≈ ${price(harga)}${sym ? ' ' + sym : ''}` : ''}</span>
    </label>
  );
}

// Tombol pilihan cepat. Dipakai untuk nominal dan lebar rentang — keduanya hampir
// selalu diisi dari beberapa nilai yang itu-itu saja, jadi mengetik itu kerja sia-sia.
function Chips({ options, value, onPick }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" onClick={() => onPick(v)} aria-pressed={value === v}
          className={`num h-8 rounded-md border px-3 text-[0.8125rem] font-medium transition-colors ${value === v
            ? 'border-accent bg-accent/10 text-accent' : 'border-border text-foreground hover:bg-default/60'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Langkah({ n, title, done, children, action }) {
  const { t } = useI18n();
  return (
    <Card className="gap-0! p-0!">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold ${done ? 'bg-success text-success-foreground' : 'border border-border text-muted'}`}>
            {done ? <Check className="size-3" strokeWidth={3} /> : n}
          </span>
          <h2 className="text-sm font-semibold">{t(title)}</h2>
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

const fee = (p) => (p.dynamicFee ? 'dinamis' : `${num(p.feePct, 2)}%`);

// Jumlah token: memecoin bisa jutaan, ETH bisa 0,0000x — desimal tetap tidak cocok
// untuk keduanya, jadi di bawah 1 memakai angka penting.
const jml = (v) => (v == null ? '—' : v === 0 ? '0' : Math.abs(v) >= 1 ? num(v, Math.abs(v) >= 1000 ? 0 : 4)
  : Number(v).toLocaleString(locale(), { maximumSignificantDigits: 4 }));

// Saldo wallet yang relevan: kas (ETH/USDG/WETH) dan token pasangan pool. Kolom
// "Setelah dibuka" muncul begitu pratinjau untuk pool ini selesai dihitung.
function Saldo({ saldo, pool }) {
  const { t } = useI18n();
  if (!saldo) return null;
  if (saldo.wallet === false) return <p className="text-xs text-muted">{t('Belum ada wallet — saldo tidak bisa dibaca.')}</p>;
  const milikPool = (a) => pool && (a === pool.token0?.toLowerCase() || a === pool.token1?.toLowerCase());
  const rows = saldo.tokens.filter((x) => x.amount > 0 || x.native || milikPool(x.token) || x.sesudah > 0);
  const setelah = rows.some((x) => x.sesudah != null);
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted">
        <span>{t('Saldo wallet')}</span>
        <span>{t('Kas')} <span className="num font-semibold text-foreground">{usd(saldo.kasUsd)}</span></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {setelah && (
            <thead>
              <tr className="text-[0.6875rem] text-muted">
                <th className="px-3 pt-2 text-start font-normal">{t('Token')}</th>
                <th className="px-3 pt-2 text-end font-normal">{t('Sekarang')}</th>
                <th className="px-3 pt-2 text-end font-normal">{t('Setelah dibuka')}</th>
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((x) => (
              <tr key={x.token}>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-2">
                    <TokenIcon link address={x.token} symbol={x.symbol} size={18} />
                    <TokenSym address={x.token} symbol={x.symbol} className="font-medium" />
                  </span>
                </td>
                <td className="num px-3 py-1.5 text-end">
                  {jml(x.amount)}
                  <span className="ms-1.5 text-xs text-muted">{x.usd != null ? usd(x.usd) : ''}</span>
                </td>
                {setelah && (
                  <td className="num px-3 py-1.5 text-end text-muted">
                    ≈ {jml(x.sesudah)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-3 py-2 text-xs text-muted">
        {t('{e} ETH ditahan untuk gas dan tidak ikut dipakai.', { e: num(saldo.gasReserveEth, 4) })}
      </p>
    </div>
  );
}

const jmlSwap = (n, t) => (!n ? t('tidak perlu') : n === 1 ? t('1 transaksi') : t('{n} transaksi', { n }));

const JENIS = {
  zap: 'Beli {s}',
  jembatan: 'Jembatan kas',
  bungkus: 'Bungkus ETH',
  buka_bungkus: 'Buka bungkus WETH',
};

// Rincian tukar yang akan dijalankan bot sebelum mint, dari simulasi di server
// (manual.simulasiSwap) — urutan dan jumlahnya sama dengan executeEntry.
function AutoSwap({ p }) {
  const { t } = useI18n();
  const sw = p.swaps || [];
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-muted">
        <span>{t('Auto-swap sebelum mint')}</span>
        <span>{jmlSwap(sw.length, t)}</span>
      </div>
      {!sw.length ? (
        <p className="px-3 py-2.5 text-sm text-muted">
          {t('Tidak ada yang ditukar — saldo {a} dan {b} sudah cukup untuk posisi ini.', { a: p.symbol0, b: p.symbol1 })}
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {sw.map((s, i) => (
            <li key={i} className="flex flex-col gap-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs text-muted">
                <span className="flex size-4 items-center justify-center rounded-full border border-border text-[0.625rem]">{i + 1}</span>
                <span className="font-medium text-foreground">{t(JENIS[s.jenis] || s.jenis, { s: s.ke.symbol })}</span>
                {s.jenis === 'zap' || s.jenis === 'jembatan' ? <span>· Kyber</span> : <span>· {t('1:1, tanpa slippage')}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="flex items-center gap-1.5">
                  <TokenIcon link address={s.dari.token} symbol={s.dari.symbol} size={16} />
                  <span className="num font-medium">{s.taksiran ? '≈ ' : ''}{jml(s.dari.amount)} <TokenSym address={s.dari.token} symbol={s.dari.symbol} /></span>
                </span>
                <ArrowRight className="size-3.5 text-muted" />
                <span className="flex items-center gap-1.5">
                  <TokenIcon link address={s.ke.token} symbol={s.ke.symbol} size={16} />
                  <span className="num font-medium">{jml(s.ke.amount)} <TokenSym address={s.ke.token} symbol={s.ke.symbol} /></span>
                </span>
                {s.dari.usd != null && <span className="num text-xs text-muted">{usd(s.dari.usd)}</span>}
              </div>
              {s.maxLossBps != null && (
                <div className="text-xs text-muted">
                  {t('dibatalkan kalau rugi rute lebih dari {r}%', { r: num(s.maxLossBps / 100, 2) })}
                  {s.taksiran ? ' · ' + t('jumlah pasti dari kutipan Kyber saat eksekusi') : ''}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {!!sw.length && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted">
          {p.swapOn
            ? t('Jumlah yang dijual sudah termasuk ruang slippage {s}%; kelebihannya tetap di wallet.', { s: num(p.slippageBps / 100, 2) })
            : <span className="text-danger">{t('Auto-swap dimatikan di Aturan — pembukaan akan berhenti di langkah pertama.')}</span>}
        </p>
      )}
    </div>
  );
}

// Grafik harga pool dengan pita rentang yang sedang dipilih, supaya terlihat
// sebelum membuka posisi di mana rentangnya jatuh terhadap pergerakan harga.
// Pitanya mengikuti ketikan (dari persen × harga kini); begitu pratinjau untuk
// masukan yang sama datang, batasnya diganti harga tick yang sudah dibulatkan.
// Tanpa pratinjau (nominal belum diisi), harga kini diambil dari lilin terakhir.
function GrafikRentang({ pool, lo, up, full, rentangOk, pratinjau, hargaKini }) {
  const { t } = useI18n();
  const [tf, setTf] = useState('1h');
  const baseToken = pool.quoteSide === 0 ? pool.token1 : pool.token0;
  const { data: m } = usePoll(`/api/market?pool=${pool.poolRef}&tf=${tf}&limit=240&pair=0&token=${baseToken || ''}`, 30000);
  const live = useLivePrice(pool.poolRef, pool);
  const acuan = live?.price ?? hargaKini;
  const oriented = useMemo(() => orientCandles(m?.ohlcv, baseToken, acuan), [m, baseToken, acuan]);
  const candles = useLiveCandles(oriented, SECS[tf], live, `${pool.poolRef}:${tf}`);
  const kini = acuan ?? candles[candles.length - 1]?.c ?? null;
  const quote = pool.quoteSide === 0 ? pool.symbol0 : pool.quoteSide === 1 ? pool.symbol1 : null;

  const range = useMemo(() => {
    if (full || !rentangOk) return null;
    if (pratinjau) {
      const a = tickPrice(pratinjau.tickLower, pratinjau.dec0, pratinjau.dec1, pratinjau.quoteSide);
      const b = tickPrice(pratinjau.tickUpper, pratinjau.dec0, pratinjau.dec1, pratinjau.quoteSide);
      if (a > 0 && b > 0) return { lo: Math.min(a, b), hi: Math.max(a, b) };
    }
    return kini > 0 ? { lo: kini * (1 + lo / 100), hi: kini * (1 + up / 100) } : null;
  }, [full, rentangOk, pratinjau, kini, lo, up]);

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {range ? <>{t('Rentang')} <span className="num text-foreground">{price(range.lo)} – {price(range.hi)}</span>{quote ? ` ${quote}` : ''}</>
            : full ? t('Seluruh rentang') : t('Harga pool')}
        </span>
        <Segmented size="sm" aria="Rentang lilin" value={tf} onChange={setTf} options={TFS} />
      </div>
      {!m ? (
        <div className="flex h-[300px] items-center justify-center"><Spinner /></div>
      ) : m.ohlcv?.error ? (
        <Empty title="Grafik harga tidak tersedia" sub={m.ohlcv.error} />
      ) : !candles.length ? (
        <Empty title="Belum ada lilin harga" sub="GeckoTerminal belum punya riwayat harga untuk pool ini." />
      ) : (
        <>
          <CandleChart key={pool.poolRef} candles={candles} tf={tf} quote={quote} range={range} now={kini} pickRange height={300} />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            {range && <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-accent/50 bg-accent/15" />{t('rentang yang akan di-LP')}</span>}
            {full && <span>{t('Seluruh rentang — tidak ada batas untuk digambar.')}</span>}
            <span className="ml-auto inline-flex items-center gap-3">
              {live && <LiveBadge />}
              {t('lilin {tf} · GeckoTerminal', { tf })}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function PilihPool({ pools, onPick }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [scan, setScan] = useState(null);     // hasil pindai dari alamat token
  const [semua, setSemua] = useState(false);
  const timer = useRef(null);
  const token = q.trim().toLowerCase();
  const isAlamat = /^0x[0-9a-f]{40}$/.test(token);
  useEffect(() => () => clearInterval(timer.current), []);

  const ambil = async (tok, all) => {
    const d = await get(`/api/manual/pools/scan?token=${tok}${all ? '&all=1' : ''}`);
    setScan({ token: tok, ...d });
    return d;
  };
  const pindai = async () => {
    setScan({ token, status: 'jalan', progress: 0 });
    const r = await post('/api/manual/pools/scan', { token });
    if (r.error) return setScan({ token, status: 'gagal', error: r.error });
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const d = await ambil(token, semua);
      if (d.status !== 'jalan') clearInterval(timer.current);
    }, 1500);
  };
  const gantiSemua = (v) => { setSemua(v); if (scan?.token) ambil(scan.token, v); };

  // Hasil pindai menggantikan daftar hanya selagi kotak cari masih berisi alamat itu.
  const pakaiScan = isAlamat && scan?.token === token && scan.status === 'selesai';
  const hasil = useMemo(() => {
    if (pakaiScan) return scan.pools || [];
    const n = q.trim().toLowerCase();
    return n ? pools.filter((p) => p.pair.toLowerCase().includes(n)) : pools;
  }, [pools, q, pakaiScan, scan]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cari pasangan, atau tempel alamat token')}
          className="h-9 w-full rounded-md border border-field-border bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent" />
      </div>

      {/* Alamat token: pool-nya dicari langsung dari chain, bukan dari yang sudah dikenal. */}
      {isAlamat && (!scan || scan.token !== token) && (
        <Button size="sm" onPress={pindai}>{t('Cari pool untuk token ini')}</Button>
      )}
      {scan?.token === token && scan.status === 'jalan' && (
        <div className="flex items-center gap-2 text-sm text-muted"><Spinner size="sm" />{t('Mencari pool di chain… {p}%', { p: scan.progress || 0 })}</div>
      )}
      {scan?.token === token && scan.status === 'gagal' && (
        <Notice status="danger" title={t('Pemindaian gagal')}>{scan.error}</Notice>
      )}
      {pakaiScan && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
          <span>{t('{n} pool bisa dimasuki dari {total} yang ada', { n: (scan.pools || []).length, total: scan.total })}</span>
          {!!scan.hidden && (
            <button type="button" className="underline underline-offset-2" onClick={() => gantiSemua(!semua)}>
              {semua ? t('Sembunyikan yang kosong') : t('Tampilkan semua')}
            </button>
          )}
        </div>
      )}
      {pakaiScan && !!scan.hidden && !semua && (
        <p className="text-xs text-muted">
          {t('Yang disembunyikan: pool tanpa likuiditas, berfee dinamis, atau tidak dipasangkan USDG/ETH — masuk ke sana sama saja membuang gas.')}
        </p>
      )}

      <div className="max-h-80 overflow-y-auto rounded-md border border-border">
        {!hasil.length ? (
          <div>
            <Empty title={isAlamat ? 'Tidak ada pool Uniswap v3/v4 yang bisa dimasuki' : 'Tidak ada pool yang cocok'}
              sub={isAlamat ? 'Token ini belum punya pool dengan likuiditas yang dipasangkan USDG atau ETH.' : 'Tempel alamat token untuk mencari poolnya langsung dari chain.'} />
            {pakaiScan && scan.lainnya?.length > 0 && (
              <div className="border-t border-border px-3 py-3 text-sm">
                <div className="mb-1.5 font-medium">{t('Diperdagangkan di tempat lain')}</div>
                {scan.lainnya.map((x) => (
                  <div key={x.address || x.name} className="flex justify-between gap-3 py-0.5 text-muted">
                    <span className="truncate"><span className="text-foreground">{x.dex}</span> · {x.name}</span>
                    <span className="num shrink-0">{usd(x.reserveUsd, 0)}</span>
                  </div>
                ))}
                <p className="mt-2 text-xs text-muted">{t('Bot hanya bisa membuka LP di Uniswap v3/v4 (likuiditas terkonsentrasi dengan rentang harga). Pool gaya v2 tidak punya rentang maupun NFT posisi.')}</p>
              </div>
            )}
          </div>
        ) : hasil.map((p) => (
          <button key={p.poolRef} type="button" onClick={() => onPick(p)}
            className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-start last:border-0 hover:bg-default/50">
            <span className="flex min-w-0 items-center gap-2.5">
              <TokenPair link={false} token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={20} />
              <span className="truncate font-medium">{p.pair}</span>
              <span className="text-[0.6875rem] text-muted uppercase">{p.venue}</span>
              {p.hasHooks && <Anchor className="size-3.5 shrink-0 text-warning" aria-label={t('pool memakai hook')} />}
            </span>
            <span className="flex shrink-0 items-center gap-4 text-xs text-muted">
              <span className="num w-12 text-end">{fee(p)}</span>
              <span className="hidden w-20 text-end sm:inline">{p.kosong === true ? t('kosong') : p.lastTs ? ago(p.lastTs) : '—'}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ManualLp() {
  const { t } = useI18n();
  const { status, reload: reloadStatus } = useStatus();
  const [pools, setPools] = useState(null);
  const [rules, setRules] = useState(null);
  const [pool, setPool] = useState(null);
  const [gantiPool, setGantiPool] = useState(false);
  const [nominal, setNominal] = useState('');
  // Tiap batas = besar persen + arah dari harga kini (−1 di bawah, +1 di atas).
  const [bawah, setBawah] = useState('25');
  const [atas, setAtas] = useState('25');
  const [arahBawah, setArahBawah] = useState(-1);
  const [arahAtas, setArahAtas] = useState(1);
  const [full, setFull] = useState(false);
  const [plan, setPlan] = useState(null);      // { preview, warnings } | { error }
  const [hitung, setHitung] = useState(false);
  const [konfirm, setKonfirm] = useState(false);
  const [kirim, setKirim] = useState(false);
  const [hasil, setHasil] = useState(null);
  const [saldo, setSaldo] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    get('/api/manual/pools?limit=200').then((d) => setPools(d.pools || []));
    get('/api/rules').then(setRules);
  }, []);

  // Saldo dibaca sendiri, tidak menunggu pratinjau: pengguna perlu tahu kasnya
  // SEBELUM memilih nominal. Dibaca ulang saat pool berganti (token pasangannya
  // ikut ditampilkan) dan setelah posisi dibuka.
  const muatSaldo = useCallback(async (ref) => {
    const d = await get(`/api/manual/saldo${ref ? `?poolRef=${ref}` : ''}`);
    if (!d.error) setSaldo({ ...d, _ref: ref || null });
  }, []);
  useEffect(() => { muatSaldo(pool?.poolRef); }, [pool?.poolRef, muatSaldo]);

  const usdNum = Number(String(nominal).replace(',', '.'));
  // lo/up = perubahan bertanda tiap batas dari harga kini. API memakai lowerPct =
  // seberapa jauh batas bawah DI BAWAH harga, jadi tandanya dibalik saat dikirim.
  const pctDari = (s) => Number(String(s).replace(',', '.') || 0);
  const lo = arahBawah * pctDari(bawah), up = arahAtas * pctDari(atas);
  const loBad = !full && !(lo > -100);
  const upBad = !full && !(up > -100 && up <= 100000);
  const kosong = !full && lo === 0 && up === 0;
  const terbalik = !full && !loBad && !upBad && !kosong && up <= lo;
  const rentangOk = full || (!loBad && !upBad && !kosong && !terbalik);
  const siap = !!pool && Number.isFinite(usdNum) && usdNum > 0 && rentangOk;
  const body = { poolRef: pool?.poolRef, usd: usdNum, ...(full ? { full: true } : { lowerPct: -lo, upperPct: up }) };

  // Pratinjau dihitung ulang sendiri setiap pilihan berubah — tidak ada tombol
  // "hitung". Balasan yang datang terlambat dibuang lewat nomor urut.
  useEffect(() => {
    setKonfirm(false);
    if (!siap) { setPlan(null); return; }
    const mine = ++seq.current;
    setHitung(true);
    const id = setTimeout(async () => {
      const r = await post('/api/manual/lp/plan', body);
      if (mine !== seq.current) return;
      setPlan({ ...r, _ref: body.poolRef }); setHitung(false);
    }, 350);
    return () => { clearTimeout(id); };
  }, [pool?.poolRef, usdNum, lo, up, full, siap]);

  const kas = plan?.preview?.kasUsd ?? saldo?.kasUsd ?? null;
  // Nominal terbesar yang masih lolos semua batas — supaya tombol "Maks" tidak
  // mengantar ke penolakan.
  const maks = useMemo(() => {
    const s = rules?.rules?.sizing;
    if (!s) return null;
    const sisaTotal = s.max_total_exposure_usd - (status?.summary?.exposureUsd || 0);
    const batas = [s.max_quote_per_position_usd, sisaTotal, kas ?? Infinity].filter((x) => Number.isFinite(x));
    const v = Math.floor(Math.min(...batas) * 100) / 100;
    return v > 0 ? v : 0;
  }, [rules, status, kas]);

  const buka = async () => {
    setKirim(true);
    const r = await post('/api/manual/lp/open', body);
    setKirim(false); setKonfirm(false);
    if (r.error) return toast.danger(r.error);
    setHasil(r);
    toast.success(t('Posisi dibuka'));
    reloadStatus();
    muatSaldo(pool?.poolRef);
  };

  const p = plan?.preview;
  // Harga kini (dalam aset kuotasi) dari pratinjau terakhir UNTUK POOL INI — dipakai
  // menampilkan harga tiap batas selagi pengguna mengetik, sebelum pratinjau baru datang.
  const pKini = p && plan._ref === pool?.poolRef ? p : null;
  const hargaKini = pKini ? tickPrice(pKini.curTick, pKini.dec0, pKini.dec1, pKini.quoteSide) : null;
  const symQ = pKini ? (pKini.quoteSide === 0 ? pKini.symbol0 : pKini.symbol1) : null;
  // Rentang yang seluruhnya di satu sisi harga hanya diisi satu token: di bawah =
  // aset kuotasi, di atas = token pasangannya.
  const satuSisi = !full && rentangOk ? (up <= 0 ? 'bawah' : lo >= 0 ? 'atas' : null) : null;
  const symSetor = satuSisi && pool?.quoteSide != null
    ? ((pool.quoteSide === 0) === (satuSisi === 'bawah') ? pool.symbol0 : pool.symbol1) : null;
  // Pratinjau membawa saldo "setelah dibuka"; selama belum ada, pakai bacaan
  // sendiri — asal untuk pool yang sama, supaya token pasangannya tidak salah.
  const pSiap = pKini && siap && !plan?.error ? pKini : null;
  const saldoTampil = pSiap?.saldo || (saldo && saldo._ref === (pool?.poolRef || null) ? saldo : null);
  const dry = status?.mode?.dry_run !== false;

  if (hasil) {
    return (
      <>
        <PageHeader group="Aksi" title="LP manual" />
        <Card>
          <Card.Content className="items-center gap-4 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-6" /></span>
            <div>
              <div className="text-lg font-semibold">{t('Posisi dibuka')}</div>
              <div className="mt-1 text-muted">{hasil.note}</div>
              <div className="mono mt-2 text-sm text-muted">{hasil.tx}</div>
            </div>
            <div className="flex gap-2">
              <Button onPress={() => { location.hash = 'positions'; }}>{t('Lihat posisi')}</Button>
              <Button variant="outline" onPress={() => { setHasil(null); setNominal(''); }}>{t('Buka satu lagi')}</Button>
            </div>
          </Card.Content>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader group="Aksi" title="LP manual"
        desc="Membuka posisi sendiri, di luar penyalinan target. Jalur eksekusinya sama: kas dijembatani, token ditukar seperlunya, lalu mint." />

      {dry && (
        <Notice status="warning" title={t('Mode simulasi')}>
          {t('Pratinjau tetap dihitung, tapi transaksi tidak akan dikirim. Nyalakan LIVE di Pengaturan kalau memang mau membuka posisi.')}
        </Notice>
      )}

      <div className="mt-4 grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-3">
          <Langkah n={1} title="Pilih pool" done={!!pool}
            action={pool && !gantiPool ? <Button size="sm" variant="outline" onPress={() => setGantiPool(true)}>{t('Ganti')}</Button> : null}>
            {pools === null ? <Spinner /> : pool && !gantiPool ? (
              <div className="flex items-center gap-3">
                <TokenPair token0={pool.token0} token1={pool.token1} symbol0={pool.symbol0} symbol1={pool.symbol1} size={30} />
                <div className="min-w-0">
                  <div className="text-base font-semibold"><PairName token0={pool.token0} token1={pool.token1} symbol0={pool.symbol0} symbol1={pool.symbol1} pool={pool.poolRef} sep="/" /></div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                    <span className="uppercase">{pool.venue}</span><span>·</span>
                    <span>{pool.dynamicFee ? t('fee dinamis') : t('fee {p}%', { p: num(pool.feePct, 2) })}</span><span>·</span>
                    {pool.hasHooks && <><span className="text-warning">{t('pakai hook')}</span><span>·</span></>}
                    <span>{pool.lastTs ? t('aksi terakhir {a}', { a: ago(pool.lastTs) }) : t('belum ada aksi terpantau')}</span>
                  </div>
                </div>
              </div>
            ) : (
              <PilihPool pools={pools} onPick={(x) => { setPool(x); setGantiPool(false); }} />
            )}
          </Langkah>

          <Langkah n={2} title="Nominal" done={siap}>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xl text-muted">$</span>
                <input value={nominal} onChange={(e) => setNominal(e.target.value.replace(/[^\d.,]/g, ''))}
                  inputMode="decimal" placeholder="0" aria-label={t('Nominal posisi')}
                  className="num h-11 w-44 rounded-md border border-field-border bg-surface px-3 text-xl font-semibold outline-none focus:border-accent" />
              </div>
              {/* "Maks" dihitung dari batas yang benar-benar berlaku, jadi menekannya
                  tidak pernah mengantar ke penolakan. Nilai yang kebetulan sama
                  dengan salah satu pilihan cepat dibuang supaya tidak dobel. */}
              <Chips value={usdNum} onPick={(v) => setNominal(String(v))}
                options={[25, 50, 100, 200].filter((v) => !maks || v < maks).map((v) => [v, `$${v}`])
                  .concat(maks > 0 ? [[maks, t('Maks {v}', { v: usd(maks, 0) })]] : [])} />
              <p className="text-xs text-muted">
                {t('Nilai posisi, bukan jumlah token — bot mengurus sendiri tukar-menukarnya.')}
              </p>
              <Saldo saldo={saldoTampil} pool={pool} />
              {pSiap?.swaps && <AutoSwap p={pSiap} />}
            </div>
          </Langkah>

          <Langkah n={3} title="Rentang harga" done={siap}>
            <div className="flex flex-col gap-3">
              {pool && (
                <GrafikRentang pool={pool} lo={lo} up={up} full={full} rentangOk={rentangOk} hargaKini={hargaKini}
                  pratinjau={pSiap && !hitung ? pSiap : null} />
              )}
              <Chips value={full ? 'full' : PRESET.find(([a, b]) => a === lo && b === up)?.[2]}
                onPick={(v) => {
                  if (v === 'full') return setFull(true);
                  const [a, b] = PRESET.find((x) => x[2] === v);
                  setFull(false);
                  setBawah(String(Math.abs(a))); setArahBawah(a > 0 ? 1 : -1);
                  setAtas(String(Math.abs(b))); setArahAtas(b < 0 ? -1 : 1);
                }}
                options={[...PRESET.map(([, , l]) => [l, t(l)]), ['full', t('Seluruh rentang')]]} />
              <p className="text-xs text-muted">{t('Klik tanda −/+ untuk memindah batas ke sisi lain harga kini. Rentang yang seluruhnya di bawah harga (misal −30% sampai −10%) hanya diisi aset kuotasi seperti USDG; yang seluruhnya di atas hanya diisi tokennya.')}</p>
              {/* Batas bebas: mengetik di salah satu kotak otomatis keluar dari "seluruh rentang". */}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Batas label="Batas bawah" aria="Batas bawah dari harga kini (persen)" arah={arahBawah} value={full ? '' : bawah} disabled={false}
                  onArah={(a) => { setFull(false); setArahBawah(a); }}
                  onChange={(v) => { setFull(false); setBawah(v); }} invalid={loBad || terbalik}
                  harga={hargaKini != null && !full && !loBad ? hargaKini * (1 + lo / 100) : null} sym={symQ} />
                <Batas label="Batas atas" aria="Batas atas dari harga kini (persen)" arah={arahAtas} value={full ? '' : atas} disabled={false}
                  onArah={(a) => { setFull(false); setArahAtas(a); }}
                  onChange={(v) => { setFull(false); setAtas(v); }} invalid={upBad || terbalik}
                  harga={hargaKini != null && !full && !upBad ? hargaKini * (1 + up / 100) : null} sym={symQ} />
              </div>
              {(loBad || upBad || kosong || terbalik) && (
                <p className="text-xs text-danger">{t(loBad ? 'Batas bawah harus di atas −100% — turun 100% berarti harga nol.'
                  : upBad ? 'Batas atas harus di atas −100% dan maksimal +100.000%.'
                    : terbalik ? 'Batas atas harus lebih tinggi dari batas bawah.' : 'Isi batas bawah atau batas atas.')}</p>
              )}
              {satuSisi && (
                <p className="text-xs text-muted">
                  {t(satuSisi === 'bawah'
                    ? 'Satu sisi di bawah harga kini: hanya {s} yang disetor. Fee mulai saat harga turun masuk rentang.'
                    : 'Satu sisi di atas harga kini: hanya {s} yang disetor. Fee mulai saat harga naik masuk rentang.',
                  { s: symSetor || t('satu token') })}
                </p>
              )}
              {!full && p && !plan?.error && (Math.abs(-p.lowerPct - lo) >= 0.05 || Math.abs(p.upperPct - up) >= 0.05) && (
                <p className="text-xs text-muted">{t('Dibulatkan ke tick pool: {a} / {b}.', { a: bertanda(-p.lowerPct), b: bertanda(p.upperPct) })}</p>
              )}
              <p className="text-xs text-muted">
                {t('Fee hanya mengalir selama harga ada di dalam rentang. Sempit = fee lebih besar tapi lebih cepat keluar; lebar = lebih aman tapi encer.')}
              </p>
              {p && (
                <div className="rounded-md border border-border p-3">
                  <PriceRange lo={p.tickLower} hi={p.tickUpper} cur={p.curTick} dec0={p.dec0} dec1={p.dec1}
                    quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1} />
                </div>
              )}
            </div>
          </Langkah>
        </div>

        {/* pratinjau */}
        <Card className="gap-0! p-0! lg:sticky lg:top-4">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{t('Pratinjau')}</h2>
            {hitung && <Spinner size="sm" />}
          </div>
          <div className="flex flex-col gap-4 p-4">
            {!siap ? (
              <p className="text-sm text-muted">{t('Pilih pool dan isi nominalnya — pratinjau muncul sendiri.')}</p>
            ) : plan?.error ? (
              <Notice status="danger" title={t('Belum bisa dibuka')}>{plan.error}</Notice>
            ) : !p ? <Spinner /> : (
              <>
                <div>
                  <div className="text-xs text-muted">{t('Nilai posisi')}</div>
                  <div className="num text-[1.5rem] leading-tight font-semibold tracking-tight">{usd(p.valueUsd)}</div>
                </div>
                <div className="divide-y divide-border border-y border-border">
                  <KV label={p.symbol0}>{num(Number(p.amount0) / 10 ** p.dec0, 6)}</KV>
                  <KV label={p.symbol1}>{num(Number(p.amount1) / 10 ** p.dec1, 6)}</KV>
                  {p.swaps && <KV label="Auto-swap">{jmlSwap(p.swaps.length, t)}</KV>}
                  <KV label="Kas setelah dibuka">{usd(Math.max(0, p.kasUsd - p.valueUsd))}</KV>
                </div>

                {(plan.warnings || []).map((w) => (
                  <div key={w} className="flex items-start gap-2 rounded-md bg-warning/10 p-2.5 text-sm text-warning">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" /><span>{w}</span>
                  </div>
                ))}

                <p className="text-xs text-muted">
                  {t('Posisi ini tidak mencermin siapa pun — ia tidak akan ikut ditutup saat target keluar.')}
                </p>

                {/* Di mode simulasi tombolnya TIDAK dimatikan begitu saja: tombol mati
                    tanpa jalan keluar cuma bikin user menebak. Ia berubah jadi jalan
                    pintas ke tempat yang bisa mengubah keadaannya. */}
                {dry ? (
                  <Button variant="outline" className="w-full" onPress={() => { location.hash = 'settings'; }}>
                    {t('Nyalakan LIVE dulu')}
                  </Button>
                ) : !konfirm ? (
                  <Button className="w-full" onPress={() => setKonfirm(true)}>
                    {t('Buka posisi {v}', { v: usd(p.valueUsd) })}
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                    <div className="text-sm font-medium">{t('Kirim transaksi sungguhan?')}</div>
                    <div className="text-sm text-muted">{t('{v} ke {pair}, rentang {r}.', { v: usd(p.valueUsd), pair: p.pair, r: rentangLabel(lo, up, full, t) })}</div>
                    <div className="flex gap-2">
                      <Button className="flex-1" onPress={buka} isPending={kirim}>{t('Ya, buka sekarang')}</Button>
                      <Button variant="outline" onPress={() => setKonfirm(false)}>{t('Batal')}</Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
