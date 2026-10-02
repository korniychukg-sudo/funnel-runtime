import type { Rate } from '../../shared/api';
import { formatRate } from './format';

export function RateBar({ rate, variant }: { rate: Rate; variant: string }) {
  const percent = rate === null ? 0 : Math.min(100, Math.max(0, rate * 100));
  return (
    <div className="rate-bar">
      <div className="rate-track" aria-hidden="true">
        <div className="rate-fill" data-variant={variant} style={{ width: `${percent}%` }} />
      </div>
      <span className="rate-value">{formatRate(rate)}</span>
    </div>
  );
}
