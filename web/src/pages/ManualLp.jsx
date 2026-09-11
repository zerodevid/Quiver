import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Spinner, toast } from '@heroui/react';
import { Search, Check, TriangleAlert, Anchor } from 'lucide-react';
import { get, post } from '../api';
import { useStatus } from '../App';
import { PageHeader, Notice, PriceRange, Empty, KV } from '../components/ui';
import { TokenPair } from '../components/TokenIcon';
import { usd, num, ago } from '../fmt';
import { useI18n } from '../i18n';

const LEBAR = [5, 10, 25, 50, 100];

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
          <Empty title={isAlamat ? 'Tidak ada pool yang bisa dimasuki' : 'Tidak ada pool yang cocok'}
            sub={isAlamat ? 'Token ini belum punya pool dengan likuiditas yang dipasangkan USDG atau ETH.' : 'Tempel alamat token untuk mencari poolnya langsung dari chain.'} />
        ) : hasil.map((p) => (
          <button key={p.poolRef} type="button" onClick={() => onPick(p)}
            className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-start last:border-0 hover:bg-default/50">
            <span className="flex min-w-0 items-center gap-2.5">
              <TokenPair token0={p.token0} token1={p.token1} symbol0={p.symbol0} symbol1={p.symbol1} size={20} />
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
  const [lebar, setLebar] = useState(25);
  const [full, setFull] = useState(false);
  const [plan, setPlan] = useState(null);      // { preview, warnings } | { error }
  const [hitung, setHitung] = useState(false);
  const [konfirm, setKonfirm] = useState(false);
  const [kirim, setKirim] = useState(false);
  const [hasil, setHasil] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    get('/api/manual/pools?limit=200').then((d) => setPools(d.pools || []));
    get('/api/rules').then(setRules);
  }, []);

  const usdNum = Number(String(nominal).replace(',', '.'));
  const siap = !!pool && Number.isFinite(usdNum) && usdNum > 0;

  // Pratinjau dihitung ulang sendiri setiap pilihan berubah — tidak ada tombol
  // "hitung". Balasan yang datang terlambat dibuang lewat nomor urut.
  useEffect(() => {
    setKonfirm(false);
    if (!siap) { setPlan(null); return; }
    const mine = ++seq.current;
    setHitung(true);
    const id = setTimeout(async () => {
      const r = await post('/api/manual/lp/plan', { poolRef: pool.poolRef, usd: usdNum, widthPct: lebar, full });
      if (mine !== seq.current) return;
      setPlan(r); setHitung(false);
    }, 350);
    return () => { clearTimeout(id); };
  }, [pool?.poolRef, usdNum, lebar, full, siap]);

  const kas = plan?.preview?.kasUsd ?? null;
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
    const r = await post('/api/manual/lp/open', { poolRef: pool.poolRef, usd: usdNum, widthPct: lebar, full });
    setKirim(false); setKonfirm(false);
    if (r.error) return toast.danger(r.error);
    setHasil(r);
    toast.success(t('Posisi dibuka'));
    reloadStatus();
  };

  const p = plan?.preview;
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
              <Button onPress={() => { location.hash = 'posisi'; }}>{t('Lihat posisi')}</Button>
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
                  <div className="text-base font-semibold">{pool.pair}</div>
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
                {kas != null ? t('Kas tersedia {k}. Nilai posisi, bukan jumlah token — bot mengurus sendiri tukar-menukarnya.', { k: usd(kas) })
                  : t('Nilai posisi, bukan jumlah token — bot mengurus sendiri tukar-menukarnya.')}
              </p>
            </div>
          </Langkah>

          <Langkah n={3} title="Rentang harga" done={siap}>
            <div className="flex flex-col gap-3">
              <Chips value={full ? 'full' : lebar} onPick={(v) => { if (v === 'full') setFull(true); else { setFull(false); setLebar(v); } }}
                options={[...LEBAR.map((v) => [v, `±${v}%`]), ['full', t('Seluruh rentang')]]} />
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
                  <Button variant="outline" className="w-full" onPress={() => { location.hash = 'pengaturan'; }}>
                    {t('Nyalakan LIVE dulu')}
                  </Button>
                ) : !konfirm ? (
                  <Button className="w-full" onPress={() => setKonfirm(true)}>
                    {t('Buka posisi {v}', { v: usd(p.valueUsd) })}
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                    <div className="text-sm font-medium">{t('Kirim transaksi sungguhan?')}</div>
                    <div className="text-sm text-muted">{t('{v} ke {pair}, rentang {r}.', { v: usd(p.valueUsd), pair: p.pair, r: full ? t('seluruh rentang') : `±${lebar}%` })}</div>
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
