import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdminOverview, ApiError, EventsResponse, VersionSummary } from '../src/shared/api';
import { openDatabase } from '../src/server/db';
import { purgeExpiredAnswers } from '../src/server/store';
import {
  V1_HYBRID_ANSWERS,
  V3_COMPLIANCE_ANSWERS,
  adminPost,
  advanceUntil,
  countRows,
  createSession,
  createTestApp,
  importAndPublishV3,
  post,
  readFixture,
  rollbackVersion,
} from './helpers';

async function overview(app: Parameters<typeof post>[0], token?: string) {
  return app.inject({ method: 'GET', url: '/api/admin/overview', headers: token ? { 'x-admin-token': token } : {} });
}

function summaryOf(state: AdminOverview, version: number): VersionSummary | undefined {
  return state.versions.find((summary) => summary.version === version);
}

describe('seeding', () => {
  it('seeds v1 as the active version of an empty database', async () => {
    const { app } = await createTestApp();

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true, activeVersion: 1 });

    const active = await app.inject({ method: 'GET', url: '/api/funnel/active' });
    expect(active.json()).toEqual({
      version: 1,
      funnelId: 'workstyle-planner',
      title: "Find your team's operating style",
      experimentId: 'question-order-and-result-framing-v1',
      variants: ['A', 'B'],
    });

    const state = (await overview(app)).json<AdminOverview>();
    expect(state.activeVersion).toBe(1);
    expect(state.rollbackTarget).toBeNull();
    expect(state.versions).toHaveLength(1);
    expect(summaryOf(state, 1)).toMatchObject({ status: 'published', isActive: true, variants: ['A', 'B'] });
    expect(state.activations).toMatchObject([{ version: 1, action: 'seed', fromVersion: null }]);
    expect(state.fixtures).toEqual(expect.arrayContaining(['funnel-v1.json', 'funnel-v3.json']));
    expect(state.adminTokenRequired).toBe(false);
  });

  it('does not seed twice when the app restarts on the same database', async () => {
    const first = await createTestApp();
    await first.app.close();
    const second = await createTestApp({ db: first.db });

    const state = (await overview(second.app)).json<AdminOverview>();
    expect(state.activations).toHaveLength(1);
    expect(state.versions).toHaveLength(1);
  });
});

describe('publish and rollback', () => {
  it('walks through import, publish, rollback and roll forward', async () => {
    const { app } = await createTestApp();

    const imported = await adminPost(app, '/fixtures/funnel-v3.json/import');
    expect(imported.statusCode).toBe(201);
    expect(imported.json<VersionSummary>()).toMatchObject({
      version: 3,
      status: 'draft',
      isActive: false,
      releaseNote: 'Adds a compliance branch, shortens variant B and introduces recommendation_expanded.',
      experimentId: 'question-order-and-result-framing-v3',
    });
    expect((await createSession(app)).session.version).toBe(1);

    const published = (await adminPost(app, '/versions/3/publish')).json<AdminOverview>();
    expect(published.activeVersion).toBe(3);
    expect(published.rollbackTarget).toBe(1);
    expect(summaryOf(published, 3)).toMatchObject({ status: 'published', isActive: true });
    expect(summaryOf(published, 3)?.publishedAt).toBeTypeOf('string');
    expect((await createSession(app)).session.version).toBe(3);

    const publishAgain = await adminPost(app, '/versions/3/publish');
    expect(publishAgain.statusCode).toBe(409);
    expect(publishAgain.json<ApiError>().error).toBe('not_draft');

    const rolledBack = await rollbackVersion(app);
    expect(rolledBack.activeVersion).toBe(1);
    expect(rolledBack.rollbackTarget).toBeNull();
    expect(summaryOf(rolledBack, 3)).toMatchObject({ status: 'rolled_back', isActive: false });
    expect(summaryOf(rolledBack, 1)).toMatchObject({ status: 'published', isActive: true });
    expect((await createSession(app)).session.version).toBe(1);

    const nothingLeft = await adminPost(app, '/rollback');
    expect(nothingLeft.statusCode).toBe(409);
    expect(nothingLeft.json<ApiError>().error).toBe('nothing_to_rollback');

    const activated = await adminPost(app, '/versions/3/activate');
    expect(activated.statusCode).toBe(200);
    expect(activated.json<AdminOverview>().activeVersion).toBe(3);
    expect(summaryOf(activated.json<AdminOverview>(), 3)?.status).toBe('published');

    const activateActive = await adminPost(app, '/versions/3/activate');
    expect(activateActive.statusCode).toBe(409);
    expect(activateActive.json<ApiError>().error).toBe('not_activatable');

    const history = activated.json<AdminOverview>().activations;
    expect(history.map((entry) => [entry.action, entry.version, entry.fromVersion])).toEqual([
      ['seed', 1, null],
      ['publish', 3, 1],
      ['rollback', 1, 3],
      ['activate', 3, 1],
    ]);
  });

  it('refuses to activate a draft', async () => {
    const { app } = await createTestApp();
    await adminPost(app, '/fixtures/funnel-v3.json/import');

    const response = await adminPost(app, '/versions/3/activate');
    expect(response.statusCode).toBe(409);
    expect(response.json<ApiError>().error).toBe('not_activatable');
  });

  it('keeps sessions and events of a rolled back version', async () => {
    const { app, db } = await createTestApp();
    await importAndPublishV3(app);
    const state = await advanceUntil(app, await createSession(app), V3_COMPLIANCE_ANSWERS, 'priorities');
    const sent = await post(app, '/api/events', {
      events: [
        {
          event_id: 'v3-view-1',
          session_id: state.session.id,
          name: 'step_viewed',
          client_timestamp: new Date().toISOString(),
          step_id: 'priorities',
        },
      ],
    });
    expect(sent.json<EventsResponse>().accepted).toBe(1);
    const eventsBefore = countRows(db, 'events');

    const rolledBack = await rollbackVersion(app);
    expect(summaryOf(rolledBack, 3)).toMatchObject({ sessions: 1, events: 2 });
    expect(countRows(db, 'events')).toBe(eventsBefore);
    expect(countRows(db, 'sessions')).toBe(1);

    const resumed = await createSession(app, { sessionId: state.session.id });
    expect(resumed.session.version).toBe(3);
  });
});

