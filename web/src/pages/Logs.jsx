// Live log: the bot's own console output, polled every 2 s from /api/console. The server keeps a
// ring buffer of the latest lines (src/logbuf.js); the page asks only for lines newer than the
// last sequence it has seen. Auto-follow sticks to the bottom until the reader scrolls up.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { Pause, Play, Trash2, ArrowDownToLine } from 'lucide-react';
import { get } from '../api';
import { PageHeader, Panel, Empty } from '../components/ui';
import { useI18n } from '../i18n';

const POLL_MS = 2000;
const KEEP = 1500;   // lines kept in the page
const LEVELS = [
  ['error', /\b(error|gagal|failed|exception|fatal)\b/i, 'text-danger'],
  ['warn', /\b(warn|peringatan|retry|timeout|429)\b/i, 'text-warning'],
];
const levelOf = (line) => LEVELS.find(([, re]) => re.test(line))?.[0] || 'info';
const COLOR = { error: 'text-danger', warn: 'text-warning', info: 'text-foreground' };

export default function Logs() {
  const { t } = useI18n();
  const [lines, setLines] = useState([]);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const last = useRef(null);
  const box = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await get(last.current == null ? '/api/console?limit=500' : `/api/console?after=${last.current}`);
      if (d.error) { setError(d.error); return; }
      setError(null);
      // after a bot restart the sequence starts over: begin again from the newest lines
      if (d.reset) { last.current = null; setLines([]); return; }
      last.current = d.last;
      if (d.lines.length) setLines((cur) => [...cur, ...d.lines].slice(-KEEP));
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    if (paused) return undefined;
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [paused, load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? lines.filter((l) => l.line.toLowerCase().includes(q)) : lines;
  }, [lines, filter]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  const onScroll = () => {
    const el = box.current;
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <>
      <PageHeader title="Log langsung" desc="Keluaran bot secara realtime: sinkronisasi, keputusan, transaksi, dan error." />
      <Panel
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('Filter log…')}
              aria-label={t('Filter log…')}
              className="h-8 w-40 rounded-lg border border-border bg-surface px-2.5 text-xs outline-none focus:border-accent sm:w-56" />
            <Button size="sm" variant="secondary" onPress={() => setPaused((v) => !v)}>
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}{paused ? t('Lanjutkan') : t('Jeda')}
            </Button>
            <Button size="sm" variant="secondary" onPress={() => setLines([])}><Trash2 className="size-3.5" />{t('Bersihkan')}</Button>
          </div>
        )}
        bodyClass="p-0!"
      >
        <div className="relative">
          <div ref={box} onScroll={onScroll} role="log" aria-live="off"
            className="mono h-[65vh] overflow-auto px-3 py-2 text-[0.6875rem] leading-relaxed">
            {shown.length === 0
              ? <Empty title={error ? 'Log tidak bisa dimuat' : 'Belum ada baris log'} />
              : shown.map((l) => (
                <div key={l.seq} className={`whitespace-pre-wrap break-words ${COLOR[levelOf(l.line)]}`}>{l.line}</div>
              ))}
          </div>
          {!follow && (
            <Button size="sm" variant="primary" className="absolute bottom-3 right-4"
              onPress={() => { setFollow(true); if (box.current) box.current.scrollTop = box.current.scrollHeight; }}>
              <ArrowDownToLine className="size-3.5" />{t('Ke bawah')}
            </Button>
          )}
        </div>
      </Panel>
      <p className="mt-2 text-xs text-muted">
        {paused ? t('Dijeda') : t('Diperbarui tiap {s} detik', { s: POLL_MS / 1000 })} · {shown.length}/{lines.length} {t('baris')}
      </p>
    </>
  );
}
