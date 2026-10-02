import { readFileSync } from 'node:fs';
import type { AnalyticsResponse } from '../src/shared/api';
import { parseArgs } from './lib/args';
import { createClient } from './lib/http';
import type { Expected } from './lib/truth';

type Check = { name: string; expected: unknown; actual: unknown };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args['base-url'] ?? 'http://localhost:3000';
  const file = args.expected;
  if (!file) throw new Error('Usage: npm run verify -- --expected expected-<runId>.json [--base-url http://localhost:3000]');
  const expected = JSON.parse(readFileSync(file, 'utf8')) as Expected;
  const client = createClient(baseUrl);
  const fetchAnalytics = (extra: Record<string, string> = {}) =>
    client.analytics({ run_id: expected.runId, include_overrides: '1', ...extra }) as Promise<AnalyticsResponse>;

  const actual = await fetchAnalytics();
  const checks: Check[] = [];
  const check = (name: string, exp: unknown, act: unknown) => checks.push({ name, expected: exp, actual: act });

  check('totals.started', expected.totals.started, actual.totals.started);
  check('totals.reachedResult', expected.totals.reachedResult, actual.totals.reachedResult);
  check('totals.ctaClicked', expected.totals.ctaClicked, actual.totals.ctaClicked);

  for (const v of expected.versions) {
    const row = actual.versions.find((r) => r.version === v.version);
    check(`v${v.version}.started`, v.started, row?.started);
    check(`v${v.version}.reachedResult`, v.reachedResult, row?.reachedResult);
    check(`v${v.version}.ctaClicked`, v.ctaClicked, row?.ctaClicked);
  }

  for (const v of expected.variants) {
    const row = actual.experiments.find((e) => e.version === v.version)?.variants.find((r) => r.variant === v.variant);
    check(`v${v.version}/${v.variant}.started`, v.started, row?.started);
    check(`v${v.version}/${v.variant}.reachedResult`, v.reachedResult, row?.reachedResult);
    check(`v${v.version}/${v.variant}.ctaClicked`, v.ctaClicked, row?.ctaClicked);
  }

  for (const f of expected.funnels) {
    const funnel = actual.funnels.find((r) => r.version === f.version && r.variant === f.variant);
    for (const step of f.steps) {
      const row = funnel?.steps.find((s) => s.stepId === step.stepId);
      const label = `funnel v${f.version}/${f.variant} ${step.stepId}`;
      check(`${label} reached`, step.reached, row?.reached);
      check(`${label} progressed`, step.progressed, row?.progressed);
      check(`${label} dropped`, step.dropped, row?.dropped);
    }
  }

  for (const m of expected.resultMix) {
    const row = actual.resultMix.find((r) => r.version === m.version && r.variant === m.variant && r.resultId === m.resultId);
    check(`result mix v${m.version}/${m.variant} ${m.resultId}`, m.sessions, row?.sessions ?? 0);
  }

  check('dataQuality.repeatedStepViews', expected.dataQuality.repeatedStepViews, actual.dataQuality.repeatedStepViews);
  check('dataQuality.backClicks', expected.dataQuality.backClicks, actual.dataQuality.backClicks);
  check('dataQuality.outOfOrderEvents', expected.dataQuality.outOfOrderEvents, actual.dataQuality.outOfOrderEvents);
  check(
    'dataQuality.sessionsWithOutOfOrderEvents',
    expected.dataQuality.sessionsWithOutOfOrderEvents,
    actual.dataQuality.sessionsWithOutOfOrderEvents,
  );

  for (const c of expected.campaigns) {
    if (!c.campaign) continue;
    const filtered = await fetchAnalytics({ utm_campaign: c.campaign });
    check(`campaign ${c.campaign} started`, c.started, filtered.totals.started);
  }

  const failed = checks.filter((c) => c.expected !== c.actual);
  for (const c of checks) {
    const mark = c.expected === c.actual ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${c.name.padEnd(56)} expected ${String(c.expected).padStart(5)}  actual ${String(c.actual).padStart(5)}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks match the generator's ground truth for run ${expected.runId}.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