describe('config upload', () => {
  it('refuses versions that already exist or are not newer', async () => {
    const { app } = await createTestApp();
    await importAndPublishV3(app);

    const v2 = await post(app, '/api/admin/versions', { config: { ...readFixture('funnel-v1.json'), version: 2 } });
    expect(v2.statusCode).toBe(409);
    expect(v2.json<ApiError>().error).toBe('version_not_newer');

    const again = await adminPost(app, '/fixtures/funnel-v3.json/import');
    expect(again.statusCode).toBe(409);
    expect(again.json<ApiError>().error).toBe('version_exists');

    const v4 = await post(app, '/api/admin/versions', { config: { ...readFixture('funnel-v3.json'), version: 4 } });
    expect(v4.statusCode).toBe(201);
    expect(v4.json<VersionSummary>()).toMatchObject({ version: 4, status: 'draft' });
  });

  it('refuses an invalid config with its issues', async () => {
    const { app } = await createTestApp();
    const config = readFixture('funnel-v3.json');
    const experiment = config.experiment as { variants: Record<string, { stepSequence: string[] }> };
    experiment.variants.B.stepSequence = ['intro', 'missing_step', 'result'];

    const response = await post(app, '/api/admin/versions', { config: { ...config, version: 5 } });
    expect(response.statusCode).toBe(422);
    const body = response.json<ApiError>();
    expect(body.error).toBe('invalid_config');
    expect(body.details).toEqual(
      expect.arrayContaining([{ path: 'experiment.variants.B.stepSequence.1', message: 'Unknown step "missing_step".' }]),
    );

    const noConfig = await post(app, '/api/admin/versions', {});
    expect(noConfig.statusCode).toBe(422);
  });

  it('stores the config without the file status and serves it back', async () => {
    const { app } = await createTestApp();
    await adminPost(app, '/fixtures/funnel-v3.json/import');

    const detail = await app.inject({ method: 'GET', url: '/api/admin/versions/3' });
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{ version: number; status: string; config: Record<string, unknown> }>();
    expect(body.status).toBe('draft');
    expect(body.config.version).toBe(3);
    expect(body.config).not.toHaveProperty('status');

    for (const url of ['/api/admin/versions/99', '/api/admin/versions/abc']) {
      const missing = await app.inject({ method: 'GET', url });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<ApiError>().error).toBe('version_not_found');
    }
  });

  it('only imports files listed as fixtures', async () => {
    const { app } = await createTestApp();
    for (const file of ['nope.json', '..%2Fpackage.json']) {
      const response = await adminPost(app, `/fixtures/${file}/import`);
      expect(response.statusCode).toBe(404);
      expect(response.json<ApiError>().error).toBe('fixture_not_found');
    }
  });
});

describe('admin token', () => {
  it('protects admin endpoints when a token is configured', async () => {
    const { app } = await createTestApp({ adminToken: 'secret' });

    expect((await overview(app)).statusCode).toBe(401);
    expect((await overview(app, 'wrong')).statusCode).toBe(401);
    expect((await adminPost(app, '/fixtures/funnel-v3.json/import')).statusCode).toBe(401);

    const allowed = await overview(app, 'secret');
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<AdminOverview>().adminTokenRequired).toBe(true);
    expect((await importAndPublishV3(app, 'secret')).activeVersion).toBe(3);

    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await createSession(app)).session.version).toBe(3);
  });
});

describe('storage', () => {
  it('applies migrations once and enables WAL on a file database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'funnel-db-'));
    try {
      const path = join(dir, 'funnel.db');
      openDatabase(path).close();
      const db = openDatabase(path);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('purges answers of expired sessions but keeps their events', async () => {
    const { app, db, clock } = await createTestApp();
    const expired = await advanceUntil(app, await createSession(app), V1_HYBRID_ANSWERS, 'priorities');
    clock.advanceHours(48);
    const live = await advanceUntil(app, await createSession(app), V1_HYBRID_ANSWERS, 'priorities');
    clock.advanceHours(30);

    expect(purgeExpiredAnswers(db, clock.now().toISOString())).toBe(1);
    const answers = (id: string) =>
      (db.prepare('SELECT answers_json FROM sessions WHERE id = ?').get(id) as { answers_json: string }).answers_json;
    expect(answers(expired.session.id)).toBe('{}');
    expect(JSON.parse(answers(live.session.id))).toEqual(live.answers);
    expect(countRows(db, 'events')).toBe(2);
  });

  it('rejects a non-numeric analytics version filter', async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/analytics?version=abc' });
    expect(response.statusCode).toBe(400);
    expect(response.json<ApiError>().error).toBe('invalid_query');
  });
});
