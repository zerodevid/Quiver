import { Button, Popover } from '@heroui/react';
import { Info } from 'lucide-react';
import { useI18n } from '../i18n';

export default function SettingInfo({ title, children }) {
  const { t } = useI18n();
  return <Popover>
    <Button isIconOnly variant="ghost" className="size-11 shrink-0 text-muted" aria-label={t('Informasi tentang {name}', { name: t(title) })}>
      <Info className="size-4" aria-hidden="true" />
    </Button>
    <Popover.Content placement="bottom" className="w-80 max-w-[calc(100vw-2rem)]">
      <Popover.Dialog className="flex flex-col gap-2 p-4">
        <Popover.Heading className="font-semibold">{t(title)}</Popover.Heading>
        <div className="text-sm leading-relaxed text-muted">{typeof children === 'string' ? t(children) : children}</div>
      </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}

