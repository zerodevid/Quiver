import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Separator, Spinner, toast } from '@heroui/react';
import { ArrowDownUp, Check, TriangleAlert } from 'lucide-react';
import { get, post } from '../api';
import { useStatus } from '../App';
import { PageHeader, Notice, Pick, Loading } from '../components/ui';
import { usd, num } from '../fmt';
import { useI18n } from '../i18n';

const PORSI = [['25%', '25%'], ['50%', '50%'], ['75%', '75%'], ['semua', 'Maks']];

export default function Swap() {
  const { t } = useI18n();
  const { status, reload: reloadStatus } = useStatus();
  const [tokens, setTokens] = useState(null);
  const [dari, setDari] = useState('');
  const [ke, setKe] = useState('');
  const [jumlah, setJumlah] = useState('');
  const [kutip, setKutip] = useState(null);
  const [ambil, setAmbil] = useState(false);
  const [konfirm, setKonfirm] = useState(false);
  const [kirim, setKirim] = useState(false);
  const [hasil, setHasil] = useState(null);
  const seq = useRef(0);

  const muat = () => get('/api/manual/tokens').then((d) => {
    const list = d.tokens || [];
    setTokens(list);
    // Pilihan awal: aset dengan saldo terbesar, ditukar ke aset kuotasi yang BERBEDA.
    // Kalau sisi "ke" dipilih tanpa melihat sisi "dari", keduanya bisa jatuh ke token
    // yang sama (USDG punya saldo terbesar dan juga kuotasi bawaan) — halaman lalu
    // diam tanpa kutipan dan tanpa penjelasan.
    const d0 = list.find((x) => x.amount > 0)?.address || '';
    const k0 = list.find((x) => x.isQuote && x.address !== d0)?.address
      || list.find((x) => x.address !== d0)?.address || '';
    setDari((v) => v || d0);
    setKe((v) => v || k0);
  });
  useEffect(() => { muat(); }, []);

  const byAddr = useMemo(() => new Map((tokens || []).map((x) => [x.address, x])), [tokens]);
  const tDari = byAddr.get(dari);
  const tKe = byAddr.get(ke);
  const punya = useMemo(() => (tokens || []).filter((x) => x.amount > 0), [tokens]);
  const siap = dari && ke && dari !== ke && String(jumlah).trim() !== '';

  // Kutipan diambil sendiri setiap pilihan berubah; balasan basi dibuang.
  useEffect(() => {
    setKonfirm(false);
    if (!siap) { setKutip(null); return; }
    const mine = ++seq.current;
    setAmbil(true);
    const id = setTimeout(async () => {
      const r = await post('/api/manual/swap/quote', { tokenIn: dari, tokenOut: ke, amount: jumlah });
      if (mine !== seq.current) return;
      setKutip(r); setAmbil(false);
    }, 450);
    return () => clearTimeout(id);
  }, [dari, ke, jumlah, siap]);

  const balik = () => { setDari(ke); setKe(dari); setJumlah(''); };

  const tukar = async () => {
    setKirim(true);
    const r = await post('/api/manual/swap', { tokenIn: dari, tokenOut: ke, amount: jumlah });
    setKirim(false); setKonfirm(false);
    if (r.error) return toast.danger(r.error);
    setHasil(r);
    toast.success(t('Swap selesai'));
    muat(); reloadStatus();
  };

  const dry = status?.mode?.dry_run !== false;
  const opsi = (list) => list.map((x) => [x.address, `${x.symbol} · ${num(x.amount, 6)}`]);

  if (tokens === null) return (<><PageHeader group="Aksi" title="Swap" /><Loading /></>);

  if (hasil) {
    return (
      <>
        <PageHeader group="Aksi" title="Swap" />
        <Card className="mx-auto max-w-lg">
          <Card.Content className="items-center gap-4 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success"><Check className="size-6" /></span>
            <div>
              <div className="text-lg font-semibold">{t('Swap selesai')}</div>
              <div className="mt-1 text-muted">{hasil.note}</div>
              {hasil.dex && <div className="text-sm text-muted">{t('lewat {d}', { d: hasil.dex })}</div>}
              <div className="mono mt-2 text-sm text-muted">{hasil.tx}</div>
            </div>
            <Button variant="outline" onPress={() => { setHasil(null); setJumlah(''); }}>{t('Tukar lagi')}</Button>
          </Card.Content>
        </Card>
      </>
    );
  }

  // Tidak ada satu pun aset bersaldo: kartu swap-nya tidak bisa dipakai sama sekali,
  // jadi lebih jujur menjelaskan kenapa daripada memajang field kosong.
  if (!punya.length) {
    return (
      <>
        <PageHeader group="Aksi" title="Swap"
          desc="Menukar aset lewat agregator Kyber — rute yang sama dipakai bot untuk zap dan menjual memecoin sisa." />
        <Card className="mx-auto max-w-lg">
          <Card.Content className="items-center gap-4 py-10 text-center">
            <div>
              <div className="font-medium">{t('Belum ada aset yang bisa ditukar')}</div>
              <p className="mt-1 text-sm text-muted">
                {t('Wallet bot kosong. Isi dengan ETH atau USDG dulu — alamatnya ada di Pengaturan.')}
              </p>
            </div>
            <Button variant="outline" onPress={() => { location.hash = 'pengaturan'; }}>{t('Buka Pengaturan')}</Button>
          </Card.Content>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader group="Aksi" title="Swap"
        desc="Menukar aset lewat agregator Kyber — rute yang sama dipakai bot untuk zap dan menjual memecoin sisa." />

      {dry && (
        <Notice status="warning" title={t('Mode simulasi')}>
          {t('Kutipan tetap diambil, tapi transaksi tidak akan dikirim. Nyalakan LIVE di Pengaturan kalau memang mau menukar.')}
        </Notice>
      )}

      <div className="mx-auto mt-4 flex max-w-lg flex-col gap-4">
        <Card>
          <Card.Content className="gap-0">
            {/* dari */}
            <div className="flex flex-col gap-3 rounded-md bg-surface-secondary p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted">{t('Dari')}</span>
                {tDari && <span className="text-sm text-muted">{t('Saldo')} <span className="num">{num(tDari.amount, 6)}</span></span>}
              </div>
              <div className="flex items-center gap-3">
                <input value={jumlah} onChange={(e) => setJumlah(e.target.value)} placeholder="0"
                  aria-label={t('Jumlah yang ditukar')}
                  className="num h-12 min-w-0 flex-1 rounded-md border border-field-border bg-surface px-3 text-2xl font-semibold outline-none focus:border-accent" />
                <Pick label={null} aria="Token yang ditukar" value={dari} onChange={setDari} options={opsi(punya.filter((x) => x.address !== ke))} className="w-40 shrink-0" />
              </div>
              <div className="flex flex-wrap gap-2">
                {PORSI.map(([v, label]) => (
                  <Button key={v} size="sm" variant={jumlah === v ? 'primary' : 'outline'} onPress={() => setJumlah(v)}>{t(label)}</Button>
                ))}
              </div>
            </div>

            {/* pembalik */}
            <div className="relative h-2">
              <Button size="sm" variant="outline" aria-label={t('Balik arah')} onPress={balik}
                className="absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 rounded-full p-0">
                <ArrowDownUp className="size-4" />
              </Button>
            </div>

            {/* ke */}
            <div className="flex flex-col gap-3 rounded-md bg-surface-secondary p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted">{t('Ke')}</span>
                {tKe && <span className="text-sm text-muted">{t('Saldo')} <span className="num">{num(tKe.amount, 6)}</span></span>}
              </div>
              <div className="flex items-center gap-3">
                <div className="num flex h-12 min-w-0 flex-1 items-center px-3 text-2xl font-semibold text-muted">
                  {ambil ? <Spinner size="sm" /> : kutip?.amountOut != null ? num(kutip.amountOut, 6) : '0'}
                </div>
                <Pick label={null} aria="Token yang diterima" value={ke} onChange={setKe} options={opsi(tokens.filter((x) => x.address !== dari))} className="w-40 shrink-0" />
              </div>
            </div>
          </Card.Content>
        </Card>

        {siap && kutip?.error && <Notice status="danger" title={t('Tidak bisa dikutip')}>{kutip.error}</Notice>}

        {kutip && !kutip.error && (
          <Card>
            <Card.Content className="gap-2.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">{t('Dikirim')}</span>
                <span className="num">{num(kutip.amountIn, 6)} {kutip.symbolIn}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">{t('Diterima')}</span>
                <span className="num font-medium">{num(kutip.amountOut, 6)} {kutip.symbolOut}</span>
              </div>
              <Separator />
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">{t('Nilai')}</span>
                <span className="num">{usd(kutip.usdIn)} → {usd(kutip.usdOut)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted">{t('Biaya rute')}</span>
                <span className={`num ${kutip.tooLossy ? 'text-danger' : ''}`}>
                  {kutip.lossBps != null ? `${num(kutip.lossBps / 100, 2)}%` : '—'}
                </span>
              </div>
              {kutip.dex && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted">{t('Lewat')}</span><span className="text-end">{kutip.dex}</span>
                </div>
              )}
            </Card.Content>
          </Card>
        )}

        {kutip?.tooLossy && (
          <div className="flex items-start gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{t('Rute ini rugi {a}%, di atas batas {b}%. Kecilkan jumlahnya, atau naikkan batas di Aturan → Keluar posisi.', {
              a: num(kutip.lossBps / 100, 1), b: num(kutip.maxLossBps / 100, 1),
            })}</span>
          </div>
        )}

        {dry ? (
          <Button variant="outline" className="w-full" onPress={() => { location.hash = 'pengaturan'; }}>{t('Nyalakan LIVE dulu')}</Button>
        ) : !konfirm ? (
          <Button className="w-full" isDisabled={!kutip || !!kutip.error || kutip.tooLossy} onPress={() => setKonfirm(true)}>
            {t('Tukar')}
          </Button>
        ) : (
          <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
            <div className="text-sm font-medium">{t('Kirim transaksi sungguhan?')}</div>
            <div className="text-sm text-muted">
              {num(kutip.amountIn, 6)} {kutip.symbolIn} → ±{num(kutip.amountOut, 6)} {kutip.symbolOut}
            </div>
            <div className="flex gap-2">
              <Button className="flex-1" onPress={tukar} isPending={kirim}>{t('Ya, tukar sekarang')}</Button>
              <Button variant="outline" onPress={() => setKonfirm(false)}>{t('Batal')}</Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
