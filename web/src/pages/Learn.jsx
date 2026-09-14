// Belajar LP: buku singkat tentang concentrated liquidity yang dikaitkan dengan angka
// di dasbor Quiver. Tiga tampilan — materi, simulator, glosarium — berbagi satu URL:
// #learn/<bab>, #learn/lab, #learn/glossary. Progres disimpan di browser saja.
import { useEffect, useMemo, useState } from 'react';
import { Button, Chip, Input, ProgressBar } from '@heroui/react';
import {
  ArrowLeft, ArrowRight, BookOpen, Check, CircleCheck, CircleX, ExternalLink, FlaskConical, Search,
} from 'lucide-react';
import { PageHeader, Segmented, Empty } from '../components/ui';
import { useI18n } from '../i18n';
import { chapters, sources } from '../learn/content';
import { glossary, groups } from '../learn/glossary';
import Lab, { PRESETS, LAB_DEFAULT } from '../learn/Lab';

const DONE_KEY = 'quiver.learn.v1';
const LAST_KEY = 'quiver.learn.last';
const REVIEWED = ['14 September 2026', 'September 14, 2026'];

const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* progres tetap ada di memori */ }
};

// Modul diturunkan dari urutan bab, jadi menambah bab cukup di content.js.
const MODULES = chapters.reduce((out, c, i) => {
  const last = out[out.length - 1];
  if (last && last.name[0] === c.module[0]) last.items.push(i);
  else out.push({ name: c.module, items: [i] });
  return out;
}, []);
const moduleOf = (i) => MODULES.findIndex((m) => m.items.includes(i));

const minutes = (c, locale) => {
  const k = locale === 'en' ? 1 : 0;
  const words = [c.intro[k], ...c.sections.map((s) => s.body[k])].join(' ').split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
};

// Rute awal dari parameter hash; bab yang tidak dikenal jatuh ke bab terakhir dibuka.
function initialRoute(param) {
  if (param === 'lab' || param === 'glossary') return { view: param, chapter: read(LAST_KEY, chapters[0].id) };
  const known = chapters.some((c) => c.id === param);
  const last = read(LAST_KEY, null);
  return { view: 'book', chapter: known ? param : chapters.some((c) => c.id === last) ? last : chapters[0].id };
}

