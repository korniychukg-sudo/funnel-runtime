import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsSearchParams,
  configIssues,
  fetchAnalytics,
  fetchOverview,
  importConfig,
  parseAnalyticsSearch,
  publishVersion,
  readAdminToken,
  RequestError,
  saveAdminToken,
} from '../src/client/adminApi';
import AdminPage from '../src/client/pages/AdminPage';
import DashboardPage from '../src/client/pages/DashboardPage';
import { ActivationLog } from '../src/client/pages/ActivationLog';
import { ActiveVersionCard } from '../src/client/pages/ActiveVersionCard';
import { DashboardFilters } from '../src/client/pages/DashboardFilters';
import { DashboardReport } from '../src/client/pages/DashboardReport';
import { DataQualityPanel } from '../src/client/pages/DataQualityPanel';
import { ErrorNotice } from '../src/client/pages/ErrorNotice';
import { ExperimentCard } from '../src/client/pages/ExperimentCard';
import { describeExperiment } from '../src/client/pages/experimentSummary';
import {
  formatCount,
  formatLift,
  formatPoints,
  formatPValue,
  formatRate,
  plural,
} from '../src/client/pages/format';
import { FunnelTable } from '../src/client/pages/FunnelTable';
import { ImportPanel } from '../src/client/pages/ImportPanel';
import { InternalNav } from '../src/client/pages/InternalNav';
import { VersionsTable } from '../src/client/pages/VersionsTable';
import type { ExperimentComparison } from '../src/shared/api';
import { analytics, overview } from './fixtures/pages';

const noop = () => undefined;

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
}

type Call = { url: string; init: RequestInit };

function mockFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
    location: { pathname: '/dashboard', search: '' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adminApi', () => {
  it('sends no token header until one is saved, then sends it', async () => {
    const calls = mockFetch(() => json(200, overview));
    await fetchOverview();
    expect((calls[0].init.headers as Record<string, string>)['x-admin-token']).toBeUndefined();
    saveAdminToken('secret');
    expect(readAdminToken()).toBe('secret');
    await fetchOverview();
    expect((calls[1].init.headers as Record<string, string>)['x-admin-token']).toBe('secret');
  });

  it('posts actions without a body or content-type, and uploads with JSON', async () => {
    const calls = mockFetch(() => json(200, overview));
    await publishVersion(3);
    expect(calls[0].url).toBe('/api/admin/versions/3/publish');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBeUndefined();

    await importConfig({ version: 9 });
    expect(calls[1].url).toBe('/api/admin/versions');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ config: { version: 9 } });
    expect((calls[1].init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('turns ApiError bodies into RequestError with status, code and details', async () => {
    const issues = [{ path: 'steps.intro.id', message: 'Step key mismatch.' }];
    mockFetch(() => json(422, { error: 'invalid_config', message: 'The config is not valid.', details: issues }));
    const error = await importConfig({}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).status).toBe(422);
    expect((error as RequestError).code).toBe('invalid_config');
    expect((error as RequestError).message).toBe('The config is not valid.');
    expect(configIssues((error as RequestError).details)).toEqual(issues);
  });

  it('reports network failures, 401s and non-JSON answers', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const network = (await fetchOverview().catch((e: unknown) => e)) as RequestError;
    expect(network.status).toBe(0);
    expect(network.message).toMatch(/Could not reach the server/);

    mockFetch(() => json(401, { error: 'unauthorized', message: 'A valid x-admin-token header is required.' }));
    expect(((await fetchOverview().catch((e: unknown) => e)) as RequestError).status).toBe(401);

    mockFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const gateway = (await fetchOverview().catch((e: unknown) => e)) as RequestError;
    expect(gateway.status).toBe(502);
    expect(gateway.message).toBe('The server answered with status 502.');

    mockFetch(() => new Response('<html></html>', { status: 200 }));
    expect(((await fetchOverview().catch((e: unknown) => e)) as RequestError).code).toBe('invalid_response');
  });

  it('builds the analytics query string and round-trips it through the page URL', async () => {
    const query = { utmCampaign: 'spring launch', version: 3, runId: 'run-42', includeOverrides: true };
    const search = analyticsSearchParams(query).toString();
    expect(search).toBe('utm_campaign=spring+launch&version=3&run_id=run-42&include_overrides=1');
    expect(parseAnalyticsSearch(`?${search}`)).toEqual(query);
    expect(parseAnalyticsSearch('?version=abc&include_overrides=0&utm_campaign=')).toEqual({});
    expect(analyticsSearchParams({ utmCampaign: '(none)' }).toString()).toBe('utm_campaign=%28none%29');
    expect(parseAnalyticsSearch('?utm_campaign=%28none%29')).toEqual({ utmCampaign: '(none)' });

    const calls = mockFetch(() => json(200, analytics));
    await fetchAnalytics({});
    await fetchAnalytics(query);
    expect(calls.map((call) => call.url)).toEqual(['/api/analytics', `/api/analytics?${search}`]);
  });

  it('ignores details that are not config issues', () => {
    expect(configIssues({ missing: ['a'] })).toEqual([]);
    expect(configIssues([{ path: 'a', message: 'b' }, { nope: true }])).toEqual([{ path: 'a', message: 'b' }]);
  });
});

