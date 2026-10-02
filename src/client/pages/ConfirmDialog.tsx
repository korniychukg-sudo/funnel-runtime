import { useEffect, useRef, type FormEvent } from 'react';
import type { ErrorMessage } from '../adminApi';
import { ErrorNotice } from './ErrorNotice';

export type ConfirmRequest = {
  title: string;
  points: string[];
  confirmLabel: string;
  tone: 'primary' | 'danger';
};

type Props = {
  request: ConfirmRequest | null;
  busy: boolean;
  error: ErrorMessage | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ request, busy, error, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (request && !dialog.open) dialog.showModal();
    if (!request && dialog.open) dialog.close();
  }, [request]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm();
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      {request && (
        <form onSubmit={submit}>
          <h2 id="confirm-dialog-title">{request.title}</h2>
          <ul className="confirm-points">
            {request.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          {error && <ErrorNotice error={error} />}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={request.tone === 'danger' ? 'btn btn-danger' : 'btn'} disabled={busy}>
              {busy ? 'Working…' : request.confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
