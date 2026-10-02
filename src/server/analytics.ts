import {
  NO_CAMPAIGN,
  type AnalyticsQuery,
  type AnalyticsResponse,
  type DataQuality,
  type EventCount,
  type ExperimentComparison,
  type FunnelBreakdown,
  type FunnelStepStats,
  type KpiStats,
  type Rate,
  type ResultMixRow,
  type VariantStats,
} from '../shared/api';
import type { FunnelConfig } from '../shared/config';
import { resolveFunnel } from '../shared/engine';

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

const STEP_EVENTS = new Set(['step_viewed', 'answer_submitted', 'step_completed', 'back_clicked']);
const RESULT_EVENTS = new Set(['result_viewed', 'cta_clicked', 'recommendation_expanded']);
const SIGNIFICANCE_LEVEL = 0.05;
const MIN_EXPECTED_COUNT = 5;

type Outcomes = { reachedResult: Set<string>; ctaClicked: Set<string> };

type VersionGroup = { config: FunnelConfig; sessions: AnalyticsSessionRow[] };

type EventsBySession = Map<string, AnalyticsEventRow[]>;

export function computeAnalytics(input: AnalyticsInput): AnalyticsResponse {
  const { query } = input;
  const includeOverrides = query.includeOverrides ?? false;
  const population = input.sessions.filter((session) => inPopulation(session, query));
  const populationIds = new Set(population.map((session) => session.id));
  const events = input.events.filter((event) => populationIds.has(event.sessionId));
  const eventsBySession = groupEventsBySession(events);
  const outcomes = sessionOutcomes(events);
  const groups = groupByVersion(population, input.configs);

  return {
    generatedAt: input.now.toISOString(),
    filters: {
      utmCampaign: query.utmCampaign ?? null,
      version: query.version ?? null,
      runId: query.runId ?? null,
      includeOverrides,
    },
    available: availableFilters(input.sessions),
    totals: kpiStats(population, outcomes),
    versions: groups.map(({ config, sessions }) => ({
      version: config.version,
      experimentId: config.experiment.id,
      ...kpiStats(sessions, outcomes),
    })),
    experiments: groups.map((group) => experimentComparison(group, outcomes, includeOverrides)),
    funnels: groups.flatMap(({ config, sessions }) =>
      variantKeys(config).map((variant) =>
        funnelBreakdown(config, variant, sessions.filter((session) => session.variant === variant), eventsBySession, outcomes),
      ),
    ),
    resultMix: resultMix(population, eventsBySession),
    dataQuality: dataQuality(events, eventsBySession, input.ingest),
  };
}

function inPopulation(session: AnalyticsSessionRow, query: AnalyticsQuery): boolean {
  if (query.version !== undefined && session.version !== query.version) return false;
  if (query.utmCampaign !== undefined && !matchesCampaign(session.utmCampaign, query.utmCampaign)) return false;
  if (query.runId !== undefined && session.runId !== query.runId) return false;
  return true;
}

function matchesCampaign(campaign: string | null, filter: string): boolean {
  return filter === NO_CAMPAIGN ? campaign === null : campaign === filter;
}

function groupEventsBySession(events: AnalyticsEventRow[]): EventsBySession {
  const grouped: EventsBySession = new Map();
  for (const event of events) {
    const list = grouped.get(event.sessionId);
    if (list) list.push(event);
    else grouped.set(event.sessionId, [event]);
  }
  return grouped;
}

function sessionOutcomes(events: AnalyticsEventRow[]): Outcomes {
  return {
    reachedResult: new Set(events.filter((event) => RESULT_EVENTS.has(event.name)).map((event) => event.sessionId)),
    ctaClicked: new Set(events.filter((event) => event.name === 'cta_clicked').map((event) => event.sessionId)),
  };
}

function groupByVersion(sessions: AnalyticsSessionRow[], configs: Map<number, FunnelConfig>): VersionGroup[] {
  const versions = [...new Set(sessions.map((session) => session.version))].sort((a, b) => a - b);
  return versions.map((version) => {
    const config = configs.get(version);
    if (!config) throw new Error(`No config is loaded for version ${version}.`);
    return { config, sessions: sessions.filter((session) => session.version === version) };
  });
}

function variantKeys(config: FunnelConfig): string[] {
  return Object.keys(config.experiment.variants).sort(compareText);
}