describe('format', () => {
  it('formats counts, rates, diffs, lifts and p-values', () => {
    expect(formatCount(12345)).toBe('12,345');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0.1234)).toBe('12.3%');
    expect(formatRate(0)).toBe('0.0%');
    expect(formatPoints(0.031)).toBe('+3.1 pp');
    expect(formatPoints(-0.0204)).toBe('−2.0 pp');
    expect(formatPoints(0.00001)).toBe('0.0 pp');
    expect(formatPoints(null)).toBe('—');
    expect(formatLift(0.2222)).toBe('+22.2%');
    expect(formatLift(-0.5)).toBe('−50.0%');
    expect(formatPValue(0.0004)).toBe('< 0.001');
    expect(formatPValue(0.21449)).toBe('0.214');
    expect(formatPValue(null)).toBe('—');
    expect(plural(1, 'session')).toBe('1 session');
    expect(plural(1200, 'session')).toBe('1,200 sessions');
  });
});

describe('describeExperiment', () => {
  const base = analytics.experiments[0];

  it('explains a non-significant positive difference in plain language', () => {
    expect(describeExperiment(base)).toBe(
      'B converts 3.3 pp better than A (15.0% vs 18.3% started → CTA), but the difference is not significant yet (p = 0.112).',
    );
  });

  it('explains significant, negative, equal and missing cases', () => {
    const significant: ExperimentComparison = { ...base, absoluteDiff: -0.05, pValue: 0.0002, significant: true };
    expect(describeExperiment(significant)).toMatch(/^B converts 5\.0 pp worse than A .*significant at 95% \(p < 0\.001\)\.$/);
    expect(describeExperiment({ ...base, absoluteDiff: 0, pValue: 1, significant: false })).toMatch(
      /^A and B convert equally so far/,
    );
    expect(describeExperiment({ ...base, pValue: null, significant: null })).toBe(
      'B converts 3.3 pp better than A (15.0% vs 18.3% started → CTA); there is not enough data yet for a significance test.',
    );
    expect(describeExperiment({ ...base, absoluteDiff: null })).toMatch(/Both variants need started sessions/);
    expect(describeExperiment(analytics.experiments[1])).toMatch(/Only one variant has sessions/);
  });
});

