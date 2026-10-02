import { useEffect, useState } from 'react';
import type { AnalyticsQuery, AnalyticsResponse } from '../../shared/api';
import {
  analyticsSearchParams,
  asRequestError,
  fetchAnalytics,
  isUnauthorized,
  parseAnalyticsSearch,
  type RequestError,
} from '../adminApi';
import { DashboardFilters } from './DashboardFilters';
import { DashboardReport } from './DashboardReport';
import { ErrorNotice } from './ErrorNotice';
import { InternalNav } from './InternalNav';
import { TokenForm } from './TokenForm';
import './internal.css';
import './dashboard.css';

function syncUrl(query: AnalyticsQuery) {
  const search = analyticsSearchParams(query).toString();
  window.history.replaceState(null, '', search ? `${window.location.pathname}?${search}` : window.location.pathname);
}

export default function DashboardPage() {
  const [query, setQuery] = useState<AnalyticsQuery>(() => parseAnalyticsSearch(window.location.search));
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<RequestError | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsToken, setNeedsToken] = useState(false);

  useEffect(() => {
    syncUrl(query);
    let ignore = false;
    setLoading(true);
    fetchAnalytics(query).then(
      (response) => {
        if (ignore) return;
        setData(response);
        setError(null);
        setLoading(false);
      },
      (failure: unknown) => {
        if (ignore) return;
        const requestError = asRequestError(failure);
        if (isUnauthorized(requestError)) setNeedsToken(true);
        else setError(requestError);
        setLoading(false);
      },
    );
    return () => {
      ignore = true;
    };
  }, [query, reloadKey]);

  const reload = () => setReloadKey((key) => key + 1);

  function tokenSaved() {
    setNeedsToken(false);
    reload();
  }

  return (
    <div className="internal-shell">
      <InternalNav active="/dashboard" />
      <header className="page-header">
        <h1>Funnel analytics</h1>
        <p>Counted in unique sessions, so duplicates, repeated views, Back and late events cannot inflate the numbers.</p>
      </header>

      {needsToken ? (
        <TokenForm onSaved={tokenSaved} />
      ) : (
        <>
          <DashboardFilters
            query={query}
            campaigns={data?.available.campaigns ?? []}
            versions={data?.available.versions ?? []}
            generatedAt={data?.generatedAt ?? null}
            loading={loading}
            onChange={setQuery}
            onRefresh={reload}
          />
          {error && <ErrorNotice error={error} onRetry={reload} />}
          {data ? (
            <div className={loading ? 'report is-loading' : 'report'} aria-busy={loading}>
              <DashboardReport data={data} onResetFilters={() => setQuery({})} />
            </div>
          ) : (
            !error && <p className="muted">Loading analytics…</p>
          )}
        </>
      )}
    </div>
  );
}
