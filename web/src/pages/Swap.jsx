import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Spinner, Select, ListBox, toast } from '@heroui/react';
import { ArrowDownUp, Check, TriangleAlert } from 'lucide-react';
import { get, post } from '../api';
import { useStatus } from '../App';
import { PageHeader, Notice, Loading, KV } from '../components/ui';
import TokenIcon from '../components/TokenIcon';
import { usd, num } from '../fmt';
import { useI18n } from '../i18n';

const PORSI = [['25%', '25%'], ['50%', '50%'], ['75%', '75%'], ['semua', 'Maks']];

// Pemilih token ala dompet: tombolnya cukup lambang + simbol (saldonya sudah ada di
// kepala kotak), daftar pilihannya menampilkan saldo tiap token di kanan.
function TokenSelect({ value, onChange, list, aria }) {
  const { t } = useI18n();
  const cur = list.find((x) => x.address === value);
  return (
    <Select variant="secondary" value={value} onChange={(v) => onChange(v)} aria-label={t(aria)} className="w-36 shrink-0">
      <Select.Trigger className="h-10 rounded-full! pl-1.5">
        {cur ? <span className="flex min-w-0 items-center gap-2"><TokenIcon address={cur.address} symbol={cur.symbol} size={24} />
          <span className="truncate font-semibold">{cur.symbol}</span></span> : <Select.Value />}
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="min-w-56">
        <ListBox>
          {list.map((x) => (
            <ListBox.Item key={x.address} id={x.address} textValue={x.symbol}>
              <span className="flex w-full items-center gap-2.5">
                <TokenIcon address={x.address} symbol={x.symbol} size={22} />
                <span className="font-medium">{x.symbol}</span>
                <span className="num ml-auto text-xs text-muted">{num(x.amount, 6)}</span>
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

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
        <div className="mx-auto max-w-md">
          <Notice status="warning" title={t('Mode simulasi')}>
            {t('Kutipan tetap diambil, tapi transaksi tidak akan dikirim. Nyalakan LIVE di Pengaturan kalau memang mau menukar.')}
          </Notice>
        </div>
      )}

      <div className="mx-auto mt-4 flex max-w-md flex-col gap-3">
        <Card className="gap-0! p-2!">
          {/* dari */}
          <div className="rounded-md bg-default/50 p-4">
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span className="font-medium">{t('Dari')}</span>
              {tDari && <span>{t('Saldo')} <span className="num">{num(tDari.amount, 6)}</span></span>}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <input value={jumlah} onChange={(e) => setJumlah(e.target.value)} placeholder="0" inputMode="decimal"
                aria-label={t('Jumlah yang ditukar')}
                className="num h-10 min-w-0 flex-1 bg-transparent text-[1.75rem] font-semibold tracking-tight outline-none placeholder:text-muted/60" />
              <TokenSelect aria="Token yang ditukar" value={dari} onChange={setDari} list={punya.filter((x) => x.address !== ke)} />
            </div>
            <div className="mt-3 flex flex-wrap justify-end gap-1.5">
              {PORSI.map(([v, label]) => (
                <button key={v} type="button" onClick={() => setJumlah(v)}
                  className={`h-6 rounded-md border px-2 text-xs font-medium transition-colors ${jumlah === v
                    ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-foreground'}`}>{t(label)}</button>
              ))}
            </div>
          </div>

          {/* pembalik */}
          <div className="relative z-10 -my-2.5 flex justify-center">
            <Button size="sm" variant="outline" isIconOnly aria-label={t('Balik arah')} onPress={balik}
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
              <div className={`num flex h-10 min-w-0 flex-1 items-center truncate text-[1.75rem] font-semibold tracking-tight ${kutip?.amountOut != null ? '' : 'text-muted/60'}`}>
                {ambil ? <Spinner size="sm" /> : kutip?.amountOut != null ? num(kutip.amountOut, 6) : '0'}
              </div>
              <TokenSelect aria="Token yang diterima" value={ke} onChange={setKe} list={tokens.filter((x) => x.address !== dari)} />
            </div>
            {kutip?.usdOut != null && !ambil && <div className="num mt-1 text-xs text-muted">≈ {usd(kutip.usdOut)}</div>}
          </div>
        </Card>

        {siap && kutip?.error && <Notice status="danger" title={t('Tidak bisa dikutip')}>{kutip.error}</Notice>}

        {kutip && !kutip.error && (
          <Card className="gap-0! px-4! py-1.5!">
            <div className="divide-y divide-border">
              <KV label="Dikirim">{num(kutip.amountIn, 6)} {kutip.symbolIn}</KV>
              <KV label="Diterima">{num(kutip.amountOut, 6)} {kutip.symbolOut}</KV>
              <KV label="Nilai">{usd(kutip.usdIn)} → {usd(kutip.usdOut)}</KV>
              <KV label="Biaya rute"><span className={kutip.tooLossy ? 'text-danger' : kutip.lossBps > 300 ? 'text-warning' : ''}>
                {kutip.lossBps != null ? `${num(kutip.lossBps / 100, 2)}%` : '—'}</span></KV>
              {kutip.dex && <KV label="Lewat"><span className="font-normal text-muted">{kutip.dex}</span></KV>}
            </div>
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
          <Button size="lg" variant="outline" className="w-full" onPress={() => { location.hash = 'pengaturan'; }}>{t('Nyalakan LIVE dulu')}</Button>
        ) : !konfirm ? (
          <Button size="lg" className="w-full" isDisabled={!kutip || !!kutip.error || kutip.tooLossy} onPress={() => setKonfirm(true)}>
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