describe('dashboard rendering', () => {
  it('renders every section of a full report', () => {
    const html = renderToStaticMarkup(<DashboardReport data={analytics} onResetFilters={noop} />);
    const body = text(html);
    expect(body).toContain('Started 1,500 unique sessions');
    expect(body).toContain('Reached result 600 40.0% of started');
    expect(body).toContain('CTA CTR 40.0% 240 clicks of 600 results');
    expect(body).toContain('Started → CTA 16.0% 240 of 1,500');
    expect(body).toContain('not significant');
    expect(body).toContain('B − A +3.3 pp');
    expect(body).toContain('Relative lift +22.2%');
    expect(body).toContain('p-value 0.112');
    expect(body).toContain('12 forced-variant sessions excluded as QA traffic');
    expect(body).toContain('not enough data yet');
    expect(body).toContain('conditional');
    expect(body).toContain('Result → CTA');
    expect(body).toContain('v1 · variant A');
    expect(html.indexOf('v3 · A/B')).toBeLessThan(html.indexOf('v1 · A/B'));
    expect(html).toContain('data-variant="A"');
    expect(html).toContain('data-variant="B"');
    expect(html).toContain('style="width:40%"');
    expect(body).toContain('async_native 180 75.0%');
    expect(body).toContain('balanced 60 25.0%');
    expect(body).toContain('Duplicates dropped 321');
    expect(body).toContain('in 1 session.');
    expect(body).toContain('Events by name, in this view');
    expect(body).toContain('cta_clicked 251 240');
    expect(body).toContain('recommendation_expanded 41 38');
    expect(body).toContain('step_viewed 10,553 1,500');
    expect(body).toContain('at least 5 expected CTA clicks and 5 expected non-clicks in each variant');
    expect(body).toContain('"(no campaign)" selects sessions that arrived without a utm_campaign');
    expect(body).toContain('How these numbers are calculated');
    expect(html).toContain('<details');
  });

  it('says not enough data yet when the sample is too small for the z-test', () => {
    const small: ExperimentComparison = { ...analytics.experiments[0], pValue: null, significant: null };
    const body = text(renderToStaticMarkup(<ExperimentCard experiment={small} includeOverrides={false} />));
    expect(body).toContain('not enough data yet');
    expect(body).toContain('B − A +3.3 pp');
    expect(body).toContain('p-value —');
    expect(body).toContain('not enough data yet for a significance test');
    expect(body).not.toContain('not significant');
  });

  it('shows a note instead of the events table when no events are stored', () => {
    const quality = { ...analytics.dataQuality, eventsStored: 0, events: [] };
    const html = renderToStaticMarkup(<DataQualityPanel quality={quality} />);
    expect(html).not.toContain('<table');
    expect(text(html)).toContain('No events stored for this view.');
  });

  it('collapses a funnel with no sessions into one line', () => {
    const funnel = { ...analytics.funnels[0], started: 0, reachedResult: 0, ctaClicked: 0 };
    const html = renderToStaticMarkup(<FunnelTable funnel={funnel} />);
    expect(text(html)).toContain('No sessions on this version and variant');
    expect(html).not.toContain('<table');
  });

  it('shows the generator hint when there is no data at all', () => {
    const empty = { ...analytics, available: { campaigns: [], versions: [] }, totals: { ...analytics.totals, started: 0 } };
    const body = text(renderToStaticMarkup(<DashboardReport data={empty} onResetFilters={noop} />));
    expect(body).toContain('No data yet');
    expect(body).toContain('npm run generate');
  });

  it('offers a filter reset when filters match nothing', () => {
    const filtered = { ...analytics, totals: { ...analytics.totals, started: 0 } };
    const body = text(renderToStaticMarkup(<DashboardReport data={filtered} onResetFilters={noop} />));
    expect(body).toContain('No sessions match these filters');
    expect(body).toContain('Reset filters');
  });

  it('keeps a URL-provided filter value selectable before options load', () => {
    const html = renderToStaticMarkup(
      <DashboardFilters
        query={{ version: 7, utmCampaign: 'from-url', runId: 'r1', includeOverrides: true }}
        campaigns={[]}
        versions={[]}
        generatedAt={null}
        loading={false}
        onChange={noop}
        onRefresh={noop}
      />,
    );
    expect(html).toContain('<option value="7" selected="">v7</option>');
    expect(html).toContain('<option value="from-url" selected="">from-url</option>');
    expect(html).toContain('value="r1"');
    expect(html).toContain('checked=""');
    expect(text(html)).toContain('Reset filters');
  });

  it('labels the no-campaign option and keeps it selectable from the URL', () => {
    const listed = renderToStaticMarkup(
      <DashboardFilters
        query={{}}
        campaigns={analytics.available.campaigns}
        versions={[]}
        generatedAt={null}
        loading={false}
        onChange={noop}
        onRefresh={noop}
      />,
    );
    expect(listed).toContain('<option value="(none)">(no campaign)</option>');
    expect(listed.indexOf('spring_launch')).toBeLessThan(listed.indexOf('(no campaign)'));

    const fromUrl = renderToStaticMarkup(
      <DashboardFilters
        query={{ utmCampaign: '(none)' }}
        campaigns={[]}
        versions={[]}
        generatedAt={null}
        loading={false}
        onChange={noop}
        onRefresh={noop}
      />,
    );
    expect(fromUrl).toContain('<option value="(none)" selected="">(no campaign)</option>');
  });

  it('renders the dashboard page shell with the active nav link', () => {
    const html = renderToStaticMarkup(<DashboardPage />);
    expect(html).toContain('class="internal-shell"');
    expect(html).toContain('<a href="/dashboard" class="active" aria-current="page">Dashboard</a>');
    expect(text(html)).toContain('Loading analytics');
  });
});

