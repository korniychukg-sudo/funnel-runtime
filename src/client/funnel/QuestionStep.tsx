import { useId, useState, type FormEvent, type Ref } from 'react';
import type { AnswerValue } from '../../shared/conditions';
import type { InteractiveStep } from '../../shared/config';
import { validateAnswer } from '../../shared/engine';
import { MultiSelectField } from './MultiSelectField';
import { NumberField } from './NumberField';
import type { DraftAnswer } from './progress';
import { SingleSelectField } from './SingleSelectField';

export type FieldProps = { labelledBy: string; describedBy: string | undefined; invalid: boolean };

type QuestionStepProps = {
  step: InteractiveStep;
  stored: AnswerValue | undefined;
  headingRef: Ref<HTMLHeadingElement>;
  busy: boolean;
  error: string | null;
  onSubmit: (value: AnswerValue | null) => void;
  onEdit: () => void;
  onDraftChange: (draft: DraftAnswer) => void;
};

export function QuestionStep({
  step,
  stored,
  headingRef,
  busy,
  error,
  onSubmit,
  onEdit,
  onDraftChange,
}: QuestionStepProps) {
  const [text, setText] = useState(() => (typeof stored === 'string' || typeof stored === 'number' ? String(stored) : ''));
  const [choices, setChoices] = useState<string[]>(() => (Array.isArray(stored) ? stored : []));
  const [localError, setLocalError] = useState<string | null>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const { title, helperText, primaryActionLabel } = step.content;
  const shownError = localError ?? error;
  const describedBy = [helperText ? helperId : null, shownError ? errorId : null].filter(Boolean).join(' ') || undefined;
  const field: FieldProps = { labelledBy: titleId, describedBy, invalid: shownError !== null };

  function edited(draft: DraftAnswer) {
    setLocalError(null);
    onEdit();
    onDraftChange(draft);
  }

  function changeText(value: string) {
    setText(value);
    edited(value);
  }

  function changeChoices(value: string[]) {
    setChoices(value);
    edited(value);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const check = validateAnswer(step, step.type === 'multi-select' ? choices : text);
    if (!check.ok) {
      setLocalError(check.message);
      return;
    }
    onSubmit(check.value ?? null);
  }

  return (
    <form className="step-body" onSubmit={handleSubmit} noValidate>
      <h1 id={titleId} ref={headingRef} tabIndex={-1} className="step-title">
        {title}
      </h1>
      {helperText && (
        <p id={helperId} className="step-helper">
          {helperText}
        </p>
      )}
      <fieldset className="answer-fields" disabled={busy}>
        {step.type === 'single-select' && <SingleSelectField step={step} value={text} onChange={changeText} {...field} />}
        {step.type === 'multi-select' && <MultiSelectField step={step} value={choices} onChange={changeChoices} {...field} />}
        {step.type === 'number' && <NumberField step={step} value={text} onChange={changeText} {...field} />}
      </fieldset>
      {shownError && (
        <p id={errorId} className="form-error" role="alert">
          {shownError}
        </p>
      )}
      <div className="step-actions">
        <button type="submit" className="btn btn-large" aria-disabled={busy}>
          {primaryActionLabel ?? 'Continue'}
        </button>
      </div>
    </form>
  );
}
