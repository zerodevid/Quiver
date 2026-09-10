import { useEffect, useState } from 'react';
import { Button, toast } from '@heroui/react';
import { get, post } from '../api';
import { PageHeader, Panel, Loading } from '../components/ui';
import RulesForm from '../components/RulesForm';
import { useI18n } from '../i18n';

export default function Rules() {
  const { t } = useI18n();
  const [rules, setRules] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { get('/api/rules').then((d) => setRules(d.rules)); }, []);
  if (!rules) return <Loading />;
  const save = async () => {
    setSaving(true);
    const r = await post('/api/rules', { rules });
    setSaving(false);
    r.ok ? toast.success(t('Aturan tersimpan')) : toast.danger(r.error || t('Gagal menyimpan'));
  };
  return (
    <>
      <PageHeader group="Copy" title="Aturan default" desc="Berlaku untuk semua target yang tidak punya aturan sendiri.">
        <Button onPress={save} isPending={saving}>{t('Simpan aturan')}</Button>
      </PageHeader>
      <Panel><RulesForm value={rules} onChange={setRules} /></Panel>
    </>
  );
}
