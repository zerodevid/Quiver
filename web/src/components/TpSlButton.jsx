import { useState } from 'react';
import { Button, Modal, toast } from '@heroui/react';
import { ShieldCheck, TriangleAlert, Info } from 'lucide-react';
import { get, post, withChain } from '../api';
import { useI18n, reason } from '../i18n';
import { usd, pct } from '../fmt';

// Per-position take profit / stop loss, for copy (mirror) and manual positions alike.
// Each side has three states, so "not set" can never be confused with "off":
//   inherit — follow the rules (per-target, else global): the position's own value is empty
//   custom  — a threshold for THIS position only
//   off     — no trigger on this side, even if the rules define one
// Thresholds are PnL % of the position's cost (fees included, before exit gas/slippage) — the same
// basis as the rule-level stop loss / take profit.
const SL_MAX = 99.9, TP_MAX = 10000;

const modeOf = (v) => (v == null ? 'inherit' : v === 0 ? 'off' : 'custom');

function Side({ id, label, tone, mode, setMode, value, setValue, ruleText, max, busy, unit, children }) {
  const { t } = useI18n();
  const Opt = ({ v, text }) => <label className={`flex min-h-9 flex-1 cursor-pointer items-center justify-center rounded-md border px-2 text-xs ${mode === v ? 'border-accent bg-accent/10 font-medium' : 'border-border text-muted'}`}>
    <input type="radio" className="sr-only" name={`${id}-mode`} checked={mode === v} disabled={busy} onChange={() => setMode(v)} />{text}
  </label>;
  return <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3" disabled={busy}>
    <legend className={`px-1 text-sm font-semibold ${tone}`}>{label}</legend>
    <div className="flex gap-2">
      <Opt v="inherit" text={t('Ikut aturan')} />
      <Opt v="custom" text={t('Atur sendiri')} />
      <Opt v="off" text={t('Nonaktif')} />
    </div>
    {mode === 'inherit' && <p className="text-xs text-muted">{ruleText}</p>}
    {mode === 'off' && <p className="text-xs text-muted">{t('Tidak ada pemicu di sisi ini untuk posisi ini, walaupun aturan menetapkannya.')}</p>}
    {mode === 'custom' && <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted">{unit}</span>
      <input className="rounded-md border border-border bg-transparent p-3" type="number" inputMode="decimal" min="0.1" max={max} step="0.1"
        value={value} onChange={(e) => setValue(e.target.value)} aria-label={label} />
    </label>}
    {children}
  </fieldset>;
}

// Body text stays in the normal foreground colour on every tone (readable on a tinted background in
// both themes); only the icon and the border carry the tone.
const NOTE_TONE = {
  warn: { box: 'border border-warning/40 bg-warning/10', icon: 'text-warning' },
  danger: { box: 'border border-danger/40 bg-danger/10', icon: 'text-danger' },
  muted: { box: 'bg-default/50', icon: 'text-muted' },
};
const Note = ({ tone = 'muted', icon: Icon = Info, children }) => <div className={`flex gap-2 rounded-md p-3 text-xs text-foreground ${NOTE_TONE[tone].box}`}>
  <Icon className={`mt-0.5 size-3.5 shrink-0 ${NOTE_TONE[tone].icon}`} aria-hidden /><div className="flex flex-col gap-1">{children}</div>
</div>;

