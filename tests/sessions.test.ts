import { describe, expect, it } from 'vitest';
import type { ApiError, SessionState } from '../src/shared/api';
import {
  V1_HYBRID_ANSWERS,
  advanceUntil,
  answerStep,
  completeFunnel,
  createSession,
  createTestApp,
  navigateTo,
  post,
  requestResult,
} from './helpers';

describe('session lifecycle', () => {
  it('creates a session on the active version that starts at the intro', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app, { utm: { source: 'google', campaign: 'spring' }, runId: 'run-1' });

    expect(state.resumed).toBe(false);
    expect(state.currentStepId).toBe('intro');
    expect(state.answers).toEqual({});
    expect(state.resultId).toBeNull();
    expect(state.session.version).toBe(1);
    expect(state.session.assignmentSource).toBe('hash');
    expect(state.session.utm).toEqual({ source: 'google', medium: null, campaign: 'spring' });
    expect(state.session.runId).toBe('run-1');
    expect(state.funnel.sequence[0]).toBe('intro');
    expect(state.funnel.variant).toBe(state.session.variant);
  });

  it('moves from the intro to the first question of the variant', async () => {
    const { app } = await createTestApp();
    const a = await createSession(app, { variant: 'A' });
    const b = await createSession(app, { variant: 'B' });

    expect((await navigateTo(app, a.session.id, 'team_size')).currentStepId).toBe('team_size');
    expect((await navigateTo(app, b.session.id, 'work_mode')).currentStepId).toBe('work_mode');
  });

  it('rejects an invalid answer with the message from the config', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    await navigateTo(app, state.session.id, 'team_size');

    const tooSmall = await post(app, `/api/sessions/${state.session.id}/answers`, { stepId: 'team_size', value: 0 });
    expect(tooSmall.statusCode).toBe(422);
    expect(tooSmall.json<ApiError>()).toMatchObject({
      error: 'invalid_answer',
      message: 'The team must have at least one person.',
      details: { code: 'min' },
    });

    const empty = await post(app, `/api/sessions/${state.session.id}/answers`, { stepId: 'team_size', value: '' });
    expect(empty.json<ApiError>()).toMatchObject({ message: 'Enter the team size.', details: { code: 'required' } });

    const notWhole = await post(app, `/api/sessions/${state.session.id}/answers`, { stepId: 'team_size', value: 2.5 });
    expect(notWhole.json<ApiError>().details).toEqual({ code: 'step' });

    const normalised = await answerStep(app, state.session.id, 'team_size', ' 3 ');
    expect(normalised.answers.team_size).toBe(3);
    await answerStep(app, state.session.id, 'work_mode', 'remote');
    const fourPriorities = await post(app, `/api/sessions/${state.session.id}/answers`, {
      stepId: 'priorities',
      value: ['speed', 'focus', 'culture', 'cost'],
    });
    expect(fourPriorities.json<ApiError>()).toMatchObject({
      message: 'Choose no more than three priorities.',
      details: { code: 'maxSelections' },
    });
  });

  it('refuses to skip ahead of unanswered steps', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });

    const skipAnswer = await post(app, `/api/sessions/${state.session.id}/answers`, { stepId: 'work_mode', value: 'remote' });
    expect(skipAnswer.statusCode).toBe(409);
    expect(skipAnswer.json<ApiError>().error).toBe('step_not_available');

    const skipNavigate = await post(app, `/api/sessions/${state.session.id}/navigate`, { stepId: 'result' });
    expect(skipNavigate.statusCode).toBe(409);

    const unknownStep = await post(app, `/api/sessions/${state.session.id}/navigate`, { stepId: 'constructor' });
    expect(unknownStep.statusCode).toBe(409);
  });

  it('skips a hidden conditional step and refuses answers for it', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    const remoteAnswers = { ...V1_HYBRID_ANSWERS, work_mode: 'remote' };
    const atTimezone = await advanceUntil(app, state, remoteAnswers, 'timezone_span');

    const afterTimezone = await answerStep(app, atTimezone.session.id, 'timezone_span', 'same');
    expect(afterTimezone.currentStepId).toBe('async_maturity');

    const hidden = await post(app, `/api/sessions/${state.session.id}/answers`, { stepId: 'office_days', value: 2 });
    expect(hidden.statusCode).toBe(409);
    expect(hidden.json<ApiError>().error).toBe('step_not_available');
  });

  it('keeps answers when the user goes back', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    const atPriorities = await advanceUntil(app, state, V1_HYBRID_ANSWERS, 'priorities');

    const back = await navigateTo(app, state.session.id, 'work_mode');
    expect(back.currentStepId).toBe('work_mode');
    expect(back.answers).toEqual(atPriorities.answers);
    expect(back.answers).toMatchObject({ team_size: 12, work_mode: 'hybrid' });

    const forward = await answerStep(app, state.session.id, 'work_mode', 'hybrid');
    expect(forward.currentStepId).toBe('priorities');
  });

  it('restores the same state on refresh', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app);
    const progressed = await advanceUntil(app, state, V1_HYBRID_ANSWERS, 'priorities');

    const resumed = await createSession(app, { sessionId: state.session.id });
    expect(resumed.resumed).toBe(true);
    expect(resumed.session).toEqual(progressed.session);
    expect(resumed.answers).toEqual(progressed.answers);
    expect(resumed.currentStepId).toBe('priorities');

    const fetched = await app.inject({ method: 'GET', url: `/api/sessions/${state.session.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<SessionState>().currentStepId).toBe('priorities');
  });

  it('computes the result on the server', async () => {
    const { app } = await createTestApp();
    const a = await completeFunnel(app, await createSession(app, { variant: 'A' }), V1_HYBRID_ANSWERS);
    expect(a.resultId).toBe('hybrid_structured');
    expect(a.currentStepId).toBe('result');
    expect(a.result?.title).toBe('Structured hybrid');

    const b = await completeFunnel(app, await createSession(app, { variant: 'B' }), V1_HYBRID_ANSWERS);
    expect(b.resultId).toBe('hybrid_structured');
    expect(b.result?.title).toBe('Your hybrid model needs clearer rules');
  });

  it('refuses a result while answers are missing', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    await advanceUntil(app, state, V1_HYBRID_ANSWERS, 'priorities');

    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${state.session.id}/result`,
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<ApiError>()).toMatchObject({
      error: 'incomplete',
      details: { missing: ['priorities', 'timezone_span', 'office_days', 'async_maturity', 'tool_count'] },
    });
  });

  it('clears the result when an earlier answer changes and keeps hidden answers stored', async () => {
    const { app } = await createTestApp();
    const done = await completeFunnel(app, await createSession(app, { variant: 'A' }), V1_HYBRID_ANSWERS);
    const id = done.session.id;

    await navigateTo(app, id, 'work_mode');
    const sameAnswer = await answerStep(app, id, 'work_mode', 'hybrid');
    expect(sameAnswer.resultId).toBe('hybrid_structured');

    const changed = await answerStep(app, id, 'work_mode', 'remote');
    expect(changed.resultId).toBeNull();
    expect(changed.result).toBeNull();
    expect(changed.answers.office_days).toBe(2);

    const recomputed = await requestResult(app, id);
    expect(recomputed.resultId).toBe('balanced');
  });

  it('starts a new session once the old one expired', async () => {
    const { app, clock } = await createTestApp();
    const state = await createSession(app);

    clock.advanceHours(71);
    expect((await createSession(app, { sessionId: state.session.id })).session.id).toBe(state.session.id);

    clock.advanceHours(1);
    const fresh = await createSession(app, { sessionId: state.session.id });
    expect(fresh.resumed).toBe(false);
    expect(fresh.session.id).not.toBe(state.session.id);
    expect(fresh.currentStepId).toBe('intro');

    const expired = await app.inject({ method: 'GET', url: `/api/sessions/${state.session.id}` });
    expect(expired.statusCode).toBe(410);
    expect(expired.json<ApiError>().error).toBe('session_expired');
  });

  it('answers 404 for an unknown session and for unknown API routes', async () => {
    const { app } = await createTestApp();
    const missing = await app.inject({ method: 'GET', url: '/api/sessions/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ApiError>().error).toBe('session_not_found');

    const unknownSessionId = await createSession(app, { sessionId: 'nope' });
    expect(unknownSessionId.session.id).not.toBe('nope');

    const unknownRoute = await app.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(unknownRoute.statusCode).toBe(404);
    expect(unknownRoute.json<ApiError>().error).toBe('not_found');
  });

  it('rejects a malformed create request', async () => {
    const { app } = await createTestApp();
    const response = await post(app, '/api/sessions', { sessionId: 42 });
    expect(response.statusCode).toBe(400);
    expect(response.json<ApiError>().error).toBe('invalid_request');
  });

  it('drops __proto__ keys from a request body and handles the rest', async () => {
    const { app } = await createTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      payload: '{"__proto__":{"variant":"B"},"utm":{"campaign":"spring","__proto__":{"source":"x"}}}',
    });

    expect(response.statusCode, response.body).toBe(200);
    const state = response.json<SessionState>();
    expect(state.session.assignmentSource).toBe('hash');
    expect(state.session.utm).toEqual({ source: null, medium: null, campaign: 'spring' });
  });
});

