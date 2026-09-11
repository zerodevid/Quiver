import { useCallback, useEffect, useState } from 'react';
import { Button, toast } from '@heroui/react';
import { get, post } from '../api';
import { PageHeader, Panel, Loading, Notice } from '../components/ui';
import RulesForm from '../components/RulesForm';
import { useI18n } from '../i18n';

export default function Rules() {
  const { t } = useI18n();
  const [rules, setRules] = useState(null);
  const [saved, setSaved] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);
  const load = useCallback(async () => {
    setError('');
    try {
      const d = await get('/api/rules');
      if (!d.rules || d.error) throw new Error(d.error || 'Gagal memuat aturan');
      setRules(d.rules); setSaved(d.rules);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true); setError('');
    try {
      const r = await post('/api/rules', { rules });
      if (!r.ok) throw new Error(r.error || t('Gagal menyimpan'));
      const next = r.rules || rules;
      setRules(next); setSaved(next); toast.success(t('Aturan tersimpan'));
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };
  return (
    <>
      <PageHeader group="Copy" title="Aturan default" desc="Berlaku untuk semua target yang tidak punya aturan sendiri." />
      {error && <div role="alert" className="mb-4"><Notice status="danger">{error}{!rules && <Button variant="ghost" onPress={load}>{t('Coba lagi')}</Button>}</Notice></div>}
      {!rules ? !error && <Loading /> : <>
        <Panel><RulesForm value={rules} onChange={setRules} isDisabled={saving} /></Panel>
        <div className="sticky bottom-3 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm">
          <div><div role="status" className="text-sm font-medium">{t(dirty ? 'Ada perubahan belum disimpan' : 'Semua perubahan tersimpan')}</div>
            <p className="mt-1 hidden text-xs text-muted sm:block">{t('Perubahan aturan tidak mengubah mode simulasi atau LIVE.')}</p></div>
          <div className="flex gap-2">
            {dirty && <Button variant="ghost" isDisabled={saving} onPress={() => { setRules(structuredClone(saved)); setError(''); }}>{t('Batal')}</Button>}
            <Button onPress={save} isPending={saving} isDisabled={!dirty || saving}>{t('Simpan aturan')}</Button>
          </div>
        </div>
      </>}
    </>
  );
}
