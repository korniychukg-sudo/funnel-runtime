import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import v1Config from '../configs/funnel-v1.json';
import v3Config from '../configs/funnel-v3.json';
import * as events from '../src/client/events';
import { questionProgress } from '../src/client/funnel/progress';
import { QuestionStep } from '../src/client/funnel/QuestionStep';
import { ResultStep } from '../src/client/funnel/ResultStep';
import {
  expandedKey,
  isReplacedSession,
  readExpandedResult,
  saveExpandedResult,
} from '../src/client/funnel/useFunnelSession';
import type { KeyValueStorage } from '../src/client/outbox';
import type { IncomingEvent, SessionState } from '../src/shared/api';
import type { Answers } from '../src/shared/conditions';
import { parseFunnelConfig, type Step } from '../src/shared/config';
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

function atStep(state: SessionState, stepId: string): SessionState {
  return { ...state, currentStepId: stepId };
}

function memoryStorage(): KeyValueStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const noop = () => undefined;

describe('question progress label', () => {
  const remote = { work_mode: 'remote' };

  it('counts the compliance follow-up while priorities are still unknown', () => {
    const state = atStep(sessionState(v3Config, 'B', remote), 'priorities');
    expect(questionProgress(state)).toEqual({ index: 6, count: 7 });
  });

  it('follows a valid draft answer on v3 variant B', () => {
    const state = atStep(sessionState(v3Config, 'B', remote), 'priorities');
    expect(questionProgress(state, ['speed'])).toEqual({ index: 6, count: 6 });
    expect(questionProgress(state, ['speed', 'compliance'])).toEqual({ index: 6, count: 7 });
  });

  it('falls back to the stored answers while the draft is invalid', () => {
    const state = atStep(sessionState(v3Config, 'B', { ...remote, priorities: ['speed'] }), 'priorities');
    expect(questionProgress(state)).toEqual({ index: 6, count: 6 });
    expect(questionProgress(state, [])).toEqual({ index: 6, count: 6 });
    expect(questionProgress(state, ['speed', 'focus', 'culture', 'compliance'])).toEqual({ index: 6, count: 6 });
    expect(questionProgress(state, ['compliance'])).toEqual({ index: 6, count: 7 });
  });

  it('keeps step_viewed on the stored answers', () => {
    const state = atStep(sessionState(v3Config, 'B', remote), 'priorities');
    expect(questionProgress(state, ['speed'])).toEqual({ index: 6, count: 6 });
    expect(events.stepViewed(state, 'priorities')!.properties).toMatchObject({
      visible_step_index: 6,
      visible_step_count: 7,
    });
  });

  it('follows a single-select draft and skips info steps', () => {
    const state = atStep(sessionState(v1Config, 'A'), 'work_mode');
    expect(questionProgress(state)).toEqual({ index: 2, count: 7 });
    expect(questionProgress(state, 'remote')).toEqual({ index: 2, count: 6 });
    expect(questionProgress(state, 'hybrid')).toEqual({ index: 2, count: 7 });
    expect(questionProgress(state, 'unknown')).toEqual({ index: 2, count: 7 });
    expect(questionProgress(atStep(state, 'intro'), 'remote')).toBeNull();
  });
});

describe('question step', () => {
  function render(busy: boolean): string {
    const state = sessionState(v3Config, 'A');
    const step = state.funnel.steps.work_mode as Extract<Step, { type: 'single-select' }>;
    return renderToStaticMarkup(
      createElement(QuestionStep, {
        step,
        stored: 'remote',
        headingRef: null,
        busy,
        error: null,
        onSubmit: noop,
        onEdit: noop,
        onDraftChange: noop,
      }),
    );
  }

  it('locks the choices while a submit is pending', () => {
    expect(render(true)).toMatch(/<fieldset class="answer-fields" disabled="">[\s\S]*type="radio"[\s\S]*<\/fieldset>/);
    expect(render(false)).toContain('<fieldset class="answer-fields">');
  });

  it('keeps the submit button outside the locked fieldset', () => {
    expect(render(true)).toMatch(/<\/fieldset>[\s\S]*type="submit"/);
  });
});

describe('session replacement notice', () => {
  const fresh = sessionState(v3Config, 'A');

  it('flags a new session that replaced the stored one', () => {
    expect(isReplacedSession({ sessionId: 'old-session' }, fresh)).toBe(true);
  });

  it('stays quiet for a resumed session, a first visit or a variant override', () => {
    expect(isReplacedSession({ sessionId: 'session-123' }, { ...fresh, resumed: true })).toBe(false);
    expect(isReplacedSession({ sessionId: null }, fresh)).toBe(false);
    const overridden = { ...fresh, session: { ...fresh.session, assignmentSource: 'override' as const } };
    expect(isReplacedSession({ sessionId: 'old-session', variant: 'A' }, overridden)).toBe(false);
  });
});

describe('result expansion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remembers the opened result per session', () => {
    const storage = memoryStorage();
    expect(readExpandedResult('session-123', storage)).toBeNull();

    saveExpandedResult('session-123', 'balanced', storage);

    expect(storage.getItem(expandedKey('session-123'))).toBe('balanced');
    expect(expandedKey('session-123')).toBe('funnel.expanded.session-123');
    expect(readExpandedResult('session-123', storage)).toBe('balanced');
    expect(readExpandedResult('session-456', storage)).toBeNull();
  });

  function renderResult(storage: KeyValueStorage, onCta: (expanding: boolean) => void): string {
    vi.stubGlobal('window', { localStorage: storage, location: { pathname: '/', search: '' } });
    const state = sessionState(v3Config, 'B');
    const step = state.funnel.steps.result as Extract<Step, { type: 'result' }>;
    return renderToStaticMarkup(
      createElement(ResultStep, {
        step,
        sessionId: state.session.id,
        result: state.result,
        failed: false,
        error: null,
        headingRef: null,
        onRetry: noop,
        onCta,
      }),
    );
  }

  it('keeps the action list open after a refresh without offering the CTA again', () => {
    const storage = memoryStorage();
    const onCta = vi.fn();
    expect(renderResult(storage, onCta)).toContain('Open the implementation details</button>');

    storage.setItem(expandedKey('session-123'), 'balanced');
    const html = renderResult(storage, onCta);

    expect(html).toContain('class="action-list"');
    expect(html).toContain('Agree where decisions are recorded.');
    expect(html).not.toContain('</button>');
    expect(onCta).not.toHaveBeenCalled();
  });

  it('does not reuse the expansion of a different result', () => {
    const storage = memoryStorage();
    storage.setItem(expandedKey('session-123'), 'regulated_scale');
    const html = renderResult(storage, vi.fn());

    expect(html).not.toContain('class="action-list"');
    expect(html).toContain('Open the implementation details</button>');
  });
});