export default function TpSlButton({ p, reload, disabled = false, compact = false }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [info, setInfo] = useState(null), [error, setError] = useState('');
  const [slMode, setSlMode] = useState('inherit'), [slVal, setSlVal] = useState('');
  const [tpMode, setTpMode] = useState('inherit'), [tpVal, setTpVal] = useState('');
  const [ack, setAck] = useState(false);
  if (!p || p.empty || p.status === 'closed') return null;
  const pair = `${p.symbol0}/${p.symbol1}`;
  const isCopy = !!(p.target && p.mirror_of);
  const slSet = p.sl_pct != null && p.sl_pct > 0, tpSet = p.tp_pct != null && p.tp_pct > 0;
  const active = slSet || tpSet;
  const label = t('Take profit / Stop loss');
  const status = [slSet && `SL −${p.sl_pct}%`, tpSet && `TP +${p.tp_pct}%`].filter(Boolean).join(' · ') || 'OFF';

  const show = async () => {
    setOpen(true); setBusy(true); setError(''); setInfo(null); setAck(false);
    try {
      const r = await get(withChain(`/api/positions/exit?id=${p.id}`, p.chain));
      if (r.error) throw new Error(r.error);
      setInfo(r);
      setSlMode(modeOf(r.slPct)); setSlVal(r.slPct > 0 ? String(r.slPct) : '');
      setTpMode(modeOf(r.tpPct)); setTpVal(r.tpPct > 0 ? String(r.tpPct) : '');
    } catch (e) { setError(reason(e.message)); }
    finally { setBusy(false); }
  };

  const sl = slMode === 'custom' ? Number(slVal) : null, tp = tpMode === 'custom' ? Number(tpVal) : null;
  const slOk = slMode !== 'custom' || (Number.isFinite(sl) && sl >= 0.1 && sl <= SL_MAX);
  const tpOk = tpMode !== 'custom' || (Number.isFinite(tp) && tp >= 0.1 && tp <= TP_MAX);

  // What the position's PnL looks like now vs the thresholds that would be saved.
  const now = info?.pnlPct;
  const effSl = slMode === 'custom' ? sl : slMode === 'inherit' ? info?.rules.stopLossPct : 0;
  const effTp = tpMode === 'custom' ? tp : tpMode === 'inherit' ? info?.rules.takeProfitPct : 0;
  const slHit = slOk && effSl > 0 && now != null && now <= -effSl;
  const tpHit = tpOk && effTp > 0 && now != null && now >= effTp;
  const instant = (slMode !== 'inherit' && slHit) || (tpMode !== 'inherit' && tpHit);
  const tight = slMode === 'custom' && slOk && sl < 2;
  const cost = info?.costUsd;
  const money = (v) => (cost > 0 && v != null ? ` (≈ ${usd(cost * v / 100)})` : '');
  const unchanged = info && modeOf(info.slPct) === slMode && modeOf(info.tpPct) === tpMode
    && (slMode !== 'custom' || sl === info.slPct) && (tpMode !== 'custom' || tp === info.tpPct);
  const canSave = !busy && info && slOk && tpOk && !unchanged && (!instant || ack);

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setError('');
    try {
      const r = await post(withChain('/api/positions/exit', p.chain), {
        id: p.id,
        slPct: slMode === 'inherit' ? null : slMode === 'off' ? 0 : sl,
        tpPct: tpMode === 'inherit' ? null : tpMode === 'off' ? 0 : tp,
      });
      if (r.error) throw new Error(r.error);
      setOpen(false);
      toast.success(t('Take profit / stop loss {pair} disimpan', { pair }));
      reload?.();
    } catch (e) { setError(reason(e.message)); }
    finally { setBusy(false); }
  };

  return <>
    {compact ? (
      <Button size="sm" variant="tertiary" isIconOnly className="relative" isDisabled={disabled} onPress={show}
        aria-label={`${label} · ${status}`} title={`${label} · ${status}`}>
        <ShieldCheck className="size-4" />
        {active && <span aria-hidden className="absolute end-0.5 top-0.5 size-1.5 rounded-full bg-success ring-2 ring-surface" />}
      </Button>
    ) : (
      <Button size="sm" variant="outline" isDisabled={disabled} onPress={show}>
        <span aria-hidden className={`size-1.5 rounded-full ${active ? 'bg-success' : 'bg-muted/50'}`} />
        {t('TP / SL')}
        <span className={`text-[11px] font-medium tracking-wide ${active ? 'text-success' : 'text-muted'}`}>{status}</span>
      </Button>
    )}
    <Modal isOpen={open} onOpenChange={setOpen}>
      <Modal.Backdrop isDismissable={!busy}>
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header><Modal.Heading>{label} · {pair}</Modal.Heading></Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              <p className="text-sm text-muted">{t('Tutup posisi ini otomatis saat PnL-nya mencapai batas di bawah. Berlaku hanya untuk posisi ini dan mengalahkan aturan target/global.')}</p>
              {info && <>
                <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md bg-default/50 p-3 text-sm">
                  <span><span className="text-muted">{t('PnL sekarang')}</span> <b className={now == null ? '' : now >= 0 ? 'text-success' : 'text-danger'}>{now == null ? t('belum terbaca') : pct(now, 2)}</b></span>
                  <span><span className="text-muted">{t('Modal')}</span> <b>{usd(cost)}</b></span>
                  <span><span className="text-muted">{t('Sumber')}</span> <b>{info.isCopy ? t('Copy target') : t('Manual')}</b></span>
                </div>

                <Side id={`sl-${p.id}`} label={t('Stop loss')} tone="text-danger" mode={slMode} setMode={setSlMode} value={slVal} setValue={setSlVal}
                  max={SL_MAX} busy={busy} unit={t('Tutup saat rugi mencapai (%)')}
                  ruleText={info.rules.stopLossPct > 0 ? t('Mengikuti aturan: tutup saat rugi −{n}%.', { n: info.rules.stopLossPct }) : t('Aturan tidak menetapkan stop loss — tidak ada pemicu.')}>
                  {slMode === 'custom' && slOk && <p className="text-xs text-muted">{t('Tutup saat PnL ≤ −{n}%', { n: sl })}{money(sl)}</p>}
                  {slMode === 'custom' && !slOk && <p role="alert" className="text-xs text-danger">{t('Isi 0,1 sampai {max}.', { max: SL_MAX })}</p>}
                </Side>

                <Side id={`tp-${p.id}`} label={t('Take profit')} tone="text-success" mode={tpMode} setMode={setTpMode} value={tpVal} setValue={setTpVal}
                  max={TP_MAX} busy={busy} unit={t('Tutup saat untung mencapai (%)')}
                  ruleText={info.rules.takeProfitPct > 0 ? t('Mengikuti aturan: tutup saat untung +{n}%.', { n: info.rules.takeProfitPct }) : t('Aturan tidak menetapkan take profit — tidak ada pemicu.')}>
                  {tpMode === 'custom' && tpOk && <p className="text-xs text-muted">{t('Tutup saat PnL ≥ +{n}%', { n: tp })}{money(tp)}</p>}
                  {tpMode === 'custom' && !tpOk && <p role="alert" className="text-xs text-danger">{t('Isi 0,1 sampai {max}.', { max: TP_MAX })}</p>}
                </Side>

                {instant && <Note tone="danger" icon={TriangleAlert}>
                  <b>{slHit && slMode !== 'inherit' ? t('Batas stop loss sudah terlewati.') : t('Target take profit sudah tercapai.')}</b>
                  <span>{t('Posisi akan ditutup penuh pada sinkron berikutnya (±30 detik) dan transaksinya tidak bisa dibatalkan.')}</span>
                  <label className="flex min-h-9 items-center gap-2"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    <span>{t('Saya paham, tutup posisi sekarang')}</span></label>
                </Note>}
                {tight && !instant && <Note tone="warn" icon={TriangleAlert}>
                  <span>{t('Stop loss di bawah 2% mudah terpicu oleh gerak harga biasa, plus gas dan slippage saat keluar. Posisi LP naik-turun wajar sebelum fee menutupinya.')}</span>
                </Note>}

                {isCopy && <Note tone="warn" icon={TriangleAlert}>
                  <b>{t('Posisi ini mengikuti target — yang perlu kamu tahu:')}</b>
                  <ul className="list-disc space-y-1 ps-4">
                    <li>{t('TP/SL di sini mengalahkan aturan stop loss / take profit milik target ini dan aturan global, hanya untuk posisi ini.')}</li>
                    <li>{t('Saat terpicu, bot menutup penuh posisi kita. Target tetap memegang posisinya — kita tidak ikut lagi.')}</li>
                    <li>{t('Penutupan oleh TP/SL tidak membuka ulang otomatis. Kalau target menambah likuiditas di posisi yang sama sesudahnya, bot bisa membuka posisi cermin BARU (tanpa TP/SL ini) sesuai aturan.')}</li>
                    <li>{info.rules.followTarget ? t('Ikut-keluar target tetap aktif: posisi ditutup oleh mana pun yang lebih dulu — TP/SL ini atau keluarnya target.') : t('Ikut-keluar target mati: hanya TP/SL ini dan pemicu aturan lain yang menutup posisi.')}</li>
                    <li>{info.takeoverTs != null ? t('Posisi sedang dalam kendali manual: TP/SL yang kamu atur sendiri tetap berlaku (aturan umum tidak).') : t('Kalau kamu mengambil alih posisi ini, aturan umum berhenti berlaku, tetapi TP/SL yang kamu atur di sini tetap jalan.')}</li>
                  </ul>
                </Note>}

                <Note icon={Info}>
                  <b>{t('Cara kerjanya')}</b>
                  <ul className="list-disc space-y-1 ps-4">
                    <li>{t('Ambangnya adalah PnL % dari modal posisi, termasuk fee yang terkumpul, sebelum gas dan slippage keluar.')}</li>
                    <li>{t('Dicek setiap sinkron (±30 detik), bukan seketika. Harga bisa melewati batas dulu sebelum transaksi terkirim, jadi hasil akhir bisa lebih buruk atau lebih baik dari angkanya.')}</li>
                    <li>{t('Posisi ditutup penuh; memecoin sisa dijual lewat antrean jual yang sama dengan penutupan biasa.')}</li>
                    <li>{t('Tidak dinilai saat harga atau likuiditas posisi gagal terbaca dari RPC — bot menunggu sinkron yang berhasil. Bot harus berjalan.')}</li>
                    <li>{t('Tetap berlaku walau bot dijeda: jeda hanya menahan entry baru.')}</li>
                  </ul>
                </Note>
                {info.dryRun && <Note tone="warn" icon={TriangleAlert}>
                  <span>{t('Mode simulasi aktif: TP/SL hanya dicatat di log, tidak mengirim transaksi. Matikan simulasi di Pengaturan agar benar-benar menutup posisi.')}</span>
                </Note>}
              </>}
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setOpen(false)}>{t('Batal')}</Button>
              <Button isPending={busy} isDisabled={!canSave} onPress={save}>{t('Simpan')}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  </>;
}
