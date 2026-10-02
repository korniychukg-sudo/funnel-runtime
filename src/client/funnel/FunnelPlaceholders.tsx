export function StepSkeleton() {
  return (
    <div className="funnel-card skeleton" role="status" aria-label="Loading">
      <div className="skeleton-line is-short" />
      <div className="skeleton-line is-title" />
      <div className="skeleton-line" />
      <div className="skeleton-line is-option" />
      <div className="skeleton-line is-option" />
      <div className="skeleton-line is-option" />
    </div>
  );
}

export function StartError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="funnel-card" role="alert">
      <h1 className="step-title">We could not start the questionnaire</h1>
      <p className="step-lead">Check your connection and try again.</p>
      <div className="step-actions">
        <button type="button" className="btn btn-large" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
