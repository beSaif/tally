import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';

/** The trailing "+ Add" pill of a chips row; becomes an inline input, Enter adds (spec §3.2). */
export default function AddChip({ onAdd, disabled }: { onAdd: (name: string) => boolean | void | Promise<boolean | void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button type="button" class="pill" onClick={() => setOpen(true)} disabled={disabled}>
        {t('common.add')}
      </button>
    );
  }

  const commit = async (keepOpen: boolean) => {
    const name = value.trim().slice(0, 40);
    if (!name) {
      setOpen(false);
      return;
    }
    const ok = await onAdd(name);
    if (ok === false) return;
    setValue('');
    if (keepOpen) ref.current?.focus();
    else setOpen(false);
  };

  return (
    <input
      ref={ref}
      type="text"
      class="chip-input"
      value={value}
      maxLength={40}
      placeholder={t('setup.newCategory')}
      aria-label={t('setup.newCategory')}
      enterkeyhint="done"
      onInput={(e) => setValue(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit(true);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          setValue('');
          setOpen(false);
        }
      }}
      onBlur={() => void commit(false)}
    />
  );
}
