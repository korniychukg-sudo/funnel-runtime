import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MAX_EVENTS_PER_BATCH, type ApiError, type EventsResponse, type IncomingEvent, type SessionState } from '../src/shared/api';
import { adminPost, countRows, createSession, createTestApp, post, readFixture } from './helpers';

function stepViewed(state: SessionState, overrides: Partial<IncomingEvent> = {}): IncomingEvent {
  return {
    event_id: randomUUID(),
    session_id: state.session.id,
    name: 'step_viewed',
    client_timestamp: new Date().toISOString(),
    step_id: state.currentStepId,
    funnel_id: state.session.funnelId,
    funnel_version: state.session.version,
    experiment_id: state.session.experimentId,
    variant: state.session.variant,
    properties: { step_type: 'info', visible_step_index: null, visible_step_count: 7 },
    ...overrides,
  };
}

async function sendEvents(app: Parameters<typeof post>[0], events: unknown[]): Promise<EventsResponse> {
  const response = await post(app, '/api/events', { events });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<EventsResponse>();
}

function storedEvent(db: DatabaseSync, eventId: string) {
  return db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as Record<string, unknown>;
}

function storedProperties(db: DatabaseSync, eventId: string): Record<string, unknown> {
  return JSON.parse(storedEvent(db, eventId).properties_json as string) as Record<string, unknown>;
}

function reasons(response: EventsResponse): string[] {
  return response.results.map((result) => result.reason ?? result.status);
}