describe('variant override', () => {
  it('creates a session with the requested variant', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app, { variant: 'B' });
    expect(state.session.variant).toBe('B');
    expect(state.session.assignmentSource).toBe('override');
    expect(state.funnel.steps.intro.content.title).toBe('How should your team really work?');
  });

  it('ignores an unknown override value', async () => {
    const { app } = await createTestApp();
    for (const variant of ['C', 'b', 'constructor', '']) {
      const state = await createSession(app, { variant });
      expect(state.session.assignmentSource).toBe('hash');
      expect(['A', 'B']).toContain(state.session.variant);
    }
  });

  it('resumes when the override matches and starts over when it differs', async () => {
    const { app } = await createTestApp();
    const a = await createSession(app, { variant: 'A' });

    const same = await createSession(app, { sessionId: a.session.id, variant: 'A' });
    expect(same.resumed).toBe(true);
    expect(same.session.id).toBe(a.session.id);

    const switched = await createSession(app, { sessionId: a.session.id, variant: 'B' });
    expect(switched.resumed).toBe(false);
    expect(switched.session.id).not.toBe(a.session.id);
    expect(switched.session.variant).toBe('B');
    expect(switched.session.assignmentSource).toBe('override');

    const ignored = await createSession(app, { sessionId: a.session.id, variant: 'Z' });
    expect(ignored.session.id).toBe(a.session.id);
  });
});
