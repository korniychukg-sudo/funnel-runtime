import { useEffect, useRef, useState, type Ref } from 'react';
import type { FunnelResult, Step } from '../../shared/config';
import { readExpandedResult, saveExpandedResult, startOverHref } from './useFunnelSession';

type ResultStepProps = {
  step: Extract<Step, { type: 'result' }>;
  sessionId: string;
  result: FunnelResult | null;
  failed: boolean;
  error: string | null;
  headingRef: Ref<HTMLHeadingElement>;
  onRetry: () => void;
  onCta: (expanding: boolean) => void;
};

function ResultSkeleton() {
  return (
    <div className="skeleton result-skeleton" aria-hidden="true">
      <div className="skeleton-line" />
      <div className="skeleton-line" />
      <div className="skeleton-line is-short" />
    </div>
  );
}

export function ResultStep({ step, sessionId, result, failed, error, headingRef, onRetry, onCta }: ResultStepProps) {
  const [expandedResultId, setExpandedResultId] = useState(() => readExpandedResult(sessionId));
  const expanded = result !== null && expandedResultId === result.id;
  const focusActionList = useRef(false);
  const actionListRef = useRef<HTMLElement>(null);
  const { eyebrow, loadingTitle, errorTitle, retryLabel } = step.content;
  const pendingTitle = failed
    ? (errorTitle ?? 'We could not load your result')
    : (loadingTitle ?? 'Preparing your result…');

  useEffect(() => {
    if (!expanded || !focusActionList.current) return;
    focusActionList.current = false;
    actionListRef.current?.focus();
  }, [expanded]);

  function handleCta(chosen: FunnelResult) {
    const expands = chosen.cta.action === 'expand_recommendation';
    onCta(expands && !expanded);
    if (!expands) return;
    focusActionList.current = true;
    setExpandedResultId(chosen.id);
    saveExpandedResult(sessionId, chosen.id);
  }

  return (
    <div className="step-body result-step">
      {result && eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1 ref={headingRef} tabIndex={-1} className="step-title" aria-live="polite">
        {result ? result.title : pendingTitle}
      </h1>
      {!result && !failed && <ResultSkeleton />}
      {!result && failed && (
        <div className="step-actions">
          <button type="button" className="btn btn-large" onClick={onRetry}>
            {retryLabel ?? 'Try again'}
          </button>
        </div>
      )}
      {result && result.summary && <p className="step-lead">{result.summary}</p>}
      {result && expanded && (
        <section ref={actionListRef} tabIndex={-1} className="action-list" aria-label={result.cta.label}>
          <ol>
            {result.recommendations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </section>
      )}
      {result && !expanded && (
        <div className="step-actions">
          <button type="button" className="btn btn-large" onClick={() => handleCta(result)}>
            {result.cta.label}
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <a className="start-over" href={startOverHref()}>
        Start over
      </a>
    </div>
  );
}
