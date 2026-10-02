import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { buildApp } from '../src/server/app';
import { openDatabase } from '../src/server/db';
import type { AdminOverview, CreateSessionRequest, SessionState } from '../src/shared/api';
import { isInteractive } from '../src/shared/config';
import { nextStepId } from '../src/shared/engine';

export const CONFIGS_DIR = fileURLToPath(new URL('../configs', import.meta.url));

export const START_TIME = '2026-01-05T09:00:00.000Z';

export type Clock = { now: () => Date; advanceHours: (hours: number) => void };

export type TestApp = { app: FastifyInstance; db: DatabaseSync; clock: Clock };

export const V1_HYBRID_ANSWERS = {
  team_size: 12,
  work_mode: 'hybrid',
  priorities: ['focus', 'speed'],
  timezone_span: 'same',
  office_days: 2,
  async_maturity: 'medium',
  tool_count: 8,
};

export const V3_COMPLIANCE_ANSWERS = {
  team_size: 40,
  work_mode: 'remote',
  priorities: ['compliance', 'speed'],
  security_constraints: 'strict',
  timezone_span: 'same',
  meeting_hours: 6,
  async_maturity: 'medium',
  tool_count: 9,
};

export function createClock(start = START_TIME): Clock {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advanceHours: (hours) => {
      current += hours * 60 * 60 * 1000;
    },
  };
}

export async function createTestApp(options: { adminToken?: string; db?: DatabaseSync } = {}): Promise<TestApp> {
  const db = options.db ?? openDatabase(':memory:');
  const clock = createClock();
  const app = await buildApp({ db, configsDir: CONFIGS_DIR, now: clock.now, adminToken: options.adminToken });
  return { app, db, clock };
}

export function readFixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${CONFIGS_DIR}/${file}`, 'utf8')) as Record<string, unknown>;
}

export function post(app: FastifyInstance, url: string, payload?: object, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, payload, headers });
}

function expectOk(response: LightMyRequestResponse): SessionState {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SessionState>();
}

export async function createSession(app: FastifyInstance, body: CreateSessionRequest = {}): Promise<SessionState> {
  return expectOk(await post(app, '/api/sessions', body));
}

export async function answerStep(app: FastifyInstance, sessionId: string, stepId: string, value: unknown) {
  return expectOk(await post(app, `/api/sessions/${sessionId}/answers`, { stepId, value }));
}

export async function navigateTo(app: FastifyInstance, sessionId: string, stepId: string) {
  return expectOk(await post(app, `/api/sessions/${sessionId}/navigate`, { stepId }));
}

export async function requestResult(app: FastifyInstance, sessionId: string) {
  return expectOk(await post(app, `/api/sessions/${sessionId}/result`));
}

export async function advanceUntil(
  app: FastifyInstance,
  state: SessionState,
  answers: Record<string, unknown>,
  stopAtStepId: string,
): Promise<SessionState> {
  let current = state;
  while (current.currentStepId !== stopAtStepId) {
    const step = current.funnel.steps[current.currentStepId];
    if (step.type === 'result') throw new Error(`Reached the result before ${stopAtStepId}.`);
    if (isInteractive(step)) {
      if (!(step.input.name in answers)) throw new Error(`No test answer for ${step.input.name}.`);
      current = await answerStep(app, current.session.id, step.id, answers[step.input.name]);
    } else {
      const next = nextStepId(current.funnel, current.answers, step.id);
      if (!next) throw new Error(`No step after ${step.id}.`);
      current = await navigateTo(app, current.session.id, next);
    }
  }
  return current;
}

export async function completeFunnel(
  app: FastifyInstance,
  state: SessionState,
  answers: Record<string, unknown>,
): Promise<SessionState> {
  const resultStep = state.funnel.sequence[state.funnel.sequence.length - 1];
  const atResult = await advanceUntil(app, state, answers, resultStep);
  return requestResult(app, atResult.session.id);
}

export async function adminPost(app: FastifyInstance, url: string, token?: string) {
  return post(app, `/api/admin${url}`, undefined, token ? { 'x-admin-token': token } : {});
}

export async function importAndPublishV3(app: FastifyInstance, token?: string): Promise<AdminOverview> {
  const imported = await adminPost(app, '/fixtures/funnel-v3.json/import', token);
  expect(imported.statusCode, imported.body).toBe(201);
  const published = await adminPost(app, '/versions/3/publish', token);
  expect(published.statusCode, published.body).toBe(200);
  return published.json<AdminOverview>();
}

export async function rollbackVersion(app: FastifyInstance, token?: string): Promise<AdminOverview> {
  const response = await adminPost(app, '/rollback', token);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AdminOverview>();
}

export function countRows(db: DatabaseSync, table: 'events' | 'sessions' | 'ingest_batches'): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
