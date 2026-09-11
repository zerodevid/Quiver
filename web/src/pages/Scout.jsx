import { useEffect, useRef, useState } from 'react';
import { Button, ProgressBar, toast } from '@heroui/react';
import { get, post } from '../api';
import { PageHeader, Panel, Stat, DataTable, Empty, PriceRange, Text, Pick } from '../components/ui';
import { usd, tone } from '../fmt';
import { useI18n } from '../i18n';

export default function Scout() {
  const { t } = useI18n();
  const [addr, setAddr] = useState('');
  const [blocks, setBlocks] = useState('900000');
  const [job, setJob] = useState(null);
  const timer = useRef(null);
  const a = addr.trim().toLowerCase();
  const valid = /^0x[0-9a-f]{40}$/.test(a);
  useEffect(() => () => clearInterval(timer.current), []);

  const run = async () => {
    const r = await post('/api/scout', { address: a, blocks: Number(blocks) });
    if (r.error) return toast.danger(r.error);
    setJob({ status: 'jalan', progress: 0 });
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const d = await get('/api/scout?address=' + a);
      setJob(d);
      if (d.status !== 'jalan') clearInterval(timer.current);
    }, 1200);
  };
  const r = job?.result;
  const pairs = r ? Object.entries(r.pairs).sort((x, y) => y[1].valueUsd - x[1].valueUsd) : [];
  const live = r ? r.positions.filter((p) => Number(p.liquidity) > 0).sort((x, y) => y.valueUsd - x.valueUsd).slice(0, 25) : [];

  return (
    <>
      <PageHeader group="Riset" title="Scout" desc="Potret cepat posisi yang sedang hidup: ukuran, lebar rentang, dan fee yang belum diklaim." />
      <Panel className="mb-4">
        <div className="grid items-end gap-3 md:grid-cols-[1fr_12rem_auto]">
          <Text label="Alamat wallet" mono placeholder="0x…" value={addr} onChange={setAddr}
            isInvalid={addr !== '' && !valid} error="Alamat harus 0x diikuti 40 karakter hex." />
          <Pick label="Jendela pindai" value={blocks} onChange={setBlocks}
            options={[['450000', '~12 jam'], ['900000', '~1 hari'], ['2600000', '~3 hari'], ['6000000', '~7 hari']]} />
          <Button onPress={run} isDisabled={!valid} isPending={job?.status === 'jalan'}>{t('Periksa')}</Button>
        </div>
        {job?.status === 'jalan' && (
          <ProgressBar value={job.progress || 2} size="sm" aria-label={t('Progres')} className="mt-4">
            <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
          </ProgressBar>
        )}
        {job?.status === 'gagal' && <p className="mt-3 text-sm text-danger">{t('Gagal: {e}', { e: job.error })}</p>}
      </Panel>

      {r && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Nilai posisi hidup" value={usd(r.totalValueUsd)} sub={t('{n} posisi hidup', { n: r.positionsAlive })} />
            <Stat label="Fee belum diklaim" value={usd(r.totalUnclaimedFeeUsd)} sub={t('{p}% dari nilai', { p: r.feeRatioPct.toFixed(2) })} />
            <Stat label="Sedang in-range" value={`${r.inRangePct.toFixed(0)}%`} sub={t('median umur {h} jam', { h: r.medianAgeHours.toFixed(1) })} />
            <Stat label="Ukuran & rentang khas" value={usd(r.medianPositionUsd, 0)} sub={t('lebar median {w}%', { w: r.medianWidthPct.toFixed(0) })} />
          </div>
          <div className="grid items-start gap-3 lg:grid-cols-5">
            <Panel title="Pasangan" className="lg:col-span-2" bodyClass="p-0">
              <DataTable label="Pasangan" rows={pairs} rowKey={([k]) => k}
                defaultSort={{ column: 'v', direction: 'descending' }}
                columns={[
                  { key: 'k', label: 'Pasangan', sort: ([k]) => k, render: ([k]) => k },
                  { key: 'n', label: 'Posisi', align: 'end', sort: ([, v]) => v.n, render: ([, v]) => v.n },
                  { key: 'v', label: 'Nilai', align: 'end', sort: ([, v]) => v.valueUsd, render: ([, v]) => usd(v.valueUsd, 0) },
                  { key: 'f', label: 'Fee', align: 'end', sort: ([, v]) => v.feeUsd, render: ([, v]) => <span className="text-success">{usd(v.feeUsd)}</span> },
                ]} />
            </Panel>
            <Panel title="Posisi hidup" desc={t('{n} posisi dilepas dalam jendela ini', { n: r.positionsClosed })} className="lg:col-span-3" bodyClass="p-0">
              <DataTable label="Posisi hidup" rows={live} rowKey={(p) => p.tokenId} searchable pageSize={15}
                defaultSort={{ column: 'v', direction: 'descending' }}
                empty={<Empty title="Tidak ada posisi hidup" />}
                columns={[
                  { key: 'p', label: 'Pasangan', sort: (p) => `${p.symbol0}/${p.symbol1}`, render: (p) => <div>{p.symbol0}/{p.symbol1}
                    <span className={`ml-2 text-xs ${p.inRange ? 'text-success' : 'text-warning'}`}>{t(p.inRange ? 'in' : 'luar')}</span></div> },
                  { key: 'r', label: 'Rentang harga', sortable: false, render: (p) => <PriceRange lo={p.tickLower} hi={p.tickUpper} cur={p.curTick}
                    dec0={p.dec0} dec1={p.dec1} quoteSide={p.quoteSide} symbol0={p.symbol0} symbol1={p.symbol1} /> },
                  { key: 'v', label: 'Nilai', align: 'end', sort: (p) => p.valueUsd, render: (p) => usd(p.valueUsd, 0) },
                  { key: 'f', label: 'Fee', align: 'end', sort: (p) => p.feeUsd, render: (p) => <span className={tone(p.feeUsd)}>{usd(p.feeUsd)}</span> },
                  { key: 'a', label: 'Umur', align: 'end', sort: (p) => p.ageHours, render: (p) => <span className="text-muted">{p.ageHours == null ? '—' : p.ageHours.toFixed(1) + t(' j')}</span> },
                ]} />
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