describe('admin rendering', () => {
  it('renders the admin page shell', () => {
    const html = renderToStaticMarkup(<AdminPage />);
    expect(html).toContain('<a href="/admin" class="active" aria-current="page">Admin</a>');
    expect(text(html)).toContain('Loading versions');
  });

  it('shows the active version with rollback target and since-time', () => {
    const body = text(renderToStaticMarkup(<ActiveVersionCard overview={overview} busy={false} onRollback={noop} />));
    expect(body).toContain('v3');
    expect(body).toContain('question-order-and-result-framing-v3');
    expect(body).toContain('Roll back to v1');
    expect(body).toContain('· publish');
    expect(body).toContain('40 sessions · 320 events');
  });

  it('disables rollback when there is no target', () => {
    const html = renderToStaticMarkup(
      <ActiveVersionCard overview={{ ...overview, rollbackTarget: null }} busy={false} onRollback={noop} />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Roll back<\/button>/);
    expect(text(html)).toContain('no earlier version');
  });

  it('lists versions newest first with the right actions per status', () => {
    const html = renderToStaticMarkup(
      <VersionsTable versions={overview.versions} busy={false} onPublish={noop} onActivate={noop} onUnauthorized={noop} />,
    );
    const body = text(html);
    expect(html.indexOf('v4')).toBeLessThan(html.indexOf('v3'));
    expect(html.indexOf('v3')).toBeLessThan(html.indexOf('v1'));
    expect((html.match(/>Publish</g) ?? []).length).toBe(1);
    expect((html.match(/>Activate</g) ?? []).length).toBe(1);
    expect((html.match(/>View JSON</g) ?? []).length).toBe(3);
    expect(body).toContain('draft');
    expect(body).toContain('Active');
    expect(body).toContain('1,520');
    expect(body).toContain('13,045');
  });

  it('shows the activation log newest first', () => {
    const html = renderToStaticMarkup(<ActivationLog activations={overview.activations} />);
    expect(html.indexOf('publish')).toBeLessThan(html.indexOf('seed'));
    expect(text(html)).toContain('—');
  });

  it('offers one import button per fixture, a file picker and a paste box', () => {
    const html = renderToStaticMarkup(
      <ImportPanel fixtures={overview.fixtures} onImported={noop} onUnauthorized={noop} />,
    );
    const body = text(html);
    expect(body).toContain('Import funnel-v1.json as draft');
    expect(body).toContain('Import funnel-v3.json as draft');
    expect(html).toContain('type="file"');
    expect(html).toContain('<textarea');
  });

  it('lists config issues with their paths', () => {
    const body = text(
      renderToStaticMarkup(
        <ErrorNotice
          error={{ message: 'The config is not valid.', details: [{ path: 'defaultResultId', message: 'Unknown result "x".' }] }}
        />,
      ),
    );
    expect(body).toContain('The config is not valid.');
    expect(body).toContain('defaultResultId Unknown result "x".');
  });

  it('marks the active nav link only', () => {
    const html = renderToStaticMarkup(<InternalNav active="/admin" />);
    expect((html.match(/class="active"/g) ?? []).length).toBe(1);
    expect(html).toContain('Funnel Runtime');
  });
});