function ChapterNav({ pick, active, done, onPick }) {
  return (
    <nav aria-label={pick(['Daftar bab', 'Chapters'])} className="space-y-4">
      {MODULES.map((m, mi) => (
        <div key={m.name[0]}>
          <div className="px-2.5 pb-1 text-[0.6875rem] font-medium text-muted">
            {pick(['Modul', 'Module'])} {mi + 1} · {pick(m.name)}
          </div>
          <div className="flex flex-col gap-px">
            {m.items.map((i) => {
              const c = chapters[i];
              const on = i === active;
              const finished = done.includes(c.id);
              return (
                <button key={c.id} type="button" onClick={() => onPick(c.id)} aria-current={on ? 'step' : undefined}
                  className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-[0.8125rem] leading-snug transition-colors
                    ${on ? 'bg-default font-medium text-foreground' : 'text-muted hover:bg-default/60 hover:text-foreground'}`}>
                  <span className={`num mt-px flex size-4.5 shrink-0 items-center justify-center rounded-full text-[0.625rem]
                    ${finished ? 'bg-success text-white' : on ? 'border border-foreground/60' : 'border border-border'}`}>
                    {finished ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="min-w-0">{pick(c.title)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function Progress({ pick, done }) {
  const n = done.length, total = chapters.length;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-xs">
        <span className="font-medium">{pick(['Progres', 'Progress'])}</span>
        <span className="num text-muted">{n} / {total} {pick(['bab', 'chapters'])}</span>
      </div>
      <ProgressBar value={(n / total) * 100} size="sm" aria-label={pick(['Progres belajar', 'Learning progress'])} className="w-full">
        <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
      </ProgressBar>
    </div>
  );
}

// Satu pertanyaan per bab. Jawaban benar menandai bab selesai; jawaban salah
// menunjukkan penjelasan tanpa membuka jawaban yang benar.
function CheckQuestion({ pick, check, onCorrect }) {
  const [picked, setPicked] = useState(null);
  const correct = picked === check.answer;
  return (
    <section className="rounded-lg border border-border p-4 sm:p-5" aria-labelledby="learn-check">
      <div id="learn-check" className="text-xs font-medium text-muted">{pick(['Cek pemahaman', 'Check your understanding'])}</div>
      <p className="mt-1.5 text-[0.9375rem] font-medium leading-relaxed">{pick(check.question)}</p>
      <div role="radiogroup" className="mt-3 space-y-2">
        {check.options.map((o, i) => {
          const on = picked === i;
          const tone = on ? (correct ? 'border-success bg-success/8' : 'border-danger bg-danger/8') : 'border-border hover:bg-default/60';
          return (
            <button key={i} type="button" role="radio" aria-checked={on}
              onClick={() => { setPicked(i); if (i === check.answer) onCorrect(); }}
              className={`flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${tone}`}>
              <span className="num mt-px text-xs text-muted">{String.fromCharCode(65 + i)}</span>
              <span className="min-w-0 flex-1">{pick(o)}</span>
              {on && (correct ? <CircleCheck className="size-4 shrink-0 text-success" /> : <CircleX className="size-4 shrink-0 text-danger" />)}
            </button>
          );
        })}
      </div>
      {picked != null && (
        <p role="status" className="mt-3 text-sm leading-relaxed">
          <span className={`font-medium ${correct ? 'text-success' : 'text-danger'}`}>
            {pick(correct ? ['Benar.', 'Correct.'] : ['Belum tepat.', 'Not quite.'])}
          </span>{' '}
          <span className="text-muted">{correct ? pick(check.explain) : pick(['Baca ulang bagian di atas, lalu coba lagi.', 'Review the sections above, then try again.'])}</span>
        </p>
      )}
    </section>
  );
}

function Chapter({ pick, locale, index, done, onDone, onGo, onLab }) {
  const c = chapters[index];
  const finished = done.includes(c.id);
  const mi = moduleOf(index);
  const prev = chapters[index - 1], next = chapters[index + 1];
  const preset = PRESETS.find((p) => p.id === c.lab);

  return (
    <article className="min-w-0 rounded-lg border border-border bg-surface">
      <div className="px-5 py-6 sm:px-8 sm:py-8">
        <div className="max-w-[48rem]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span className="font-medium text-accent">{pick(['Modul', 'Module'])} {mi + 1} · {pick(c.module)}</span>
            <span aria-hidden="true">·</span>
            <span className="num">{pick(['Bab', 'Chapter'])} {index + 1} / {chapters.length}</span>
            <span aria-hidden="true">·</span>
            <span className="num">±{minutes(c, locale)} {pick(['menit baca', 'min read'])}</span>
            {finished && <Chip size="sm" variant="soft" color="success" className="ms-1"><Check className="size-3" />{pick(['Selesai', 'Completed'])}</Chip>}
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-balance">{pick(c.title)}</h2>
          <p className="mt-2 text-base leading-relaxed text-muted">{pick(c.intro)}</p>

          <div className="mt-6 rounded-lg bg-default/50 px-4 py-3.5">
            <div className="text-xs font-medium text-muted">{pick(['Poin utama', 'Key points'])}</div>
            <ul className="mt-2 space-y-1.5">
              {c.takeaways.map((t, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
                  <Check className="mt-1 size-3.5 shrink-0 text-accent" strokeWidth={2.5} />{pick(t)}
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-8 space-y-8">
            {c.sections.map((s, i) => (
              <section key={i}>
                <h3 className="flex items-baseline gap-2.5 text-base font-semibold tracking-tight">
                  <span className="num text-sm font-medium text-muted">{index + 1}.{i + 1}</span>{pick(s.title)}
                </h3>
                <p className="mt-2 text-[0.9375rem] leading-7 text-foreground/85">{pick(s.body)}</p>
              </section>
            ))}
          </div>

          {preset && (
            <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3.5">
              <FlaskConical className="size-5 shrink-0 text-accent" strokeWidth={1.75} />
              <div className="min-w-0 flex-1 basis-60">
                <div className="text-sm font-medium">{pick(['Coba di simulator', 'Try it in the lab'])}: {pick(preset.label)}</div>
                <div className="num mt-0.5 text-xs text-muted">
                  {pick(['Range', 'Range'])} {preset.lo}–{preset.hi} · {pick(['harga skenario', 'scenario price'])} {preset.price}
                </div>
              </div>
              <Button size="sm" variant="outline" onPress={() => onLab(preset)}>
                {pick(['Buka skenario', 'Open scenario'])}<ArrowRight className="size-3.5" />
              </Button>
            </div>
          )}

          <div className="mt-8">
            <CheckQuestion key={c.id} pick={pick} check={c.check} onCorrect={() => onDone(c.id, true)} />
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            {c.refs.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="text-muted">{pick(['Referensi', 'References'])}</span>
                {c.refs.map((r) => (
                  <a key={r} href={sources[r].href} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
                    Uniswap · {sources[r].label}<ExternalLink className="size-3" />
                  </a>
                ))}
              </div>
            ) : <span />}
            <Button size="sm" variant={finished ? 'ghost' : 'outline'} onPress={() => onDone(c.id, !finished)}>
              <Check className="size-3.5" />{pick(finished ? ['Batalkan tanda selesai', 'Mark as not done'] : ['Tandai selesai', 'Mark as done'])}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid border-t border-border sm:grid-cols-2">
        {prev ? (
          <button type="button" onClick={() => onGo(prev.id)}
            className="group flex items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-default/50 sm:px-8">
            <ArrowLeft className="size-4 shrink-0 text-muted transition-transform group-hover:-translate-x-0.5" />
            <span className="min-w-0">
              <span className="block text-xs text-muted">{pick(['Sebelumnya', 'Previous'])}</span>
              <span className="block truncate text-sm font-medium">{pick(prev.title)}</span>
            </span>
          </button>
        ) : <span className="hidden sm:block" />}
        <button type="button" onClick={() => (next ? onGo(next.id) : onLab(null))}
          className="group flex items-center justify-end gap-3 border-t border-border px-5 py-4 text-right transition-colors hover:bg-default/50 sm:border-t-0 sm:border-l sm:px-8">
          <span className="min-w-0">
            <span className="block text-xs text-muted">{next ? pick(['Berikutnya', 'Next']) : pick(['Selanjutnya', 'Up next'])}</span>
            <span className="block truncate text-sm font-medium">{next ? pick(next.title) : pick(['Uji skenario di simulator', 'Test scenarios in the lab'])}</span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </article>
  );
}

function Glossary({ pick, onChapter }) {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('all');
  const needle = q.trim().toLowerCase();
  const rows = glossary.filter((g) => (group === 'all' || g.group === group)
    && (!needle || [...g.term, ...g.def, ...(g.quiver || [])].some((x) => x.toLowerCase().includes(needle))));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input variant="secondary" className="w-full pl-8" value={q} aria-label={pick(['Cari istilah', 'Search terms'])}
            placeholder={pick(['Cari istilah…', 'Search terms…'])} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented size="sm" value={group} onChange={setGroup} aria={pick(['Kategori', 'Category'])}
          options={[['all', pick(['Semua', 'All'])], ...groups.map(([id, name]) => [id, pick(name), glossary.filter((g) => g.group === id).length])]} />
      </div>

      {!rows.length && <Empty title={pick(['Istilah tidak ditemukan', 'No matching terms'])} sub={pick(['Coba kata lain atau pilih kategori Semua.', 'Try another word or choose All.'])} />}

      {groups.filter(([id]) => rows.some((r) => r.group === id)).map(([id, name]) => (
        <section key={id} className="rounded-lg border border-border bg-surface">
          <h2 className="border-b border-border px-4 py-3 text-sm font-semibold tracking-tight">{pick(name)}</h2>
          <dl className="divide-y divide-border">
            {rows.filter((r) => r.group === id).map((r) => {
              const ch = chapters.find((c) => c.id === r.chapter);
              return (
                <div key={r.term[1]} className="grid gap-x-6 gap-y-1.5 px-4 py-3.5 md:grid-cols-[14rem_minmax(0,1fr)]">
                  <dt className="text-sm font-medium">{pick(r.term)}</dt>
                  <dd className="min-w-0 text-sm leading-relaxed text-foreground/85">
                    {pick(r.def)}
                    {r.quiver && (
                      <span className="mt-1.5 block text-muted">
                        <span className="me-1.5 text-xs font-medium text-accent">{pick(['Di Quiver', 'In Quiver'])}</span>{pick(r.quiver)}
                      </span>
                    )}
                    {ch && (
                      <button type="button" onClick={() => onChapter(ch.id)}
                        className="mt-1.5 flex w-fit items-center gap-1 text-start text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
                        <BookOpen className="size-3" />{pick(['Bab', 'Chapter'])} {chapters.indexOf(ch) + 1}: {pick(ch.title)}
                      </button>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}

export default function Learn({ param }) {
  const { locale } = useI18n();
  const pick = (pair) => pair[locale === 'en' ? 1 : 0];
  const [route, setRoute] = useState(() => initialRoute(param));
  const [done, setDone] = useState(() => {
    const saved = read(DONE_KEY, []);
    return Array.isArray(saved) ? saved.filter((id) => chapters.some((c) => c.id === id)) : [];
  });
  const [lab, setLab] = useState(LAB_DEFAULT);
  const index = Math.max(0, chapters.findIndex((c) => c.id === route.chapter));

  // replaceState tidak memicu hashchange, jadi halaman tidak dipasang ulang dan
  // parameter simulator tetap ada saat berpindah tampilan.
  useEffect(() => {
    const hash = `#learn/${route.view === 'book' ? route.chapter : route.view}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    if (route.view === 'book') write(LAST_KEY, route.chapter);
  }, [route]);

  const top = () => {
    const el = document.getElementById('learn-top');
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
  };
  const markDone = (id, on) => setDone((cur) => {
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    write(DONE_KEY, next);
    return next;
  });
  const goChapter = (id) => {
    setRoute({ view: 'book', chapter: id });
    top();
  };
  const openLab = (preset) => {
    if (preset) setLab((v) => ({ ...v, lo: preset.lo, hi: preset.hi, price: preset.price }));
    setRoute((r) => ({ ...r, view: 'lab' }));
    top();
  };
  const resume = chapters.find((c) => !done.includes(c.id));

  const views = useMemo(() => [
    ['book', pick(['Materi', 'Chapters'])],
    ['lab', pick(['Simulator', 'Lab'])],
    ['glossary', pick(['Glosarium', 'Glossary'])],
  ], [locale]);

  return (
    <div id="learn-top" className="scroll-mt-5">
      <PageHeader title={pick(['Belajar LP', 'Learn LP'])}
        desc={pick([
          'Kurikulum singkat concentrated liquidity: inventori, fee, PnL, dan risiko, dikaitkan langsung dengan angka di dasbor Quiver.',
          'A concise concentrated-liquidity course covering inventory, fees, PnL, and risk, tied directly to the numbers in Quiver.',
        ])}>
        <Segmented value={route.view} options={views} aria={pick(['Tampilan', 'View'])}
          onChange={(view) => { setRoute((r) => ({ ...r, view })); }} />
      </PageHeader>

      {route.view === 'book' && (
        <div className="grid items-start gap-5 lg:grid-cols-[16.5rem_minmax(0,1fr)] xl:gap-6">
          <aside className="min-w-0 lg:sticky lg:top-4">
            <div className="rounded-lg border border-border bg-surface">
              <div className="border-b border-border p-4">
                <Progress pick={pick} done={done} />
                {resume && resume.id !== route.chapter && (
                  <button type="button" onClick={() => goChapter(resume.id)}
                    className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent underline-offset-2 hover:underline">
                    {pick(['Lanjutkan', 'Continue'])}: {pick(resume.title)}<ArrowRight className="size-3" />
                  </button>
                )}
              </div>
              {/* HP: daftar bab panjang didorong ke pemilih; desktop: daftar lengkap menempel. */}
              <div className="p-3 lg:hidden">
                <label className="sr-only" htmlFor="learn-chapter">{pick(['Pilih bab', 'Choose chapter'])}</label>
                <select id="learn-chapter" value={route.chapter} onChange={(e) => goChapter(e.target.value)}
                  className="h-9 w-full rounded-md border border-[var(--field-border)] bg-surface px-2.5 text-sm">
                  {chapters.map((c, i) => (
                    <option key={c.id} value={c.id}>{i + 1}. {pick(c.title)}{done.includes(c.id) ? ' ✓' : ''}</option>
                  ))}
                </select>
              </div>
              <div className="hidden p-2 lg:block">
                <ChapterNav pick={pick} active={index} done={done} onPick={goChapter} />
              </div>
              <div className="hidden border-t border-border p-4 text-xs lg:block">
                <div className="mb-2 font-medium">{pick(['Terapkan di Quiver', 'Apply in Quiver'])}</div>
                <div className="flex flex-col gap-1.5 text-muted">
                  <a className="hover:text-foreground" href="#positions">{pick(['Baca posisi yang terbuka', 'Read open positions'])} →</a>
                  <a className="hover:text-foreground" href="#manual-lp">{pick(['Tinjau parameter LP manual', 'Review manual LP parameters'])} →</a>
                  <a className="hover:text-foreground" href="#rules">{pick(['Periksa aturan copy', 'Review copy rules'])} →</a>
                </div>
              </div>
            </div>
          </aside>
          <Chapter pick={pick} locale={locale} index={index} done={done}
            onDone={markDone} onGo={goChapter} onLab={openLab} />
        </div>
      )}

      {route.view === 'lab' && <Lab pick={pick} value={lab} onChange={setLab} />}
      {route.view === 'glossary' && <Glossary pick={pick} onChapter={goChapter} />}

      <footer className="mt-8 border-t border-border pt-4 text-xs leading-relaxed text-muted">
        <p className="max-w-4xl">
          {pick([
            'Materi edukasi, bukan saran investasi, prediksi, atau jaminan hasil. Konsep protokol merujuk dokumentasi resmi Uniswap; penjelasan indikator mengikuti implementasi Quiver saat ini.',
            'Educational material, not investment advice, predictions, or guaranteed returns. Protocol concepts follow official Uniswap documentation; indicator explanations reflect Quiver’s current implementation.',
          ])}{' '}
          {pick(['Ditinjau', 'Reviewed'])} {pick(REVIEWED)}.
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {sources.map((s) => (
            <a key={s.href} href={s.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
              Uniswap · {s.label}<ExternalLink className="size-3" />
            </a>
          ))}
        </div>
      </footer>
    </div>
  );
}
