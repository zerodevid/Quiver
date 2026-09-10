import { Fragment } from 'react';
import { Separator } from '@heroui/react';
import { SCHEMA } from '../rulesSchema';
import { Text, Pick, Toggle } from './ui';

const dig = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
export function put(o, p, v) {
  const next = structuredClone(o);
  const ks = p.split('.'); const last = ks.pop();
  let c = next; for (const k of ks) c = (c[k] = c[k] || {});
  c[last] = v;
  return next;
}

// Form aturan berbasis skema. Field yang tidak berlaku untuk mode terpilih
// disembunyikan; nilainya tetap tersimpan sehingga ganti mode bolak-balik aman.
export default function RulesForm({ value, onChange }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-8">
      {SCHEMA.map((g, gi) => {
        const visible = g.fields.filter((f) => !f.when || f.when(value));
        if (!visible.length) return null;
        return (
          <Fragment key={g.group}>
            {gi > 0 && <Separator />}
            <section>
              <h3 className="mb-4 text-sm font-semibold">{g.group}</h3>
              <div className="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
                {visible.map((f) => {
                  const v = dig(value, f.path);
                  const set = (nv) => onChange(put(value, f.path, nv));
                  if (f.type === 'select') return <Pick key={f.path} label={f.label} hint={f.help} value={v} onChange={set} options={f.options} />;
                  if (f.type === 'bool') return <div key={f.path} className="flex items-start pt-1"><Toggle label={f.label} desc={f.help} value={v} onChange={set} /></div>;
                  if (f.type === 'list') return <Text key={f.path} label={f.label} hint={f.help} mono value={(v || []).join(', ')}
                    onChange={(t) => set(t.split(',').map((x) => x.trim()).filter(Boolean))} />;
                  return <Text key={f.path} label={f.label} hint={f.help} type="number" value={String(v ?? 0)} onChange={(t) => set(t === '' ? 0 : Number(t))} />;
                })}
              </div>
            </section>
          </Fragment>
        );
      })}
    </div>
  );
}
