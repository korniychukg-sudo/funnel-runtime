export type QuestionProgress = { index: number; count: number };

type ProgressHeaderProps = {
  canGoBack: boolean;
  busy: boolean;
  progress: QuestionProgress | null;
  onBack: () => void;
};

export function ProgressHeader({ canGoBack, busy, progress, onBack }: ProgressHeaderProps) {
  if (!canGoBack && !progress) return null;
  return (
    <header className="step-header">
      <div className="step-header-row">
        {canGoBack && (
          <button type="button" className="back-button" onClick={onBack} aria-disabled={busy}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </button>
        )}
        {progress && (
          <span className="progress-label">
            Question {progress.index} of {progress.count}
          </span>
        )}
      </div>
      {progress && (
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={1}
          aria-valuemax={progress.count}
          aria-valuenow={progress.index}
        >
          <div className="progress-fill" style={{ width: `${(progress.index / progress.count) * 100}%` }} />
        </div>
      )}
    </header>
  );
}
