import { dismissToast, toast } from '../lib/toast';

/** Bottom-centred, above the composer when there is one (`withComposer`). */
export default function ToastHost({ withComposer }: { withComposer: boolean }) {
  const item = toast.value;
  return (
    <div class="toast-region" role="status" aria-live="polite">
      {item ? (
        <div class={`toast${withComposer ? '' : ' bare'}`} key={item.id}>
          <span>{item.text}</span>
          {item.actionLabel ? (
            <button
              type="button"
              onClick={() => {
                const run = item.onAction;
                dismissToast(item.id);
                run?.();
              }}
            >
              {item.actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