function availableFilters(sessions: AnalyticsSessionRow[]): AnalyticsResponse['available'] {
  const named = sessions.map((session) => session.utmCampaign).filter((campaign) => campaign !== null);
  const campaigns = [...new Set(named)].filter((campaign) => campaign !== NO_CAMPAIGN).sort(compareText);
  if (sessions.some((session) => session.utmCampaign === null)) campaigns.push(NO_CAMPAIGN);
  return {
    campaigns,
    versions: [...new Set(sessions.map((session) => session.version))].sort((a, b) => a - b),
  };
}

function rate(numerator: number, denominator: number): Rate {
  return denominator === 0 ? null : numerator / denominator;
}

function kpiStats(sessions: AnalyticsSessionRow[], outcomes: Outcomes): KpiStats {
  const started = sessions.length;
  const reachedResult = sessions.filter((session) => outcomes.reachedResult.has(session.id)).length;
  const ctaClicked = sessions.filter((session) => outcomes.ctaClicked.has(session.id)).length;
  return {
    started,
    reachedResult,
    resultRate: rate(reachedResult, started),
    ctaClicked,
    ctr: rate(ctaClicked, reachedResult),
    startedToCta: rate(ctaClicked, started),
  };
}

function experimentComparison(group: VersionGroup, outcomes: Outcomes, includeOverrides: boolean): ExperimentComparison {
  const { config } = group;
  const randomised = includeOverrides
    ? group.sessions
    : group.sessions.filter((session) => session.assignmentSource !== 'override');
  const variants: VariantStats[] = variantKeys(config).map((variant) => ({
    version: config.version,
    experimentId: config.experiment.id,
    variant,
    ...kpiStats(randomised.filter((session) => session.variant === variant), outcomes),
  }));
  return {
    version: config.version,
    experimentId: config.experiment.id,
    metric: 'startedToCta',
    variants,
    ...compareTwoVariants(variants),
    excludedOverrideSessions: group.sessions.length - randomised.length,
  };
}

type VariantComparison = Pick<ExperimentComparison, 'absoluteDiff' | 'relativeLift' | 'pValue' | 'significant'>;

function compareTwoVariants(variants: VariantStats[]): VariantComparison {
  const none: VariantComparison = { absoluteDiff: null, relativeLift: null, pValue: null, significant: null };
  if (variants.length !== 2) return none;
  const [a, b] = variants;
  if (a.startedToCta === null || b.startedToCta === null) return none;
  const absoluteDiff = b.startedToCta - a.startedToCta;
  const pValue = twoProportionPValue(a.ctaClicked, a.started, b.ctaClicked, b.started);
  return {
    absoluteDiff,
    relativeLift: a.startedToCta === 0 ? null : absoluteDiff / a.startedToCta,
    pValue,
    significant: pValue === null ? null : pValue < SIGNIFICANCE_LEVEL,
  };
}

function twoProportionPValue(successesA: number, totalA: number, successesB: number, totalB: number): number | null {
  const successes = successesA + successesB;
  const total = totalA + totalB;
  if (!hasMinimumSample(totalA, successes, total) || !hasMinimumSample(totalB, successes, total)) return null;
  const pooled = successes / total;
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  const z = (successesB / totalB - successesA / totalA) / standardError;
  return 2 * normalCdf(-Math.abs(z));
}

function hasMinimumSample(armTotal: number, pooledSuccesses: number, pooledTotal: number): boolean {
  const pooledFailures = pooledTotal - pooledSuccesses;
  return (
    armTotal * pooledSuccesses >= MIN_EXPECTED_COUNT * pooledTotal &&
    armTotal * pooledFailures >= MIN_EXPECTED_COUNT * pooledTotal
  );
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Abramowitz & Stegun 7.1.26, absolute error below 1.5e-7.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const polynomial =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - polynomial * Math.exp(-absX * absX));
}

function funnelBreakdown(
  config: FunnelConfig,
  variant: string,
  sessions: AnalyticsSessionRow[],
  eventsBySession: EventsBySession,
  outcomes: Outcomes,
): FunnelBreakdown {
  const funnel = resolveFunnel(config, variant);
  const resultIndex = funnel.sequence.length - 1;
  const rows = funnel.sequence.map((stepId) => ({
    stepId,
    type: funnel.steps[stepId].type,
    conditional: funnel.steps[stepId].visibleWhen !== undefined,
    reached: 0,
    progressed: 0,
    dropped: 0,
    views: 0,
  }));

  for (const session of sessions) {
    const events = eventsBySession.get(session.id) ?? [];
    const direct = directlyReachedIndexes(funnel.sequence, events);
    const furthest = Math.max(...direct);
    rows.forEach((row, index) => {
      const reached = direct.has(index) || (!row.conditional && index < furthest);
      if (!reached) return;
      row.reached += 1;
      const progressed = index === resultIndex ? outcomes.ctaClicked.has(session.id) : index < furthest;
      if (progressed) row.progressed += 1;
      else row.dropped += 1;
    });
    for (const event of events) {
      const index = event.name === 'step_viewed' && event.stepId !== null ? funnel.sequence.indexOf(event.stepId) : -1;
      if (index >= 0) rows[index].views += 1;
    }
  }

  const steps: FunnelStepStats[] = rows.map((row) => ({
    ...row,
    conversion: rate(row.progressed, row.reached),
    dropOffRate: rate(row.dropped, row.reached),
  }));
  return {
    version: config.version,
    experimentId: config.experiment.id,
    variant,
    started: sessions.length,
    steps,
    reachedResult: rows[resultIndex].reached,
    ctaClicked: rows[resultIndex].progressed,
  };
}

