import { useState } from 'react';
import { Button, Modal, toast } from '@heroui/react';
import { get, post } from '../api';
import { useI18n } from '../i18n';
import { usd, ago } from '../fmt';

// Panen fee otomatis untuk satu posisi. Dua mode yang saling menggantikan:
//   compound — fee dikembalikan jadi likuiditas di posisi yang sama (v3 & v4)
//   klaim    — fee ditarik ke wallet; sisi memecoin-nya dijual ke aset kuotasi pool
// Tombolnya tetap satu: yang dipilih di dalam modal menentukan apa yang dijalankan.
export default function AutoCompoundButton({ p, reload, disabled = false }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [data, setData] = useState(null), [error, setError] = useState('');
  const [enabled, setEnabled] = useState(false), [minimum, setMinimum] = useState('5'), [interval, setInterval] = useState('30');
  const [mode, setMode] = useState('compound'), [sellFee, setSellFee] = useState(true);
  // Venue tanpa NFT posisi tidak bisa dipanen otomatis. Posisi lama yang belum
  // disinkron ulang belum punya blok compound: jatuhkan ke aturan v4 yang dulu.
  if (!(p.compound?.supported ?? p.venue === 'v4')) return null;
  const quoteSym = p.quoteSide === 0 ? p.symbol0 : p.quoteSide === 1 ? p.symbol1 : null;
  const show = async () => {
    setOpen(true); setBusy(true); setError(''); setData(null);
    try {
      const r = await get(`/api/positions/compound?id=${p.id}`);
      if (r.error) throw new Error(r.error);
      setData(r.compound); setEnabled(r.compound.enabled);
      setMode(r.compound.mode || 'compound'); setSellFee(r.compound.sellFee !== false);
      setMinimum(String(r.compound.minUsd)); setInterval(String(r.compound.intervalMinutes));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const r = await post('/api/positions/compound', { id: p.id, enabled, mode, sellFee,
        minUsd: Number(minimum), intervalMinutes: Number(interval) });
      if (r.error) throw new Error(r.error);
      setData(r.compound); setOpen(false);
      toast.success(t('Pengaturan panen fee disimpan'));
      reload?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  // Status ON/OFF jadi titik warna + label kecil, bukan bagian dari teks tombol:
  // tombolnya tetap bentuk tombol biasa, statusnya terbaca sekilas.
  const on = !!(p.compound?.enabled ?? data?.enabled);
  const modeNow = data?.mode ?? p.compound?.mode ?? 'compound';
  const valid = Number(minimum) >= 0.01 && Number(minimum) <= 1000000
    && Number.isInteger(Number(interval)) && Number(interval) >= 1 && Number(interval) <= 10080;
  const Pilihan = ({ value, judul, ket }) => <label className="flex min-h-11 items-start gap-3 rounded-md border border-border p-3">
    <input type="radio" name={`panen-${p.id}`} className="mt-1" checked={mode === value} disabled={busy}
      onChange={() => setMode(value)} />
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-medium">{judul}</span>
      <span className="text-xs text-muted">{ket}</span>
    </span>
  </label>;
  return <>
    <Button size="sm" variant="outline" isDisabled={disabled || p.empty} onPress={show}>
      <span aria-hidden className={`size-1.5 rounded-full ${on ? 'bg-success' : 'bg-muted/50'}`} />
      {t('Panen fee')}
      <span className={`text-[11px] font-medium tracking-wide ${on ? 'text-success' : 'text-muted'}`}>
        {on ? (modeNow === 'claim' ? t('KLAIM') : t('COMPOUND')) : 'OFF'}
      </span>
    </Button>
    <Modal isOpen={open} onOpenChange={setOpen}>
      <Modal.Backdrop isDismissable={!busy}>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header><Modal.Heading>{t('Panen fee otomatis')} · {p.symbol0}/{p.symbol1}</Modal.Heading></Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <p className="text-sm text-muted">{t('Fee posisi dipanen sendiri menurut minimum dan interval di bawah — bukan mengikuti kapan target memanen fee-nya.')}</p>
              {data && <>
                <div className="flex flex-col gap-2">
                  <Pilihan value="compound" judul={t('Compound — fee jadi likuiditas lagi')}
                    ket={t('Hanya fee yang dipakai; tidak ada swap. Sisa token yang tidak cocok dengan rasio LP masuk ke wallet.')} />
                  <Pilihan value="claim" judul={t('Klaim — fee ditarik ke wallet')}
                    ket={t('Sisi aset kuotasi langsung jadi uang; sisi memecoin-nya dijual lewat antrean jual yang sama dengan sisa penutupan.')} />
                </div>
                {mode === 'claim' && <label className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" checked={sellFee} disabled={busy} onChange={(e) => setSellFee(e.target.checked)} />
                  <span>{quoteSym ? t('Jual sisi memecoin ke {q}', { q: quoteSym }) : t('Jual sisi memecoin ke aset kuotasi pool')}</span>
                </label>}
                <label className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} />
                  <span>{t('Aktifkan panen otomatis')}</span>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('Minimum nilai fee ($)')}</span>
                  <input className="rounded-md border border-border bg-transparent p-3" type="number" min="0.01" max="1000000" step="0.01" value={minimum} disabled={busy} onChange={(e) => setMinimum(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span>{t('Interval pemeriksaan (menit)')}</span>
                  <input className="rounded-md border border-border bg-transparent p-3" type="number" min="1" max="10080" step="1" value={interval} disabled={busy} onChange={(e) => setInterval(e.target.value)} />
                </label>
                <p className="text-xs text-muted">{t('Berjalan saat mode LIVE dan bot tidak dijeda. Slippage serta batas posisi mengikuti Aturan. Simpan dengan ON mengizinkan transaksi otomatis.')}</p>
                <div className="text-xs text-muted">
                  <div>{t('Total ditambahkan (perkiraan)')}: {usd(data.compoundedUsd)}</div>
                  {data.lastCheck && <div>{t('Pemeriksaan terakhir')}: {ago(data.lastCheck)}</div>}
                  {data.lastNote && <div>{t(data.lastNote)}</div>}
                </div>
              </>}
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setOpen(false)}>{t('Batal')}</Button>
              <Button isPending={busy} isDisabled={busy || !data || !valid} onPress={save}>{t('Simpan')}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  </>;
}
