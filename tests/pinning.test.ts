import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EventsResponse, SessionState } from '../src/shared/api';
import {
  V1_HYBRID_ANSWERS,
  V3_COMPLIANCE_ANSWERS,
  advanceUntil,
  answerStep,
  completeFunnel,
  createSession,
  createTestApp,
  importAndPublishV3,
  post,
  rollbackVersion,
} from './helpers';

function recommendationExpanded(state: SessionState) {
  return {
    event_id: randomUUID(),
    session_id: state.session.id,
    name: 'recommendation_expanded',
    client_timestamp: new Date().toISOString(),
    properties: { result_id: state.resultId, action: 'expand_recommendation', source: 'result_cta' },
  };
}

describe('version pinning', () => {
  it('keeps an old session on its version after a new one is published', async () => {
    const { app } = await createTestApp();
    const old = await createSession(app, { variant: 'B' });
    await advanceUntil(app, old, V1_HYBRID_ANSWERS, 'team_size');

    const overview = await importAndPublishV3(app);
    expect(overview.activeVersion).toBe(3);

    const resumed = await createSession(app, { sessionId: old.session.id });
    expect(resumed.resumed).toBe(true);
    expect(resumed.session.version).toBe(1);
    expect(resumed.session.experimentId).toBe('question-order-and-result-framing-v1');
    expect(resumed.funnel.version).toBe(1);
    expect(resumed.funnel.sequence).toContain('tool_count');
    expect(resumed.funnel.sequence).not.toContain('meeting_hours');
    expect(resumed.currentStepId).toBe('team_size');

    const fresh = await createSession(app, { variant: 'B' });
    expect(fresh.session.version).toBe(3);
    expect(fresh.funnel.sequence).not.toContain('tool_count');
    expect(fresh.funnel.sequence).toContain('meeting_hours');

    const finished = await completeFunnel(app, resumed, V1_HYBRID_ANSWERS);
    expect(finished.session.version).toBe(1);
    expect(finished.resultId).toBe('hybrid_structured');
    expect(finished.result?.title).toBe('Your hybrid model needs clearer rules');
    expect(Object.keys(finished.funnel.results)).not.toContain('meeting_heavy');
  });

  it('lets a new session run the v3 branch to a v3-only result', async () => {
    const { app } = await createTestApp();
    await importAndPublishV3(app);

    const state = await createSession(app, { variant: 'A' });
    const atSecurity = await advanceUntil(app, state, V3_COMPLIANCE_ANSWERS, 'security_constraints');
    expect(atSecurity.funnel.steps.security_constraints.visibleWhen).toBeDefined();

    const done = await completeFunnel(app, atSecurity, V3_COMPLIANCE_ANSWERS);
    expect(done.resultId).toBe('regulated_scale');
  });

  it('accepts the v3-only event only from v3 sessions', async () => {
    const { app } = await createTestApp();
    const v1 = await completeFunnel(app, await createSession(app), V1_HYBRID_ANSWERS);
    await importAndPublishV3(app);
    const v3 = await completeFunnel(app, await createSession(app), V3_COMPLIANCE_ANSWERS);

    const response = await post(app, '/api/events', { events: [recommendationExpanded(v1), recommendationExpanded(v3)] });
    expect(response.statusCode).toBe(200);
    const body = response.json<EventsResponse>();
    expect(body.results[0]).toMatchObject({ status: 'rejected', reason: 'event_not_allowed' });
    expect(body.results[1]).toMatchObject({ status: 'accepted' });
  });

  it('keeps a v3 session on v3 after a rollback while new sessions use v1', async () => {
    const { app } = await createTestApp();
    await importAndPublishV3(app);
    const v3 = await createSession(app, { variant: 'B' });
    await advanceUntil(app, v3, V3_COMPLIANCE_ANSWERS, 'meeting_hours');

    const overview = await rollbackVersion(app);
    expect(overview.activeVersion).toBe(1);

    const resumed = await createSession(app, { sessionId: v3.session.id });
    expect(resumed.resumed).toBe(true);
    expect(resumed.session.version).toBe(3);
    expect(resumed.currentStepId).toBe('meeting_hours');

    const answered = await answerStep(app, v3.session.id, 'meeting_hours', 20);
    expect(answered.currentStepId).toBe('timezone_span');
    const done = await completeFunnel(app, answered, V3_COMPLIANCE_ANSWERS);
    expect(done.session.version).toBe(3);
    expect(done.resultId).toBe('regulated_scale');

    const fresh = await createSession(app);
    expect(fresh.session.version).toBe(1);
  });
});