function directlyReachedIndexes(sequence: string[], events: AnalyticsEventRow[]): Set<number> {
  const resultIndex = sequence.length - 1;
  const reached = new Set<number>([0]);
  for (const event of events) {
    if (RESULT_EVENTS.has(event.name)) reached.add(resultIndex);
    const index = event.stepId === null ? -1 : sequence.indexOf(event.stepId);
    if (STEP_EVENTS.has(event.name) && index >= 0 && index < resultIndex) reached.add(index);
  }
  return reached;
}

function resultMix(sessions: AnalyticsSessionRow[], eventsBySession: EventsBySession): ResultMixRow[] {
  const rows = new Map<string, ResultMixRow>();
  for (const session of sessions) {
    const resultId = latestResultId(eventsBySession.get(session.id) ?? []);
    if (resultId === null) continue;
    const key = JSON.stringify([session.version, session.variant, resultId]);
    const row = rows.get(key) ?? { version: session.version, variant: session.variant, resultId, sessions: 0 };
    row.sessions += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.version - b.version ||
      compareText(a.variant, b.variant) ||
      b.sessions - a.sessions ||
      compareText(a.resultId, b.resultId),
  );
}

function latestResultId(events: AnalyticsEventRow[]): string | null {
  const views = events
    .filter((event) => event.name === 'result_viewed' && typeof event.properties.result_id === 'string')
    .sort(compareClientOrder);
  const latest = views.at(-1);
  return latest ? String(latest.properties.result_id) : null;
}

function clientTime(event: AnalyticsEventRow): number | null {
  return event.clientTs === null ? null : Date.parse(event.clientTs);
}

function compareClientOrder(a: AnalyticsEventRow, b: AnalyticsEventRow): number {
  const timeA = clientTime(a) ?? Number.NEGATIVE_INFINITY;
  const timeB = clientTime(b) ?? Number.NEGATIVE_INFINITY;
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  return a.seq - b.seq;
}

function dataQuality(events: AnalyticsEventRow[], eventsBySession: EventsBySession, ingest: IngestTotals): DataQuality {
  const stepViews = events.filter((event) => event.name === 'step_viewed');
  const distinctStepViews = new Set(stepViews.map((event) => JSON.stringify([event.sessionId, event.stepId])));
  let outOfOrderEvents = 0;
  let sessionsWithOutOfOrderEvents = 0;
  for (const sessionEvents of eventsBySession.values()) {
    const count = countOutOfOrder(sessionEvents);
    outOfOrderEvents += count;
    if (count > 0) sessionsWithOutOfOrderEvents += 1;
  }
  return {
    eventsStored: events.length,
    duplicatesDropped: ingest.duplicates,
    rejectedEvents: ingest.rejected,
    repeatedStepViews: stepViews.length - distinctStepViews.size,
    backClicks: events.filter((event) => event.name === 'back_clicked').length,
    outOfOrderEvents,
    sessionsWithOutOfOrderEvents,
    events: eventCounts(events),
  };
}

function eventCounts(events: AnalyticsEventRow[]): EventCount[] {
  const counts = new Map<string, { events: number; sessions: Set<string> }>();
  for (const event of events) {
    const count = counts.get(event.name) ?? { events: 0, sessions: new Set<string>() };
    count.events += 1;
    count.sessions.add(event.sessionId);
    counts.set(event.name, count);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, events: count.events, sessions: count.sessions.size }))
    .sort((a, b) => compareText(a.name, b.name));
}

function countOutOfOrder(events: AnalyticsEventRow[]): number {
  const byArrival = [...events].sort((a, b) => a.seq - b.seq);
  let latestSeen = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const event of byArrival) {
    const time = clientTime(event);
    if (time === null) continue;
    if (time < latestSeen) count += 1;
    latestSeen = Math.max(latestSeen, time);
  }
  return count;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
