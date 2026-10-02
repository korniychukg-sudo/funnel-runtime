import type { Ref } from 'react';
import type { Step } from '../../shared/config';

type InfoStepProps = {
  step: Extract<Step, { type: 'info' }>;
  headingRef: Ref<HTMLHeadingElement>;
  busy: boolean;
  error: string | null;
  onContinue: () => void;
};

export function InfoStep({ step, headingRef, busy, error, onContinue }: InfoStepProps) {
  const { eyebrow, title, body, primaryActionLabel } = step.content;
  return (
    <div className="step-body info-step">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1 ref={headingRef} tabIndex={-1} className="step-title">
        {title}
      </h1>
      {body && <p className="step-lead">{body}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="step-actions">
        <button type="button" className="btn btn-large" onClick={onContinue} aria-disabled={busy}>
          {primaryActionLabel ?? 'Continue'}
        </button>
      </div>
    </div>
  );
}
