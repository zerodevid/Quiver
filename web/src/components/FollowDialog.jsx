import { useEffect, useRef, useState } from 'react';
import { Button, Modal, toast } from '@heroui/react';
import { Clock } from 'lucide-react';
import { post } from '../api';
import { useI18n, reason } from '../i18n';
import { usd, age, pct, short, locale as fmtLocale, DECISIONS } from '../fmt';
import { Notice, PriceRange, Text, KV } from './ui';

// Manually follow a target position the bot failed on/skipped. This modal doubles as the confirmation:
// the most prominent item is the LATENESS — the price has moved since the target entered, and that is
// the first thing to weigh before opening a position. The plan is computed by the server at the
// current price (and recomputed when the transaction is sent).
export default function FollowDialog({ action, onClose, onDone }) {
  const { t } = useI18n();
  const [notional, setNotional] = useState('');
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const seq = useRef(0);
  const id = action?.id ?? null;

  // Open the modal: preview with the server's suggested amount; the amount is then filled into the field.
  useEffect(() => {
    if (id == null) return;
    setPlan(null); setNotional('');
    const mine = ++seq.current;
    setLoading(true);
    post('/api/activity/follow/plan', { actionId: id }).then((r) => {
      if (mine !== seq.current) return;
      setPlan(r); setLoading(false);
      const u = r.follow?.usd ?? r.follow?.suggestUsd;
      if (u != null) setNotional(String(u));
    });
  }, [id]);

  const usdNum = Number(String(notional).replace(',', '.'));
  const notionalOk = Number.isFinite(usdNum) && usdNum > 0;
  // Amount changed: the preview is recomputed (late replies are discarded).
  useEffect(() => {
    if (id == null || !plan?.follow || !notionalOk || usdNum === plan.follow.usd) return;
    const mine = ++seq.current;
    setLoading(true);
    const h = setTimeout(async () => {
      const r = await post('/api/activity/follow/plan', { actionId: id, usd: usdNum });
      if (mine !== seq.current) return;
      setPlan((old) => ({ ...r, follow: r.follow || old?.follow }));
      setLoading(false);
    }, 400);
    return () => clearTimeout(h);
  }, [usdNum]);

  const f = plan?.follow;
  const p = plan?.preview;
  const lateMin = f ? f.ageMs / 60000 : 0;
  // Tone thresholds: < 5 minutes is still reasonable, > 30 minutes the memecoin price has usually moved far.
  const lateTone = lateMin >= 30 ? 'danger' : lateMin >= 5 ? 'warning' : 'default';
  const pair = f?.pair || (action?.symbol0 ? `${action.symbol0}/${action.symbol1}` : '');
  const e = f?.exit;
  const exits = !e ? [] : [
    e.followTarget && (e.followPartial
      ? t('Ikut ditutup saat target menutup posisi #{id}, dan ikut ditarik sebagian saat target menarik sebagian.', { id: f.tokenId })
      : t('Ikut ditutup saat target menutup posisi #{id}.', { id: f.tokenId })),
    e.stopLossPct > 0 && t('Stop loss di −{n}%.', { n: e.stopLossPct }),
    e.takeProfitPct > 0 && t('Take profit di +{n}%.', { n: e.takeProfitPct }),
    e.maxAgeHours > 0 && t('Ditutup setelah berumur {n} jam.', { n: e.maxAgeHours }),
    e.outOfRangeMinutes > 0 && t('Ditutup setelah {n} menit di luar rentang.', { n: e.outOfRangeMinutes }),
    e.outOfRangePct > 0 && t('Ditutup kalau harga lebih dari {n}% di luar rentang.', { n: e.outOfRangePct }),
    e.outOfRangePct > 0 && e.reenterWithinPct > 0 && t('Dibuka lagi kalau harga kembali ≤ {n}% dari rentang dan target masih di dalam.', { n: e.reenterWithinPct }),
  ].filter(Boolean);
  const k = f ? DECISIONS[f.verdict] : null;
  const canOpen = !!plan?.plan && !plan.error && !loading && !sending && notionalOk;

  const open = async () => {
    if (!canOpen) return;
    setSending(true);
    const wait = toast(t('Membuka posisi {pair}…', { pair }), {
      description: t('Jembatan kas, zap, lalu mint — bisa sampai satu menit.'), isLoading: true, timeout: 0,
    });
    let r;
    try { r = await post('/api/activity/follow', { actionId: id, usd: usdNum }); }
    catch (err) { r = { error: err.message }; }
    toast.close(wait);
    setSending(false);
    if (r.error) return toast.danger(t('Gagal membuka {pair}', { pair }), { description: reason(r.error), timeout: 12000 });
    toast.success(t('Posisi {pair} dibuka', { pair }), { description: [reason(r.note), r.positionId && `#${r.positionId}`].filter(Boolean).join(' · '), timeout: 10000 });
    onDone?.(r);
    onClose();
  };

  return (
    <Modal isOpen={id != null} onOpenChange={(o) => { if (!o && !sending) onClose(); }}>
      <Modal.Backdrop isDismissable={!sending}>
        <Modal.Container size="md" placement="center" scroll="inside">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{t('Ikuti posisi target · {pair}', { pair })}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              {!f && loading && <p className="text-sm text-muted">{t('Menghitung rencana di harga sekarang…')}</p>}
              {!f && plan?.error && <Notice status="danger" title="Tidak bisa diikuti">{reason(plan.error)}</Notice>}

              {f && <>
                <div className={`flex gap-3 rounded-lg border p-3 ${lateTone === 'danger' ? 'border-danger/40 bg-danger/10' : lateTone === 'warning' ? 'border-warning/40 bg-warning/10' : 'border-border bg-default/40'}`}>
                  <Clock className={`mt-0.5 size-5 shrink-0 ${lateTone === 'danger' ? 'text-danger' : lateTone === 'warning' ? 'text-warning' : 'text-muted'}`} />
                  <div className="text-sm">
                    <div className="font-semibold">
                      {t('Sudah terlambat {w}', { w: age(f.ageMs / 3_600_000) })}
                    </div>
                    <div className="mt-1 text-muted">
                      {t('{who} membuka posisi ini pukul {at}. Harga sudah bergerak sejak itu — posisi dibuka di harga SEKARANG, bukan harga saat target masuk.', {
                        who: f.targetLabel || short(f.target),
                        at: new Date(f.ts).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
                      })}
                    </div>
                    {f.targetOpen === null && <div className="mt-1 text-warning">{t('Status posisi target di chain tidak terbaca sekarang.')}</div>}
                  </div>
                </div>

                <div className="text-xs text-muted">
                  {t('Keputusan bot semula')}: <span className={k?.[1] === 'danger' ? 'text-danger' : ''}>{k ? t(k[0]) : f.verdict}</span>
                  {f.reason && <> — {reason(f.reason)}</>}
                </div>

                <Text label="Nominal (USD)" type="number" value={notional} onChange={setNotional}
                  isInvalid={notional !== '' && !notionalOk} error="Nominal harus lebih dari nol"
                  hint={f.targetUsd != null ? t('posisi target {v}', { v: usd(f.targetUsd) }) : null} />

                {plan.error
                  ? <Notice status="danger" title="Rencana ditolak">{reason(plan.error)}</Notice>
                  : p && (
                    <div className={`flex flex-col gap-3 ${loading ? 'opacity-60' : ''}`}>
                      <div>
                        <KV label="Nilai posisi">{usd(p.valueUsd)}</KV>
                        <KV label="Kas tersedia">{usd(p.walletCashUsd)}</KV>
                      </div>
                      <div>
                        <div className="mb-1 text-xs text-muted">{t('Rentang harga (aturan target)')}</div>
                        <PriceRange lo={p.tickLower} hi={p.tickUpper} cur={p.curTick} dec0={p.dec0} dec1={p.dec1}
                          quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1} />
                        {p.lowerPct != null && p.upperPct != null && p.side === 'both' && (
                          <div className="mt-1 text-xs text-muted">{t('dari harga sekarang: {a} / {b}', { a: pct(-p.lowerPct, 1), b: pct(p.upperPct, 1) })}</div>
                        )}
                      </div>
                      {(plan.warnings || []).length > 0 && (
                        <ul className="list-disc space-y-1 pl-5 text-xs text-warning">
                          {plan.warnings.map((w) => <li key={w}>{reason(w)}</li>)}
                        </ul>
                      )}
                    </div>
                  )}

                <div className="rounded-lg border border-border p-3">
                  <div className="text-sm font-medium">{t('Penutupan tetap otomatis')}</div>
                  {exits.length
                    ? <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-muted">{exits.map((x) => <li key={x}>{x}</li>)}</ul>
                    : <p className="mt-1.5 text-xs text-warning">{t('Aturan target ini tidak menutup posisi otomatis — tutup sendiri dari halaman Posisi.')}</p>}
                </div>
              </>}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={sending} onPress={onClose}>{t('Batal')}</Button>
              <Button isPending={sending} isDisabled={!canOpen} onPress={open}>
                {p && !plan.error ? t('Ya, buka posisi {v}', { v: usd(p.valueUsd) }) : t('Buka posisi')}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
