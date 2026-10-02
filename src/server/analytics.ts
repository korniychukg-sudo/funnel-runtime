import type { AnalyticsQuery, AnalyticsResponse } from '../shared/api';
import type { FunnelConfig } from '../shared/config';

export type AnalyticsSessionRow = {
  id: string;
  version: number;
  experimentId: string;
  variant: string;
  assignmentSource: 'hash' | 'override';
  utmCampaign: string | null;
  runId: string | null;
  createdAt: string;
};

export type AnalyticsEventRow = {
  seq: number;
  eventId: string;
  sessionId: string;
  name: string;
  stepId: string | null;
  version: number;
  variant: string;
  clientTs: string | null;
  serverTs: string;
  properties: Record<string, unknown>;
};

export type IngestTotals = { duplicates: number; rejected: number };

export type AnalyticsInput = {
  sessions: AnalyticsSessionRow[];
  events: AnalyticsEventRow[];
  configs: Map<number, FunnelConfig>;
  ingest: IngestTotals;
  query: AnalyticsQuery;
  now: Date;
};

export function computeAnalytics(input: AnalyticsInput): AnalyticsResponse {
  throw new Error('not implemented');
}
