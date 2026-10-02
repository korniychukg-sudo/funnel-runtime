import { describe, expect, it } from 'vitest';
import v1Config from '../configs/funnel-v1.json';
import v3Config from '../configs/funnel-v3.json';
import * as events from '../src/client/events';
import type { IncomingEvent, SessionState } from '../src/shared/api';
import type { Answers } from '../src/shared/conditions';
import { parseFunnelConfig } from '../src/shared/config';
import { resolveFunnel } from '../src/shared/engine';

function sessionState(rawConfig: unknown, variant: string, answers: Answers = {}): SessionState {
  const parsed = parseFunnelConfig(rawConfig);
  if (!parsed.ok) throw new Error(`Fixture config is invalid: ${JSON.stringify(parsed.errors)}`);
  const funnel = resolveFunnel(parsed.config, variant);
  const resultId = funnel.defaultResultId;
  return {
    session: {
      id: 'session-123',
      funnelId: funnel.funnelId,
      version: funnel.version,
      experimentId: funnel.experimentId,
      variant,
      assignmentSource: 'hash',
      utm: { source: 'newsletter', medium: 'email', campaign: 'spring' },
      runId: null,
      createdAt: '2026-10-01T10:00:00.000Z',
      expiresAt: '2026-10-04T10:00:00.000Z',
    },
    funnel,
    answers,
    currentStepId: 'result',
    resultId,
    result: funnel.results[resultId],
    resumed: false,
  };
}

function allEvents(state: SessionState): IncomingEvent[] {
  const result = state.result!;
  return [
    events.stepViewed(state, 'intro'),
    events.stepViewed(state, 'team_size'),
    events.answerSubmitted(state, 'priorities'),
    events.stepCompleted(state, 'priorities', 'timezone_span'),
    events.backClicked(state, 'timezone_span', 'priorities'),
    events.resultViewed(state, result),
    events.ctaClicked(state, result),
    events.recommendationExpanded(state, result),
  ].filter((event): event is IncomingEvent => event !== null);
}

describe('client events', () => {
  it('stamps base fields from the session', () => {
    const state = sessionState(v1Config, 'B');
    const event = events.stepViewed(state, 'team_size')!;

    expect(event).toMatchObject({
      session_id: 'session-123',
      name: 'step_viewed',
      step_id: 'team_size',
      funnel_id: 'workstyle-planner',
      funnel_version: 1,
      experiment_id: 'question-order-and-result-framing-v1',
      variant: 'B',
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'spring',
    });
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Date(event.client_timestamp).toISOString()).toBe(event.client_timestamp);
  });

  it('gives every event its own id', () => {
    const state = sessionState(v3Config, 'A');
    const ids = Array.from({ length: 100 }, () => events.stepViewed(state, 'intro')!.event_id);
    expect(new Set(ids).size).toBe(100);
  });

  it('emits only events and properties allowed by the pinned version', () => {
    for (const [config, variant] of [
      [v1Config, 'A'],
      [v1Config, 'B'],
      [v3Config, 'A'],
      [v3Config, 'B'],
    ] as const) {
      const state = sessionState(config, variant);
      for (const event of allEvents(state)) {
        const allowed = state.funnel.allowedEvents[event.name];
        expect(allowed, event.name).toBeDefined();
        expect(Object.keys(event.properties ?? {}).every((key) => allowed.includes(key)), event.name).toBe(true);
      }
    }
  });

  it('drops events and properties the config does not list', () => {
    const state = sessionState(v3Config, 'A');
    state.funnel.allowedEvents = { step_viewed: ['step_type'] };

    expect(events.stepViewed(state, 'team_size')!.properties).toEqual({ step_type: 'number' });
    expect(events.backClicked(state, 'work_mode', 'team_size')).toBeNull();
    expect(events.answerSubmitted(state, 'team_size')).toBeNull();
  });

  it('does not produce recommendation_expanded for a v1 session', () => {
    const state = sessionState(v1Config, 'B');
    expect(events.recommendationExpanded(state, state.result!)).toBeNull();
    expect(allEvents(state).map((event) => event.name)).not.toContain('recommendation_expanded');
  });

  it('produces recommendation_expanded for a v3 session', () => {
    const state = sessionState(v3Config, 'B');
    expect(events.recommendationExpanded(state, state.result!)).toMatchObject({
      name: 'recommendation_expanded',
      step_id: 'result',
      properties: { result_id: 'balanced', action: 'expand_recommendation', source: 'result_cta' },
    });
  });

  it('reports visible progress in step_viewed', () => {
    const fresh = sessionState(v1Config, 'A');
    expect(events.stepViewed(fresh, 'intro')!.properties).toEqual({
      step_type: 'info',
      visible_step_index: null,
      visible_step_count: 7,
    });
    expect(events.stepViewed(fresh, 'team_size')!.properties).toEqual({
      step_type: 'number',
      visible_step_index: 1,
      visible_step_count: 7,
    });

    const remote = sessionState(v1Config, 'A', { team_size: 12, work_mode: 'remote' });
    expect(events.stepViewed(remote, 'tool_count')!.properties).toEqual({
      step_type: 'number',
      visible_step_index: 6,
      visible_step_count: 6,
    });
  });

  it('never carries answer values', () => {
    const state = sessionState(v3Config, 'A', {
      team_size: 4321,
      work_mode: 'hybrid',
      priorities: ['compliance', 'onboarding'],
      security_constraints: 'regulated',
    });
    const answered = events.answerSubmitted(state, 'priorities')!;
    expect(answered.properties).toEqual({ answer_kind: 'multi-select' });

    const serialized = JSON.stringify(allEvents(state).map((event) => event.properties));
    for (const value of ['4321', 'hybrid', 'compliance', 'onboarding', 'regulated']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('stamps result events with the result step and result id', () => {
    const state = sessionState(v3Config, 'B');
    const result = state.result!;
    expect(events.resultViewed(state, result)).toMatchObject({ step_id: 'result', properties: { result_id: 'balanced' } });
    expect(events.ctaClicked(state, result)).toMatchObject({
      step_id: 'result',
      properties: { result_id: 'balanced', action: 'expand_recommendation' },
    });
  });

  it('records back_clicked on the step being left', () => {
    const state = sessionState(v1Config, 'A');
    expect(events.backClicked(state, 'work_mode', 'team_size')).toMatchObject({
      step_id: 'work_mode',
      properties: { destination_step_id: 'team_size' },
    });
    expect(events.stepCompleted(state, 'team_size', 'work_mode')).toMatchObject({
      step_id: 'team_size',
      properties: { next_step_id: 'work_mode' },
    });
  });
});
