import type { FastifyInstance } from 'fastify';
import type { AnalyticsQuery } from '../../shared/api';
import { computeAnalytics } from '../analytics';
import type { AppContext } from '../app';
import { ingestTotals, listAnalyticsEvents, listAnalyticsSessions, listVersions } from '../store';
import { HttpError } from './http';

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseAnalyticsQuery(query: Record<string, unknown>): AnalyticsQuery {
  const versionParam = stringParam(query.version);
  const version = versionParam === undefined ? undefined : Number(versionParam);
  if (version !== undefined && !(Number.isInteger(version) && version > 0)) {
    throw new HttpError(400, 'invalid_query', 'version must be a positive integer.');
  }
  const includeOverrides = stringParam(query.include_overrides);
  return {
    utmCampaign: stringParam(query.utm_campaign),
    version,
    runId: stringParam(query.run_id),
    includeOverrides: includeOverrides === '1' || includeOverrides === 'true',
  };
}

export function registerAnalyticsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/analytics', async (request) => {
    const query = parseAnalyticsQuery(request.query as Record<string, unknown>);
    return computeAnalytics({
      sessions: listAnalyticsSessions(ctx.db),
      events: listAnalyticsEvents(ctx.db),
      configs: new Map(listVersions(ctx.db).map((record) => [record.version, record.config])),
      ingest: ingestTotals(ctx.db),
      query,
      now: ctx.now(),
    });
  });
}
