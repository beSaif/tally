/**
 * Edit / delete an existing entry (spec §3.7). Deleting shows a 5s "Entry deleted · UNDO" toast;
 * undo re-creates the entry with the same fields.
 */
import { useState } from 'preact/hooks';
import type { Entry, EntryPatch, NewEntry } from '@shared/api';
import { isValidMinute } from '@shared/dates';
import { parseAmount } from '@shared/money';
import { t, type TKey } from '../i18n';
import { api } from '../lib/api';
import { amountInputValue } from '../lib/format';
import { addEntries, removeEntry, replaceEntry } from '../lib/ledger';
import { showToast } from '../lib/toast';
import { EntryFields, type EntryDraft } from './EntryFields';
import { IconTrash } from './Icons';
import Sheet from './Sheet';

function draftOf(e: Entry): EntryDraft {
  return {
    amount: amountInputValue(e.amount_cents),
    description: e.description,
    categoryId: e.category_id,
    occurredAt: e.occurred_at,
    note: e.note ?? '',
    currency: e.currency,
  };
}

function diff(e: Entry, d: EntryDraft): EntryPatch {
  const patch: EntryPatch = {};
  const cents = parseAmount(d.amount);
  if (cents !== null && cents !== e.amount_cents) patch.amount_cents = cents;
  if (d.description.trim() !== e.description) patch.description = d.description.trim();
  if (d.categoryId !== e.category_id) patch.category_id = d.categoryId;
  if (d.occurredAt !== e.occurred_at) patch.occurred_at = d.occurredAt;
  const note = d.note.trim() || null;
  if (note !== (e.note ?? null)) patch.note = note;
  return patch;
}

function undoDelete(e: Entry): void {
  const again: NewEntry = {
    amount_cents: e.amount_cents,
    currency: e.currency,
    description: e.description,
    category_id: e.category_id,
    occurred_at: e.occurred_at,
    note: e.note,
    source: e.source,
  };
  api
    .createEntries([again])
    .then((res) => addEntries(res.entries, { fresh: true }))
    .catch(() => showToast({ text: t('entry.saveFailed') }));
}

export default function EntrySheet({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const [draft, setDraft] = useState<EntryDraft>(() => draftOf(entry));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TKey | null>(null);

  const save = async () => {
    const cents = parseAmount(draft.amount);
    if (cents === null) return setError('capture.invalidAmount');
    if (!draft.description.trim()) return setError('capture.invalidWhat');
    if (!isValidMinute(draft.occurredAt)) return setError('capture.invalidWhen');
    const patch = diff(entry, draft);
    if (Object.keys(patch).length === 0) return onClose();
    setBusy(true);
    setError(null);
    try {
      const res = await api.patchEntry(entry.id, patch);
      replaceEntry(res.entry);
      onClose();
    } catch {
      setBusy(false);
      setError('entry.saveFailed');
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteEntry(entry.id);
      removeEntry(entry.id);
      onClose();
      showToast({ text: t('entry.deleted'), actionLabel: t('entry.undo'), onAction: () => undoDelete(entry), duration: 5000 });
    } catch {
      setBusy(false);
      setError('entry.deleteFailed');
    }
  };

  return (
    <Sheet label={t('entry.title')} onClose={busy ? undefined : onClose} focusKey={confirming ? 'confirm' : 'edit'}>
      <div class="sheet-head">
        <span class="lbl">{t('entry.title')}</span>
        <button type="button" class="ibtn ghost sm" aria-label={t('entry.delete')} onClick={() => setConfirming(true)} disabled={busy || confirming}>
          <IconTrash />
        </button>
      </div>
      {confirming ? (
        <div class="confirm">
          <p class="confirm-q">{t('entry.confirmDelete')}</p>
          {error ? <p class="err line">{t(error)}</p> : null}
          <div class="btns even">
            <button type="button" class="btn" onClick={() => setConfirming(false)} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="button" class="btn danger-fill" onClick={() => void remove()} disabled={busy}>
              {busy ? '…' : t('common.delete')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div class="sheet-body">
            <EntryFields
              draft={draft}
              onChange={(p) => {
                setError(null);
                setDraft((d) => ({ ...d, ...p }));
              }}
            />
          </div>
          {error ? <p class="err line">{t(error)}</p> : null}
          <div class="btns">
            <button type="button" class="btn" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="button" class="btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? '…' : t('common.save')}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
