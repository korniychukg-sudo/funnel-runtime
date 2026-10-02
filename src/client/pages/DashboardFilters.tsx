import type { FormEvent } from 'react';
import { NO_CAMPAIGN, type AnalyticsQuery } from '../../shared/api';
import { formatTime } from './format';

type Props = {
  query: AnalyticsQuery;
  campaigns: string[];
  versions: number[];
  generatedAt: string | null;
  loading: boolean;
  onChange: (query: AnalyticsQuery) => void;
  onRefresh: () => void;
};

function withCurrent<T>(options: T[], current: T | undefined): T[] {
  return current === undefined || options.includes(current) ? options : [...options, current];
}

function campaignLabel(campaign: string): string {
  return campaign === NO_CAMPAIGN ? '(no campaign)' : campaign;
}

function hasFilters(query: AnalyticsQuery): boolean {
  return Boolean(query.utmCampaign || query.version !== undefined || query.runId || query.includeOverrides);
}

export function DashboardFilters({ query, campaigns, versions, generatedAt, loading, onChange, onRefresh }: Props) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = String(new FormData(event.currentTarget).get('runId') ?? '').trim();
    const runId = typed || undefined;
    if (runId === query.runId) onRefresh();
    else onChange({ ...query, runId });
  }

  return (
    <form className="card panel filter-bar" onSubmit={submit} aria-label="Analytics filters">
      <label className="field">
        <span>UTM campaign</span>
        <select
          value={query.utmCampaign ?? ''}
          onChange={(event) => onChange({ ...query, utmCampaign: event.target.value || undefined })}
        >
          <option value="">All campaigns</option>
          {withCurrent(campaigns, query.utmCampaign).map((campaign) => (
            <option key={campaign} value={campaign}>
              {campaignLabel(campaign)}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Version</span>
        <select
          value={query.version === undefined ? '' : String(query.version)}
          onChange={(event) =>
            onChange({ ...query, version: event.target.value ? Number(event.target.value) : undefined })
          }
        >
          <option value="">All versions</option>
          {withCurrent(versions, query.version).map((version) => (
            <option key={version} value={version}>
              v{version}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Run id</span>
        <input
          key={query.runId ?? ''}
          name="runId"
          type="text"
          placeholder="any run, Enter to apply"
          defaultValue={query.runId ?? ''}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <label className="check-field">
        <input
          type="checkbox"
          checked={Boolean(query.includeOverrides)}
          onChange={(event) => onChange({ ...query, includeOverrides: event.target.checked || undefined })}
        />
        <span>Include forced-variant (override) sessions in A/B</span>
      </label>

      <div className="filter-actions">
        <button type="submit" className="btn btn-small" disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {hasFilters(query) && (
          <button type="button" className="btn btn-secondary btn-small" onClick={() => onChange({})}>
            Reset filters
          </button>
        )}
        <span className="muted updated-at">{generatedAt ? `Updated ${formatTime(generatedAt)}` : 'Not loaded yet'}</span>
      </div>
    </form>
  );
}
