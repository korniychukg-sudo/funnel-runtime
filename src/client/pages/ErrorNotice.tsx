import { configIssues, type ErrorMessage } from '../adminApi';

type Props = {
  error: ErrorMessage;
  onRetry?: () => void;
  onDismiss?: () => void;
};

export function ErrorNotice({ error, onRetry, onDismiss }: Props) {
  const issues = configIssues(error.details);
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-title">{error.message}</p>
      {issues.length > 0 && (
        <ul className="issue-list">
          {issues.map((issue, index) => (
            <li key={index}>
              <code>{issue.path || '(root)'}</code> {issue.message}
            </li>
          ))}
        </ul>
      )}
      {(onRetry || onDismiss) && (
        <div className="notice-actions">
          {onRetry && (
            <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>
              Try again
            </button>
          )}
          {onDismiss && (
            <button type="button" className="btn btn-secondary btn-small" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}