describe('event ingestion', () => {
  it('writes session_started on the server when a session is created', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app, { utm: { source: 'google', medium: 'cpc', campaign: 'spring' } });

    const row = storedEvent(db, `${state.session.id}:session_started`);
    expect(row).toMatchObject({
      session_id: state.session.id,
      name: 'session_started',
      step_id: null,
      client_ts: null,
      funnel_version: 1,
      variant: state.session.variant,
      utm_campaign: 'spring',
    });
    expect(countRows(db, 'events')).toBe(1);
  });

  it('stores a re-sent batch only once', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app);
    const batch = [stepViewed(state), stepViewed(state), stepViewed(state)];

    const first = await sendEvents(app, batch);
    expect(first).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 });
    const rowsAfterFirst = countRows(db, 'events');

    const second = await sendEvents(app, batch);
    expect(second).toMatchObject({ accepted: 0, duplicates: 3, rejected: 0 });
    expect(second.results.map((result) => result.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(countRows(db, 'events')).toBe(rowsAfterFirst);
  });

  it('keeps the first write when an event id repeats inside one batch', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app);
    const original = stepViewed(state);
    const repeat = { ...original, properties: { step_type: 'changed' } };

    const response = await sendEvents(app, [original, repeat]);
    expect(response.results.map((result) => result.status)).toEqual(['accepted', 'duplicate']);
    expect(JSON.parse(storedEvent(db, original.event_id).properties_json as string).step_type).toBe('info');
  });

  it('rejects bad items one by one and stores the rest', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    const valid = stepViewed(state);
    const missingId = { ...stepViewed(state), event_id: undefined };

    const response = await sendEvents(app, [
      valid,
      missingId,
      42,
      stepViewed(state, { client_timestamp: 'yesterday' }),
      stepViewed(state, { session_id: 'no-such-session' }),
      stepViewed(state, { name: 'purchase_completed' }),
      stepViewed(state, { name: 'recommendation_expanded' }),
      stepViewed(state, { name: 'session_started' }),
      stepViewed(state, { variant: 'B' }),
      stepViewed(state, { funnel_version: 3 }),
      stepViewed(state, { step_id: 'meeting_hours' }),
      stepViewed(state, { step_id: null }),
    ]);

    expect(response.accepted).toBe(1);
    expect(response.rejected).toBe(11);
    expect(response.results.map((result) => result.reason ?? result.status)).toEqual([
      'accepted',
      'invalid_event',
      'invalid_event',
      'invalid_event',
      'unknown_session',
      'event_not_allowed',
      'event_not_allowed',
      'server_only',
      'context_mismatch',
      'context_mismatch',
      'unknown_step',
      'unknown_step',
    ]);
    expect(response.results[1].event_id).toBeNull();
    expect(response.results[4].event_id).toBeTypeOf('string');
    expect(countRows(db, 'events')).toBe(2);
  });

  it('drops properties that the pinned config does not list', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    const event = stepViewed(state, {
      name: 'answer_submitted',
      step_id: 'team_size',
      properties: { answer_kind: 'number', value: 12, team_size: 12 },
    });

    await sendEvents(app, [event]);
    expect(JSON.parse(storedEvent(db, event.event_id).properties_json as string)).toEqual({ answer_kind: 'number' });
  });

  it('stamps context and first-touch UTM from the session', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app, { variant: 'B', utm: { source: 'google', campaign: 'spring' } });
    const event = {
      event_id: randomUUID(),
      session_id: state.session.id,
      name: 'step_viewed',
      client_timestamp: '2026-01-05T09:00:01.000+03:00',
      step_id: 'intro',
      utm_source: 'newsletter',
      utm_campaign: 'autumn',
    };

    await sendEvents(app, [event]);
    expect(storedEvent(db, event.event_id)).toMatchObject({
      funnel_id: 'workstyle-planner',
      funnel_version: 1,
      experiment_id: 'question-order-and-result-framing-v1',
      variant: 'B',
      utm_source: 'google',
      utm_medium: null,
      utm_campaign: 'spring',
      client_ts: '2026-01-05T09:00:01.000+03:00',
      properties_json: '{"step_type":"info"}',
    });
  });

  it('stamps step_type and answer_kind from the step and ignores the client values', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    const viewed = stepViewed(state, {
      step_id: 'team_size',
      properties: { step_type: 'result', visible_step_index: 0, visible_step_count: 7 },
    });
    const viewedBare = stepViewed(state, { step_id: 'work_mode', properties: undefined });
    const answered = stepViewed(state, {
      name: 'answer_submitted',
      step_id: 'priorities',
      properties: { answer_kind: { raw: ['speed', 'focus'] } },
    });

    const response = await sendEvents(app, [viewed, viewedBare, answered]);
    expect(response.accepted).toBe(3);
    expect(storedProperties(db, viewed.event_id)).toEqual({ step_type: 'number', visible_step_index: 0, visible_step_count: 7 });
    expect(storedProperties(db, viewedBare.event_id)).toEqual({ step_type: 'single-select' });
    expect(storedProperties(db, answered.event_id)).toEqual({ answer_kind: 'multi-select' });
  });

  it('stamps the step type of the variant-resolved step', async () => {
    const { app, db } = await createTestApp();
    const config = readFixture('funnel-v1.json') as { experiment: { variants: Record<string, { stepOverrides: object }> } };
    config.experiment.variants.B.stepOverrides = {
      team_size: { type: 'single-select', input: { options: [{ value: 'small', label: 'Small' }] } },
    };
    const uploaded = await post(app, '/api/admin/versions', { config: { ...config, version: 2 } });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect((await adminPost(app, '/versions/2/publish')).statusCode).toBe(200);

    const a = await createSession(app, { variant: 'A' });
    const b = await createSession(app, { variant: 'B' });
    const events = [a, b].map((state) => stepViewed(state, { step_id: 'team_size', properties: { step_type: 'number' } }));

    expect((await sendEvents(app, events)).accepted).toBe(2);
    expect(storedProperties(db, events[0].event_id).step_type).toBe('number');
    expect(storedProperties(db, events[1].event_id).step_type).toBe('single-select');
  });

  it('rejects property values that are not short primitives or known references', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    const event = (name: string, stepId: string, properties: Record<string, unknown>) =>
      stepViewed(state, { name, step_id: stepId, properties });

    const response = await sendEvents(app, [
      event('result_viewed', 'result', { result_id: 'balanced' }),
      event('result_viewed', 'result', { result_id: 'meeting_heavy' }),
      event('result_viewed', 'result', { result_id: 'constructor' }),
      event('result_viewed', 'result', { result_id: null }),
      event('cta_clicked', 'result', { result_id: 'balanced', action: true, extra: { nested: [1] } }),
      event('cta_clicked', 'result', { result_id: 'balanced', action: { href: 'https://example.com' } }),
      event('cta_clicked', 'result', { result_id: 'balanced', action: 'x'.repeat(257) }),
      event('cta_clicked', 'result', { result_id: 'balanced', action: ['a'] }),
      event('step_completed', 'team_size', { next_step_id: 'work_mode' }),
      event('step_completed', 'team_size', { next_step_id: 'meeting_hours' }),
      event('back_clicked', 'work_mode', { destination_step_id: 'team_size' }),
      event('back_clicked', 'work_mode', { destination_step_id: 7 }),
      event('step_viewed', 'intro', { visible_step_index: null, visible_step_count: 7 }),
      event('step_viewed', 'team_size', { visible_step_index: 1.5 }),
      event('step_viewed', 'team_size', { visible_step_count: -1 }),
      event('step_viewed', 'team_size', { visible_step_index: '1' }),
    ]);

    expect(reasons(response)).toEqual([
      'accepted',
      'invalid_property',
      'invalid_property',
      'invalid_property',
      'accepted',
      'invalid_property',
      'invalid_property',
      'invalid_property',
      'accepted',
      'invalid_property',
      'accepted',
      'invalid_property',
      'accepted',
      'invalid_property',
      'invalid_property',
      'invalid_property',
    ]);
    expect(storedProperties(db, response.results[4].event_id!)).toEqual({ result_id: 'balanced', action: true });
  });

  it('rejects a property number that is not finite', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    const event = stepViewed(state, { name: 'cta_clicked', step_id: 'result', properties: { result_id: 'balanced', action: 0 } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ events: [event] }).replace('"action":0', '"action":1e999'),
    });

    expect(response.statusCode).toBe(200);
    expect(reasons(response.json<EventsResponse>())).toEqual(['invalid_property']);
  });

  it('strips __proto__ and constructor.prototype keys instead of failing the batch', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app, { variant: 'A' });
    const poisoned = stepViewed(state, { step_id: 'team_size', properties: { visible_step_count: 7 } });
    const clean = stepViewed(state, { step_id: 'work_mode' });
    const body = JSON.stringify({ events: [poisoned, clean] }).replace(
      '"properties":{"visible_step_count":7}',
      '"properties":{"visible_step_count":7,"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}}}',
    );
    expect(body).toContain('__proto__');

    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'content-type': 'application/json' },
      payload: `{"__proto__":{"events":[]},${body.slice(1)}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<EventsResponse>()).toMatchObject({ accepted: 2, rejected: 0 });
    expect(storedProperties(db, poisoned.event_id)).toEqual({ step_type: 'number', visible_step_count: 7 });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('stamps the result step on result events and sets the server time', async () => {
    const { app, db, clock } = await createTestApp();
    const state = await createSession(app);
    clock.advanceHours(1);
    const event = stepViewed(state, { name: 'result_viewed', step_id: undefined, properties: { result_id: 'balanced' } });

    await sendEvents(app, [event]);
    expect(storedEvent(db, event.event_id)).toMatchObject({ step_id: 'result', server_ts: '2026-01-05T10:00:00.000Z' });
  });

  it('accepts late events for an expired session', async () => {
    const { app, clock } = await createTestApp();
    const state = await createSession(app);
    clock.advanceHours(100);

    const response = await sendEvents(app, [stepViewed(state)]);
    expect(response.accepted).toBe(1);
  });

  it('records the counts of every batch', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app);
    const batch = [stepViewed(state), stepViewed(state, { name: 'nope' })];

    await sendEvents(app, batch);
    await sendEvents(app, batch);
    await sendEvents(app, []);

    const rows = db.prepare('SELECT total, accepted, duplicates, rejected FROM ingest_batches ORDER BY id').all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { total: 2, accepted: 1, duplicates: 0, rejected: 1 },
      { total: 2, accepted: 0, duplicates: 1, rejected: 1 },
      { total: 0, accepted: 0, duplicates: 0, rejected: 0 },
    ]);
  });

  it('answers 400 for a body that is not a batch', async () => {
    const { app, db } = await createTestApp();
    const state = await createSession(app);
    const tooMany = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => stepViewed(state));

    for (const body of [{ events: 'nope' }, { items: [] }, [stepViewed(state)], { events: tooMany }]) {
      const response = await post(app, '/api/events', body);
      expect(response.statusCode).toBe(400);
      expect(response.json<ApiError>().error).toBe('invalid_batch');
    }
    expect(countRows(db, 'ingest_batches')).toBe(0);

    const notJson = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'content-type': 'application/json' },
      payload: '{"events": [',
    });
    expect(notJson.statusCode).toBe(400);
  });

  it('answers 413 for a body over 1 MB', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app);
    const huge = stepViewed(state, { properties: { padding: 'x'.repeat(1024 * 1024) } });

    const response = await post(app, '/api/events', { events: [huge] });
    expect(response.statusCode).toBe(413);
    expect(response.json<ApiError>().error).toBe('payload_too_large');
  });
});
