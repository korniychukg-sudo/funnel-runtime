import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateCondition } from '../src/shared/conditions';
import { parseFunnelConfig, type FunnelConfig, type Step } from '../src/shared/config';
import {
  computeResultId,
  effectiveAnswers,
  nextStepId,
  prevStepId,
  progressFor,
  resolveFunnel,
  validateAnswer,
  visibleSequence,
} from '../src/shared/engine';

function loadConfig(path: string): FunnelConfig {
  const parsed = parseFunnelConfig(JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')));
  if (!parsed.ok) throw new Error(`${path} does not parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.config;
}

const v1 = loadConfig('../configs/funnel-v1.json');
const v3 = loadConfig('../configs/funnel-v3.json');
const synthetic = loadConfig('./fixtures/funnel-synthetic.json');

const v1A = resolveFunnel(v1, 'A');
const v3A = resolveFunnel(v3, 'A');
const v3B = resolveFunnel(v3, 'B');
const synthA = resolveFunnel(synthetic, 'A');

describe('visibility and effective answers', () => {
  it('shows office_days only for hybrid or office work', () => {
    expect(visibleSequence(v1A, { work_mode: 'remote' })).not.toContain('office_days');
    expect(visibleSequence(v1A, { work_mode: 'hybrid' })).toContain('office_days');
    expect(visibleSequence(v1A, { work_mode: 'office' })).toContain('office_days');
  });

  it('keeps a hidden answer stored but leaves it out of the effective answers', () => {
    const answers = { team_size: 8, work_mode: 'remote', office_days: 3 };
    expect(effectiveAnswers(v1A, answers)).toEqual({ team_size: 8, work_mode: 'remote' });
    expect(answers.office_days).toBe(3);
    expect(effectiveAnswers(v1A, { ...answers, work_mode: 'hybrid' })).toEqual({ team_size: 8, work_mode: 'hybrid', office_days: 3 });
  });

  it('evaluates a chained condition only on answers of visible steps', () => {
    expect(visibleSequence(synthA, { transport: 'bike', bike_type: 'ebike' })).toEqual([
      'welcome',
      'distance_km',
      'transport',
      'bike_type',
      'bike_storage',
      'concerns',
      'result',
    ]);
    expect(visibleSequence(synthA, { transport: 'bike', bike_type: 'road' })).not.toContain('bike_storage');

    const stale = { transport: 'walk', bike_type: 'ebike', bike_storage: 'street' };
    expect(visibleSequence(synthA, stale)).toEqual(['welcome', 'distance_km', 'transport', 'concerns', 'result']);
    expect(effectiveAnswers(synthA, stale)).toEqual({ transport: 'walk' });
  });

  it('handles all / any / not nesting with gt', () => {
    const rainy = { concerns: ['weather'] };
    expect(visibleSequence(synthA, { ...rainy, distance_km: 3, transport: 'car' })).not.toContain('rain_plan');
    expect(visibleSequence(synthA, { ...rainy, distance_km: 8, transport: 'car' })).toContain('rain_plan');
    expect(visibleSequence(synthA, { ...rainy, distance_km: 3, transport: 'walk' })).toContain('rain_plan');
    expect(visibleSequence(synthA, { concerns: ['cost'], distance_km: 8, transport: 'walk' })).not.toContain('rain_plan');
  });
});

describe('progress', () => {
  it('counts unanswered conditional steps optimistically on the first question', () => {
    expect(progressFor(v1A, {}, 'team_size')).toEqual({ index: 1, count: 7 });
    expect(progressFor(v3A, {}, 'team_size')).toEqual({ index: 1, count: 9 });
    expect(progressFor(v3B, {}, 'work_mode')).toEqual({ index: 1, count: 8 });
    expect(progressFor(synthA, {}, 'distance_km')).toEqual({ index: 1, count: 6 });
  });

  it('gives info and result steps no index', () => {
    expect(progressFor(v1A, {}, 'intro').index).toBeNull();
    expect(progressFor(v1A, {}, 'result').index).toBeNull();
  });

  it('shrinks the count once a condition is known to be false', () => {
    expect(progressFor(v1A, { work_mode: 'remote' }, 'work_mode')).toEqual({ index: 2, count: 6 });
    expect(progressFor(v1A, { work_mode: 'hybrid' }, 'work_mode')).toEqual({ index: 2, count: 7 });
    expect(progressFor(v3A, { work_mode: 'remote', priorities: ['speed'] }, 'priorities')).toEqual({ index: 3, count: 7 });
    expect(progressFor(v3A, { work_mode: 'hybrid', priorities: ['compliance'] }, 'priorities')).toEqual({ index: 3, count: 9 });
    expect(progressFor(synthA, { transport: 'bike', bike_type: 'road' }, 'bike_type')).toEqual({ index: 3, count: 5 });
  });

  it('ends the count on the last visible question', () => {
    const answers = { team_size: 5, work_mode: 'remote', priorities: ['focus'], timezone_span: 'same', async_maturity: 'low' };
    expect(progressFor(v1A, answers, 'tool_count')).toEqual({ index: 6, count: 6 });
  });

  it('drops a chained conditional step whose source step is hidden', () => {
    expect(progressFor(synthA, { transport: 'walk' }, 'transport')).toEqual({ index: 2, count: 4 });
  });
});

describe('navigation', () => {
  it('skips hidden steps in both directions', () => {
    expect(nextStepId(v1A, { work_mode: 'remote' }, 'timezone_span')).toBe('async_maturity');
    expect(nextStepId(v1A, { work_mode: 'hybrid' }, 'timezone_span')).toBe('office_days');
    expect(prevStepId(v1A, { work_mode: 'remote' }, 'async_maturity')).toBe('timezone_span');
    expect(prevStepId(v1A, { work_mode: 'hybrid' }, 'async_maturity')).toBe('office_days');
    expect(nextStepId(synthA, { transport: 'bike', bike_type: 'road' }, 'bike_type')).toBe('concerns');
    expect(nextStepId(synthA, { transport: 'walk', bike_type: 'ebike' }, 'transport')).toBe('concerns');
  });

  it('stops at both ends of the sequence', () => {
    expect(prevStepId(v1A, {}, 'intro')).toBeNull();
    expect(nextStepId(v1A, {}, 'result')).toBeNull();
    expect(nextStepId(v1A, {}, 'not_a_step')).toBeNull();
  });

  it('takes the order of variant B from its stepSequence', () => {
    expect(v3B.sequence).toEqual(v3.experiment.variants.B.stepSequence);
    expect(nextStepId(v3B, { work_mode: 'remote' }, 'work_mode')).toBe('meeting_hours');
    expect(progressFor(v3B, { work_mode: 'remote' }, 'meeting_hours').index).toBe(2);
    expect(nextStepId(v3A, { team_size: 4 }, 'team_size')).toBe('work_mode');
  });

  it('removes tool_count from v3 variant B only', () => {
    expect(v3B.sequence).not.toContain('tool_count');
    expect(v3B.steps.tool_count).toBeUndefined();
    expect(v3A.sequence).toContain('tool_count');
    expect(nextStepId(v3B, { work_mode: 'office' }, 'office_days')).toBe('result');
  });
});

describe('validateAnswer', () => {
  const step = (funnel: typeof v1A, id: string): Step => funnel.steps[id];
  const teamSize = step(v1A, 'team_size');
  const officeDays = step(v1A, 'office_days');
  const priorities = step(v1A, 'priorities');
  const workMode = step(v1A, 'work_mode');
  const distance = step(synthA, 'distance_km');

  it('requires a number and uses the configured message', () => {
    expect(validateAnswer(teamSize, '')).toEqual({ ok: false, code: 'required', message: 'Enter the team size.' });
    expect(validateAnswer(teamSize, '   ')).toMatchObject({ ok: false, code: 'required' });
    expect(validateAnswer(teamSize, undefined)).toMatchObject({ ok: false, code: 'required' });
  });

  it('accepts zero as a real answer', () => {
    expect(validateAnswer(officeDays, '0')).toEqual({ ok: true, value: 0 });
    expect(validateAnswer(officeDays, 0)).toEqual({ ok: true, value: 0 });
  });

  it('normalises a padded numeric string', () => {
    expect(validateAnswer(teamSize, ' 7 ')).toEqual({ ok: true, value: 7 });
  });

  it('rejects fractions, exponent notation and non-numbers', () => {
    expect(validateAnswer(teamSize, 2.5)).toEqual({ ok: false, code: 'step', message: 'Enter a whole number.' });
    expect(validateAnswer(teamSize, '1e1')).toEqual({ ok: false, code: 'invalid', message: 'Enter a number.' });
    expect(validateAnswer(teamSize, 'seven')).toMatchObject({ ok: false, code: 'invalid' });
    expect(validateAnswer(teamSize, Number.NaN)).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('uses config messages for out-of-range values', () => {
    expect(validateAnswer(teamSize, 0)).toEqual({ ok: false, code: 'min', message: 'The team must have at least one person.' });
    expect(validateAnswer(teamSize, 201)).toEqual({ ok: false, code: 'max', message: 'For this demo, enter a value up to 200.' });
    expect(validateAnswer(officeDays, 6)).toEqual({ ok: false, code: 'max', message: 'Enter a value from 0 to 5.' });
    expect(validateAnswer(teamSize, 200)).toEqual({ ok: true, value: 200 });
  });

  it('checks fractional increments against the config', () => {
    expect(validateAnswer(distance, '2.5')).toEqual({ ok: true, value: 2.5 });
    expect(validateAnswer(distance, 2.25)).toEqual({ ok: false, code: 'step', message: 'Use half-kilometre steps.' });
  });

  it('validates multi-select answers', () => {
    expect(validateAnswer(priorities, [])).toEqual({ ok: false, code: 'required', message: 'Choose at least one priority.' });
    expect(validateAnswer(priorities, ['speed', 'focus', 'culture', 'cost'])).toEqual({
      ok: false,
      code: 'maxSelections',
      message: 'Choose no more than three priorities.',
    });
    expect(validateAnswer(priorities, ['speed', 'teleport'])).toMatchObject({ ok: false, code: 'invalid' });
    expect(validateAnswer(priorities, 'speed')).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('removes duplicate selections and keeps option order', () => {
    expect(validateAnswer(priorities, ['focus', 'speed', 'focus'])).toEqual({ ok: true, value: ['speed', 'focus'] });
    expect(validateAnswer(priorities, ['cost', 'cost', 'cost', 'speed'])).toEqual({ ok: true, value: ['speed', 'cost'] });
  });

  it('rejects an unknown single-select option', () => {
    expect(validateAnswer(workMode, 'mars')).toEqual({ ok: false, code: 'invalid', message: "Select the team's main work mode." });
    expect(validateAnswer(workMode, 'hybrid')).toEqual({ ok: true, value: 'hybrid' });
  });

  it('refuses an answer for a step without input', () => {
    expect(validateAnswer(step(v1A, 'intro'), 'x')).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('computeResultId', () => {
  it('maps v1 answers to results', () => {
    expect(computeResultId(v1A, { work_mode: 'remote', timezone_span: 'wide', async_maturity: 'low' })).toBe('async_native');
    expect(computeResultId(v1A, { work_mode: 'hybrid', office_days: 2, async_maturity: 'medium' })).toBe('hybrid_structured');
    expect(computeResultId(v1A, { work_mode: 'office', office_days: 5, async_maturity: 'low' })).toBe('office_core');
    expect(computeResultId(v1A, { work_mode: 'remote', timezone_span: 'same', async_maturity: 'low' })).toBe('balanced');
    expect(computeResultId(v1A, {})).toBe('balanced');
  });

  it('applies v1 rules in order', () => {
    expect(computeResultId(v1A, { work_mode: 'hybrid', office_days: 2, async_maturity: 'high' })).toBe('async_native');
  });

  it('applies v3 rules in order', () => {
    const base = { work_mode: 'remote', timezone_span: 'global', async_maturity: 'high', priorities: ['speed'] };
    expect(computeResultId(v3A, { ...base, meeting_hours: 14 })).toBe('async_native');
    expect(computeResultId(v3A, { ...base, meeting_hours: 15 })).toBe('meeting_heavy');
    const compliance = { ...base, meeting_hours: 20, priorities: ['compliance'] };
    expect(computeResultId(v3A, { ...compliance, security_constraints: 'strict' })).toBe('regulated_scale');
    expect(computeResultId(v3A, { ...compliance, security_constraints: 'regulated' })).toBe('regulated_scale');
    expect(computeResultId(v3A, { ...compliance, security_constraints: 'standard' })).toBe('meeting_heavy');
  });

  it('gives the same result in both v3 variants', () => {
    const answers = { work_mode: 'office', office_days: 4, meeting_hours: 3, timezone_span: 'same', async_maturity: 'low', priorities: ['focus'] };
    expect(computeResultId(v3A, answers)).toBe('office_core');
    expect(computeResultId(v3B, answers)).toBe('office_core');
  });

  it('ignores a stale hidden answer even when the rule has no guard', () => {
    const stale = { distance_km: 1, transport: 'walk', bike_type: 'ebike', bike_storage: 'street', concerns: ['cost'] };
    expect(evaluateCondition(synthA.resultRules[0].when, stale)).toBe(true);
    expect(computeResultId(synthA, stale)).toBe('walk_it');
    expect(computeResultId(synthA, { ...stale, transport: 'bike' })).toBe('secure_storage');
  });

  it('uses strict comparisons and the negated operators', () => {
    expect(computeResultId(synthA, { distance_km: 15, transport: 'bike', bike_type: 'road', concerns: ['time'] })).toBe('steady_routine');
    expect(computeResultId(synthA, { distance_km: 15.5, transport: 'bike', bike_type: 'road', concerns: ['time'] })).toBe('long_ride');
    expect(computeResultId(synthA, { distance_km: 2, transport: 'walk', concerns: ['time'] })).toBe('steady_routine');
    expect(computeResultId(synthA, { distance_km: 1.5, transport: 'walk', concerns: ['time'] })).toBe('walk_it');
    expect(computeResultId(synthA, { distance_km: 1.5, transport: 'car', concerns: ['time'] })).toBe('steady_routine');
    expect(computeResultId(synthA, { distance_km: 10, transport: 'transit', concerns: ['cost'] })).toBe('transit_routine');
    expect(computeResultId(synthA, { distance_km: 10, transport: 'transit', concerns: ['time'] })).toBe('steady_routine');
  });
});

describe('variant overrides', () => {
  it('does not mutate the base config', () => {
    const before = structuredClone(v1);
    const resolvedB = resolveFunnel(v1, 'B');
    resolvedB.steps.team_size.content.title = 'Changed after resolving';
    resolvedB.results.balanced.recommendations.push('Changed after resolving');
    expect(v1).toEqual(before);
  });

  it('leaves variant A untouched after resolving B', () => {
    const fresh = resolveFunnel(v1, 'A');
    resolveFunnel(v1, 'B');
    const again = resolveFunnel(v1, 'A');
    expect(again).toEqual(fresh);
    expect(again.steps.priorities.content.title).toBe('What should the operating model improve?');
    expect(again.results.async_native.title).toBe('Async-native');
  });

  it('applies B overrides to texts and results', () => {
    const resolvedB = resolveFunnel(v1, 'B');
    expect(resolvedB.steps.intro.content.primaryActionLabel).toBe('Show me');
    expect(resolvedB.steps.priorities.content.helperText).toBe('Choose up to three outcomes.');
    expect(resolvedB.results.async_native.title).toBe('Your team is ready to reduce meetings');
    expect(resolvedB.results.async_native.recommendations).toEqual(v1.results.async_native.recommendations);
  });

  it('keeps untouched fields of a partial override', () => {
    const synthB = resolveFunnel(synthetic, 'B');
    expect(synthB.steps.concerns.content).toEqual({ title: 'What would make you skip the trip?', helperText: 'Choose one or two.' });
    expect(synthB.steps.concerns.type).toBe('multi-select');
    expect(synthB.results.long_ride.title).toBe('Your ride is long enough to plan around');
    expect(synthB.results.long_ride.summary).toBe(synthetic.results.long_ride.summary);
    expect(synthB.results.long_ride.cta).toEqual(synthetic.results.long_ride.cta);
    expect(synthA.steps.concerns.content.title).toBe('What worries you about the trip?');
  });
});
