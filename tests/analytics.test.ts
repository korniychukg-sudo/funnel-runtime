import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  computeAnalytics,
  type AnalyticsEventRow,
  type AnalyticsSessionRow,
  type IngestTotals,
} from '../src/server/analytics';
import type { AnalyticsQuery, AnalyticsResponse, FunnelBreakdown } from '../src/shared/api';
import { parseFunnelConfig, type FunnelConfig } from '../src/shared/config';

function loadConfig(path: string): FunnelConfig {
  const parsed = parseFunnelConfig(JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')));
  if (!parsed.ok) throw new Error(`${path} does not parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.config;
}

const v1 = loadConfig('../configs/funnel-v1.json');
const v3 = loadConfig('../configs/funnel-v3.json');
const configs = new Map([
  [1, v1],
  [3, v3],
]);

type Scripted = [name: string, stepId: string | null, properties?: Record<string, unknown>];

const BASE_TIME = Date.parse('2026-10-01T09:00:00.000Z');
let lastSeq = 0;

function at(second: number): string {
  return new Date(BASE_TIME + second * 1000).toISOString();
}

function session(id: string, fields: Partial<AnalyticsSessionRow> = {}): AnalyticsSessionRow {
  const version = fields.version ?? 1;
  return {
    id,
    version,
    experimentId: configs.get(version)?.experiment.id ?? 'unknown',
    variant: 'A',
    assignmentSource: 'hash',
    utmCampaign: null,
    runId: null,
    createdAt: at(0),
    ...fields,
  };
}

function eventRow(owner: AnalyticsSessionRow, [name, stepId, properties = {}]: Scripted, clientTs: string | null): AnalyticsEventRow {
  lastSeq += 1;
  return {
    seq: lastSeq,
    eventId: `${owner.id}-${lastSeq}`,
    sessionId: owner.id,
    name,
    stepId,
    version: owner.version,
    variant: owner.variant,
    clientTs,
    serverTs: at(3600 + lastSeq),
    properties,
  };
}

function track(owner: AnalyticsSessionRow, script: Scripted[]): AnalyticsEventRow[] {
  const started = eventRow(owner, ['session_started', null], null);
  return [started, ...script.map((item, i) => eventRow(owner, item, at(i + 1)))];
}

function redeliver(events: AnalyticsEventRow[], arrivalOrder: number[]): AnalyticsEventRow[] {
  return arrivalOrder.map((index) => {
    lastSeq += 1;
    return { ...events[index], seq: lastSeq };
  });
}

const viewed = (stepId: string): Scripted => ['step_viewed', stepId];

const answered = (...stepIds: string[]): Scripted[] =>
  stepIds.flatMap((stepId): Scripted[] => [
    ['step_viewed', stepId],
    ['answer_submitted', stepId],
    ['step_completed', stepId],
  ]);

const resultShown = (resultId: string): Scripted[] => [
  ['step_viewed', 'result'],
  ['result_viewed', 'result', { result_id: resultId }],
];

const ctaClick = (resultId: string): Scripted => ['cta_clicked', 'result', { result_id: resultId, action: 'expand_recommendation' }];

const V1_A_REMOTE = ['team_size', 'work_mode', 'priorities', 'timezone_span', 'async_maturity', 'tool_count'];
const V1_B_REMOTE = ['work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'tool_count'];

function analyze(
  sessions: AnalyticsSessionRow[],
  events: AnalyticsEventRow[],
  query: AnalyticsQuery = {},
  ingest: IngestTotals = { duplicates: 0, rejected: 0 },
): AnalyticsResponse {
  return computeAnalytics({ sessions, events, configs, ingest, query, now: new Date('2026-10-02T12:00:00.000Z') });
}

function funnelOf(response: AnalyticsResponse, version: number, variant: string): FunnelBreakdown {
  const funnel = response.funnels.find((f) => f.version === version && f.variant === variant);
  if (!funnel) throw new Error(`No funnel for v${version}/${variant}.`);
  return funnel;
}

function table(funnel: FunnelBreakdown): Record<string, [reached: number, progressed: number, dropped: number]> {
  return Object.fromEntries(funnel.steps.map((step) => [step.stepId, [step.reached, step.progressed, step.dropped]]));
}

function views(funnel: FunnelBreakdown): Record<string, number> {
  return Object.fromEntries(funnel.steps.map((step) => [step.stepId, step.views]));
}

describe('funnel steps', () => {
  it('counts a repeated step view once in reached but adds it to views', () => {
    const s1 = session('s1');
    const s2 = session('s2');
    const events = [
      ...track(s1, [viewed('intro'), viewed('intro'), ...answered('team_size'), viewed('work_mode'), viewed('work_mode')]),
      ...track(s2, [viewed('intro'), viewed('intro')]),
    ];
    const response = analyze([s1, s2], events);
    const funnel = funnelOf(response, 1, 'A');

    expect(table(funnel)).toEqual({
      intro: [2, 1, 1],
      team_size: [1, 1, 0],
      work_mode: [1, 0, 1],
      priorities: [0, 0, 0],
      timezone_span: [0, 0, 0],
      office_days: [0, 0, 0],
      async_maturity: [0, 0, 0],
      tool_count: [0, 0, 0],
      result: [0, 0, 0],
    });
    expect(views(funnel)).toMatchObject({ intro: 4, team_size: 1, work_mode: 2, priorities: 0 });
    expect(response.dataQuality.repeatedStepViews).toBe(3);
  });

  it('keeps the furthest step after Back', () => {
    const s1 = session('s1');
    const events = track(s1, [
      viewed('intro'),
      ...answered('team_size', 'work_mode'),
      viewed('priorities'),
      ['back_clicked', 'priorities', { destination_step_id: 'work_mode' }],
      viewed('work_mode'),
      ['back_clicked', 'work_mode', { destination_step_id: 'team_size' }],
      viewed('team_size'),
    ]);
    const response = analyze([s1], events);
    const funnel = funnelOf(response, 1, 'A');

    expect(table(funnel)).toMatchObject({
      intro: [1, 1, 0],
      team_size: [1, 1, 0],
      work_mode: [1, 1, 0],
      priorities: [1, 0, 1],
      timezone_span: [0, 0, 0],
    });
    expect(views(funnel)).toMatchObject({ team_size: 2, work_mode: 2, priorities: 1 });
    expect(response.dataQuality).toMatchObject({ backClicks: 2, repeatedStepViews: 2 });
  });

  it('gives the same funnel for out-of-order delivery and counts the late events', () => {
    const complete = session('complete');
    const partial = session('partial');
    const steady = session('steady', { variant: 'B' });
    const completeEvents = track(complete, [viewed('intro'), ...answered(...V1_A_REMOTE), ...resultShown('async_native'), ctaClick('async_native')]);
    const partialEvents = track(partial, [viewed('intro'), ...answered('team_size', 'work_mode'), viewed('priorities')]);
    const steadyEvents = track(steady, [viewed('intro'), ...answered('work_mode')]);
    const sessions = [complete, partial, steady];

    const inOrder = analyze(sessions, [...completeEvents, ...partialEvents, ...steadyEvents]);
    const reversedAfterStart = [0, ...completeEvents.slice(1).map((_, i) => completeEvents.length - 1 - i)];
    const shuffled = analyze(sessions, [
      ...redeliver(completeEvents, reversedAfterStart),
      ...redeliver(partialEvents, [0, 1, 2, 5, 3, 4, 8, 6, 7]),
      ...steadyEvents,
    ]);

    expect(shuffled.funnels).toEqual(inOrder.funnels);
    expect(shuffled.totals).toEqual(inOrder.totals);
    expect(shuffled.resultMix).toEqual(inOrder.resultMix);
    expect(inOrder.dataQuality).toMatchObject({ outOfOrderEvents: 0, sessionsWithOutOfOrderEvents: 0 });
    expect(shuffled.dataQuality).toMatchObject({ outOfOrderEvents: 21 + 4, sessionsWithOutOfOrderEvents: 2 });
    expect(table(funnelOf(shuffled, 1, 'A'))).toMatchObject({ priorities: [2, 1, 1], result: [1, 1, 0] });
  });

  it('implies unconditional steps whose events were lost, never conditional ones', () => {
    const lost = session('lost');
    const silent = session('silent');
    const office = session('office');
    const lostV3 = session('lost-v3', { version: 3 });
    const events = [
      ...track(lost, [viewed('intro'), viewed('work_mode'), ['step_completed', 'work_mode'], viewed('tool_count'), ...resultShown('balanced')]),
      ...track(silent, []),
      ...track(office, [viewed('intro'), viewed('office_days')]),
      ...track(lostV3, [viewed('intro'), viewed('timezone_span'), viewed('meeting_hours'), viewed('tool_count')]),
    ];
    const response = analyze([lost, silent, office, lostV3], events);

    expect(table(funnelOf(response, 1, 'A'))).toEqual({
      intro: [3, 2, 1],
      team_size: [2, 2, 0],
      work_mode: [2, 2, 0],
      priorities: [2, 2, 0],
      timezone_span: [2, 2, 0],
      office_days: [1, 0, 1],
      async_maturity: [1, 1, 0],
      tool_count: [1, 1, 0],
      result: [1, 0, 1],
    });
    const v3A = funnelOf(response, 3, 'A');
    expect(table(v3A)).toEqual({
      intro: [1, 1, 0],
      team_size: [1, 1, 0],
      work_mode: [1, 1, 0],
      priorities: [1, 1, 0],
      security_constraints: [0, 0, 0],
      timezone_span: [1, 1, 0],
      office_days: [0, 0, 0],
      meeting_hours: [1, 1, 0],
      async_maturity: [1, 1, 0],
      tool_count: [1, 0, 1],
      result: [0, 0, 0],
    });
    expect(v3A.steps.filter((step) => step.conditional).map((step) => step.stepId)).toEqual(['security_constraints', 'office_days']);
  });

  it('locates the drop-off at the furthest step', () => {
    const quits = session('quits', { variant: 'B' });
    const timezone = session('timezone', { variant: 'B' });
    const office = session('office', { variant: 'B' });
    const noClick = session('no-click', { variant: 'B' });
    const clicks = session('clicks', { variant: 'B' });
    const events = [
      ...track(quits, []),
      ...track(timezone, [viewed('intro'), ...answered('work_mode'), viewed('timezone_span')]),
      ...track(office, [viewed('intro'), ...answered('work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities'), viewed('office_days')]),
      ...track(noClick, [viewed('intro'), ...answered(...V1_B_REMOTE), ...resultShown('async_native')]),
      ...track(clicks, [viewed('intro'), ...answered(...V1_B_REMOTE), ...resultShown('async_native'), ctaClick('async_native')]),
    ];
    const response = analyze([quits, timezone, office, noClick, clicks], events);
    const funnel = funnelOf(response, 1, 'B');

    expect(table(funnel)).toEqual({
      intro: [5, 4, 1],
      work_mode: [4, 4, 0],
      timezone_span: [4, 3, 1],
      team_size: [3, 3, 0],
      async_maturity: [3, 3, 0],
      priorities: [3, 3, 0],
      office_days: [1, 0, 1],
      tool_count: [2, 2, 0],
      result: [2, 1, 1],
    });
    expect(funnel.steps.find((s) => s.stepId === 'intro')).toMatchObject({ conversion: 0.8, dropOffRate: 0.2 });
    expect(funnel.steps.find((s) => s.stepId === 'timezone_span')).toMatchObject({ conversion: 0.75, dropOffRate: 0.25 });
    expect(funnel).toMatchObject({ started: 5, reachedResult: 2, ctaClicked: 1 });
    const totalDropped = funnel.steps.reduce((sum, step) => sum + step.dropped, 0);
    expect(totalDropped + funnel.ctaClicked).toBe(funnel.started);
    expect(response.funnels.map((f) => [f.version, f.variant, f.started])).toEqual([
      [1, 'A', 0],
      [1, 'B', 5],
    ]);
  });
});

describe('KPIs', () => {
  it('computes result rate, CTR and startedToCta on unique sessions', () => {
    const twice = session('twice');
    const once = session('once');
    const refresh = session('refresh');
    const quits = session('quits');
    const path = [viewed('intro'), ...answered(...V1_A_REMOTE)];
    const events = [
      ...track(twice, [...path, ...resultShown('async_native'), ctaClick('async_native'), ctaClick('async_native')]),
      ...track(once, [...path, ...resultShown('async_native'), ctaClick('async_native')]),
      ...track(refresh, [...path, ...resultShown('balanced'), ...resultShown('balanced')]),
      ...track(quits, [viewed('intro'), viewed('team_size')]),
    ];
    const response = analyze([twice, once, refresh, quits], events);

    expect(response.totals).toEqual({
      started: 4,
      reachedResult: 3,
      resultRate: 0.75,
      ctaClicked: 2,
      ctr: 2 / 3,
      startedToCta: 0.5,
    });
    expect(funnelOf(response, 1, 'A').steps.at(-1)).toMatchObject({
      stepId: 'result',
      reached: 3,
      progressed: 2,
      dropped: 1,
      conversion: 2 / 3,
      dropOffRate: 1 / 3,
      views: 4,
    });
  });

  it('returns null rates for zero denominators', () => {
    const quits = session('quits');
    const events = track(quits, [viewed('intro'), viewed('team_size')]);

    const empty = analyze([quits], events, { utmCampaign: 'nobody' });
    expect(empty.totals).toEqual({ started: 0, reachedResult: 0, resultRate: null, ctaClicked: 0, ctr: null, startedToCta: null });
    expect(empty).toMatchObject({ versions: [], experiments: [], funnels: [], resultMix: [] });
    expect(empty.dataQuality.eventsStored).toBe(0);

    const response = analyze([quits], events);
    expect(response.totals).toMatchObject({ resultRate: 0, ctr: null, startedToCta: 0 });
    expect(funnelOf(response, 1, 'A').steps.find((s) => s.stepId === 'priorities')).toMatchObject({
      reached: 0,
      conversion: null,
      dropOffRate: null,
    });
    expect(funnelOf(response, 1, 'B').steps[0]).toMatchObject({ reached: 0, conversion: null });
    const [experiment] = response.experiments;
    expect(experiment.variants.map((v) => [v.variant, v.started, v.startedToCta])).toEqual([
      ['A', 1, 0],
      ['B', 0, null],
    ]);
    expect(experiment).toMatchObject({ absoluteDiff: null, relativeLift: null, pValue: null, significant: null });
  });
});

describe('population filters', () => {
  const springV1 = session('spring-v1', { utmCampaign: 'spring', runId: 'r1' });
  const summerV1 = session('summer-v1', { variant: 'B', utmCampaign: 'summer', runId: 'r2' });
  const springV3 = session('spring-v3', { version: 3, utmCampaign: 'spring', runId: 'r2' });
  const directV3 = session('direct-v3', { version: 3, variant: 'B' });
  const sessions = [springV1, summerV1, springV3, directV3];
  const summerEvents = track(summerV1, [viewed('intro')]);
  const events = [
    ...track(springV1, [viewed('intro'), ...answered(...V1_A_REMOTE), ...resultShown('async_native'), ctaClick('async_native')]),
    ...summerEvents,
    ...track(springV3, [viewed('intro'), viewed('tool_count'), ...resultShown('meeting_heavy')]),
    ...track(directV3, [viewed('intro'), viewed('work_mode')]),
  ];
  const ingest = { duplicates: 7, rejected: 2 };

  it('compares versions on step-agnostic KPIs and orders every list', () => {
    const response = analyze(sessions, events, {}, ingest);
    expect(response.versions).toEqual([
      { version: 1, experimentId: v1.experiment.id, started: 2, reachedResult: 1, resultRate: 0.5, ctaClicked: 1, ctr: 1, startedToCta: 0.5 },
      { version: 3, experimentId: v3.experiment.id, started: 2, reachedResult: 1, resultRate: 0.5, ctaClicked: 0, ctr: 0, startedToCta: 0 },
    ]);
    expect(response.funnels.map((f) => `${f.version}${f.variant}`)).toEqual(['1A', '1B', '3A', '3B']);
    expect(funnelOf(response, 3, 'B').steps.map((s) => s.stepId)).toEqual(v3.experiment.variants.B.stepSequence);
    expect(response.experiments.map((e) => e.experimentId)).toEqual([v1.experiment.id, v3.experiment.id]);
    expect(response.generatedAt).toBe('2026-10-02T12:00:00.000Z');
  });

  it('filters by utm_campaign', () => {
    const response = analyze(sessions, events, { utmCampaign: 'spring' }, ingest);
    expect(response.totals).toMatchObject({ started: 2, reachedResult: 2, ctaClicked: 1 });
    expect(response.versions.map((v) => [v.version, v.started])).toEqual([
      [1, 1],
      [3, 1],
    ]);
    expect(response.filters).toEqual({ utmCampaign: 'spring', version: null, runId: null, includeOverrides: false });
  });

  it('filters by version', () => {
    const response = analyze(sessions, events, { version: 3 }, ingest);
    expect(response.totals.started).toBe(2);
    expect(response.versions.map((v) => v.version)).toEqual([3]);
    expect(response.funnels.map((f) => `${f.version}${f.variant}`)).toEqual(['3A', '3B']);
  });

  it('filters by run_id and combines filters', () => {
    expect(analyze(sessions, events, { runId: 'r2' }).totals.started).toBe(2);
    expect(analyze(sessions, events, { runId: 'r2', version: 1 }).totals.started).toBe(1);
    expect(analyze(sessions, events, { utmCampaign: 'spring', version: 1 }).totals).toMatchObject({ started: 1, ctaClicked: 1 });
  });

  it('keeps available filters and ingest totals global while scoping stored events', () => {
    const response = analyze(sessions, events, { utmCampaign: 'summer' }, ingest);
    expect(response.available).toEqual({ campaigns: ['spring', 'summer'], versions: [1, 3] });
    expect(response.dataQuality).toMatchObject({ eventsStored: summerEvents.length, duplicatesDropped: 7, rejectedEvents: 2 });
  });
});

describe('experiments', () => {
  function abTest(clicksA: number, totalA: number, clicksB: number, totalB: number) {
    const sessions: AnalyticsSessionRow[] = [];
    const events: AnalyticsEventRow[] = [];
    for (const [variant, clicks, total] of [['A', clicksA, totalA], ['B', clicksB, totalB]] as const) {
      for (let i = 0; i < total; i += 1) {
        const owner = session(`${variant}-${i}`, { variant });
        sessions.push(owner);
        events.push(...track(owner, i < clicks ? [...resultShown('balanced'), ctaClick('balanced')] : []));
      }
    }
    return analyze(sessions, events).experiments[0];
  }

  it('runs a pooled two-proportion z-test on startedToCta', () => {
    const experiment = abTest(120, 1000, 150, 1000);
    expect(experiment.variants.map((v) => [v.variant, v.started, v.ctaClicked, v.startedToCta])).toEqual([
      ['A', 1000, 120, 0.12],
      ['B', 1000, 150, 0.15],
    ]);
    expect(experiment.metric).toBe('startedToCta');
    expect(experiment.absoluteDiff).toBeCloseTo(0.03, 12);
    expect(experiment.relativeLift).toBeCloseTo(0.25, 12);
    expect(experiment.pValue).toBeCloseTo(0.049640, 5);
    expect(experiment.significant).toBe(true);
  });

  it('is two-sided and reports non-significant differences', () => {
    const reversed = abTest(150, 1000, 120, 1000);
    expect(reversed.absoluteDiff).toBeCloseTo(-0.03, 12);
    expect(reversed.relativeLift).toBeCloseTo(-0.2, 12);
    expect(reversed.pValue).toBeCloseTo(0.049640, 5);

    const small = abTest(40, 200, 50, 200);
    expect(small.pValue).toBeCloseTo(0.231163, 5);
    expect(small.significant).toBe(false);
  });

  it('has no p-value when neither variant converts', () => {
    expect(abTest(0, 10, 0, 10)).toMatchObject({ absoluteDiff: 0, relativeLift: null, pValue: null, significant: null });
  });

  const hashA1 = session('hash-a1');
  const hashA2 = session('hash-a2');
  const hashB = session('hash-b', { variant: 'B' });
  const qaB1 = session('qa-b1', { variant: 'B', assignmentSource: 'override' });
  const qaB2 = session('qa-b2', { variant: 'B', assignmentSource: 'override' });
  const sessions = [hashA1, hashA2, hashB, qaB1, qaB2];
  const events = [
    ...track(hashA1, [...resultShown('balanced'), ctaClick('balanced')]),
    ...track(hashA2, resultShown('balanced')),
    ...track(hashB, [...resultShown('balanced'), ctaClick('balanced')]),
    ...track(qaB1, [...resultShown('balanced'), ctaClick('balanced')]),
    ...track(qaB2, [viewed('intro')]),
  ];

  it('excludes override sessions from experiments by default', () => {
    const response = analyze(sessions, events);
    const [experiment] = response.experiments;
    expect(experiment.excludedOverrideSessions).toBe(2);
    expect(experiment.variants.map((v) => [v.variant, v.started, v.reachedResult, v.ctaClicked, v.startedToCta])).toEqual([
      ['A', 2, 2, 1, 0.5],
      ['B', 1, 1, 1, 1],
    ]);
    expect(experiment).toMatchObject({ absoluteDiff: 0.5, relativeLift: 1 });
    expect(response.totals.started).toBe(5);
    expect(funnelOf(response, 1, 'B').started).toBe(3);
  });

  it('includes override sessions with includeOverrides', () => {
    const response = analyze(sessions, events, { includeOverrides: true });
    const [experiment] = response.experiments;
    expect(experiment.excludedOverrideSessions).toBe(0);
    expect(experiment.variants.map((v) => [v.variant, v.started, v.ctaClicked, v.startedToCta])).toEqual([
      ['A', 2, 1, 0.5],
      ['B', 3, 2, 2 / 3],
    ]);
    expect(response.filters.includeOverrides).toBe(true);
    expect(response.totals.started).toBe(5);
  });
});

describe('result mix', () => {
  it('uses the latest result_viewed of each session', () => {
    const changed = session('changed');
    const lateArrival = session('late-arrival');
    const sameTime = session('same-time');
    const balancedA = session('balanced-a');
    const balancedB = session('balanced-b', { variant: 'B' });
    const noResult = session('no-result', { variant: 'B' });
    const shown = (owner: AnalyticsSessionRow, resultId: string, second: number) =>
      eventRow(owner, ['result_viewed', 'result', { result_id: resultId }], at(second));
    const events = [
      ...track(changed, [
        ...resultShown('office_core'),
        ['back_clicked', 'result', { destination_step_id: 'tool_count' }],
        ...answered('tool_count'),
        ...resultShown('hybrid_structured'),
      ]),
      ...track(lateArrival, []),
      shown(lateArrival, 'hybrid_structured', 20),
      shown(lateArrival, 'office_core', 10),
      ...track(sameTime, []),
      shown(sameTime, 'hybrid_structured', 30),
      shown(sameTime, 'office_core', 30),
      ...track(balancedA, resultShown('balanced')),
      ...track(balancedB, resultShown('balanced')),
      ...track(noResult, [viewed('intro')]),
    ];
    const response = analyze([changed, lateArrival, sameTime, balancedA, balancedB, noResult], events);

    expect(response.resultMix).toEqual([
      { version: 1, variant: 'A', resultId: 'hybrid_structured', sessions: 2 },
      { version: 1, variant: 'A', resultId: 'balanced', sessions: 1 },
      { version: 1, variant: 'A', resultId: 'office_core', sessions: 1 },
      { version: 1, variant: 'B', resultId: 'balanced', sessions: 1 },
    ]);
    expect(response.dataQuality).toMatchObject({ outOfOrderEvents: 1, sessionsWithOutOfOrderEvents: 1 });
  });
});
