import type { IncomingEvent } from '../../src/shared/api';
import type { SessionTruth } from './simulate';

export type ExpectedKpis = { started: number; reachedResult: number; ctaClicked: number };

export type ExpectedStep = { stepId: string; reached: number; progressed: number; dropped: number };

export type Expected = {
  runId: string;
  generatedAt: string;
  sessions: number;
  totals: ExpectedKpis;
  versions: Array<ExpectedKpis & { version: number }>;
  variants: Array<ExpectedKpis & { version: number; variant: string }>;
  campaigns: Array<{ campaign: string | null; started: number }>;
  funnels: Array<{ version: number; variant: string; steps: ExpectedStep[] }>;
  resultMix: Array<{ version: number; variant: string; resultId: string; sessions: number }>;
  dataQuality: { repeatedStepViews: number; backClicks: number; outOfOrderEvents: number; sessionsWithOutOfOrderEvents: number };
  delivery: { eventsGenerated: number; batches: number; resentBatches: number; duplicateCopies: number; invalidEvents: number };
};

function kpis(list: SessionTruth[]): ExpectedKpis {
  return {
    started: list.length,
    reachedResult: list.filter((t) => t.reachedResult).length,
    ctaClicked: list.filter((t) => t.ctaClicked).length,
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}

function furthest(truth: SessionTruth): number {
  return Math.max(-1, ...[...truth.reached].map((id) => truth.sequence.indexOf(id)));
}

export function outOfOrder(arrival: IncomingEvent[]) {
  const latest = new Map<string, number>();
  const sessions = new Set<string>();
  let count = 0;
  for (const event of arrival) {
    const ts = Date.parse(event.client_timestamp);
    const seen = latest.get(event.session_id);
    if (seen !== undefined && ts < seen) {
      count++;
      sessions.add(event.session_id);
    }
    latest.set(event.session_id, Math.max(seen ?? ts, ts));
  }
  return { outOfOrderEvents: count, sessionsWithOutOfOrderEvents: sessions.size };
}

export function buildExpected(
  runId: string,
  truths: SessionTruth[],
  arrival: IncomingEvent[],
  delivery: Expected['delivery'],
): Expected {
  const byVersion = groupBy(truths, (t) => String(t.version));
  const byVariant = groupBy(truths, (t) => `${t.version}|${t.variant}`);
  const byCampaign = groupBy(truths, (t) => t.campaign ?? '');

  const funnels = [...byVariant.entries()].map(([key, list]) => {
    const [version, variant] = key.split('|');
    const sequence = list[0].sequence;
    const resultIndex = sequence.length - 1;
    const steps = sequence.map((stepId, index) => {
      const reachedList = list.filter((t) => t.reached.has(stepId));
      if (index === resultIndex) {
        const clicked = reachedList.filter((t) => t.ctaClicked).length;
        return { stepId, reached: reachedList.length, progressed: clicked, dropped: reachedList.length - clicked };
      }
      const progressed = reachedList.filter((t) => furthest(t) > index).length;
      return { stepId, reached: reachedList.length, progressed, dropped: reachedList.length - progressed };
    });
    return { version: Number(version), variant, steps };
  });

  const mix = groupBy(
    truths.filter((t) => t.resultId),
    (t) => `${t.version}|${t.variant}|${t.resultId}`,
  );

  const repeatedStepViews = truths.reduce((sum, t) => sum + t.stepViews - t.reached.size, 0);

  return {
    runId,
    generatedAt: new Date().toISOString(),
    sessions: truths.length,
    totals: kpis(truths),
    versions: [...byVersion.entries()]
      .map(([version, list]) => ({ version: Number(version), ...kpis(list) }))
      .sort((a, b) => a.version - b.version),
    variants: [...byVariant.entries()]
      .map(([key, list]) => {
        const [version, variant] = key.split('|');
        return { version: Number(version), variant, ...kpis(list) };
      })
      .sort((a, b) => a.version - b.version || a.variant.localeCompare(b.variant)),
    campaigns: [...byCampaign.entries()]
      .map(([campaign, list]) => ({ campaign: campaign || null, started: list.length }))
      .sort((a, b) => (a.campaign ?? '').localeCompare(b.campaign ?? '')),
    funnels: funnels.sort((a, b) => a.version - b.version || a.variant.localeCompare(b.variant)),
    resultMix: [...mix.entries()]
      .map(([key, list]) => {
        const [version, variant, resultId] = key.split('|');
        return { version: Number(version), variant, resultId, sessions: list.length };
      })
      .sort((a, b) => a.version - b.version || a.variant.localeCompare(b.variant) || a.resultId.localeCompare(b.resultId)),
    dataQuality: {
      repeatedStepViews,
      backClicks: truths.reduce((sum, t) => sum + t.backClicks, 0),
      ...outOfOrder(arrival),
    },
    delivery,
  };
}
