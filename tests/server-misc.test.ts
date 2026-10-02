import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveDbPath } from '../src/server/app';
import type { ApiError } from '../src/shared/api';
import { createTestApp } from './helpers';

const INDEX_HTML = '<!doctype html><title>Funnel</title><div id="root"></div>';

const staticDir = mkdtempSync(join(tmpdir(), 'funnel-static-'));
mkdirSync(join(staticDir, 'assets'));
writeFileSync(join(staticDir, 'index.html'), INDEX_HTML);
writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("app");');

afterAll(() => rmSync(staticDir, { recursive: true, force: true }));

describe('database path', () => {
  it('prefers DB_PATH, then the Railway volume, then ./data', () => {
    expect(resolveDbPath({ DB_PATH: '/srv/custom.db', RAILWAY_VOLUME_MOUNT_PATH: '/data' })).toBe('/srv/custom.db');
    expect(resolveDbPath({ RAILWAY_VOLUME_MOUNT_PATH: '/data' })).toBe(join('/data', 'funnel.db'));
    expect(resolveDbPath({ RAILWAY_VOLUME_MOUNT_PATH: '' })).toBe('./data/funnel.db');
    expect(resolveDbPath({})).toBe('./data/funnel.db');
  });
});

describe('static files and SPA fallback', () => {
  it('serves index.html for client routes', async () => {
    const { app } = await createTestApp({ staticDir });
    for (const url of ['/', '/admin', '/dashboard?run_id=abc', '/admin/versions/', '/v1.2/page']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toContain('text/html');
      expect(response.body, url).toBe(INDEX_HTML);
    }

    const head = await app.inject({ method: 'HEAD', url: '/admin' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toContain('text/html');
  });

  it('serves real assets', async () => {
    const { app } = await createTestApp({ staticDir });
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('javascript');
  });

  it('answers JSON 404 for missing files, API routes and other methods', async () => {
    const { app } = await createTestApp({ staticDir });
    const requests: [string, string][] = [
      ['GET', '/assets/missing.js'],
      ['GET', '/assets/chunk'],
      ['GET', '/assets'],
      ['GET', '/favicon.ico'],
      ['GET', '/admin/logo.png'],
      ['GET', '/api/nothing-here'],
      ['HEAD', '/api/nothing-here'],
      ['POST', '/admin'],
      ['DELETE', '/dashboard'],
    ];
    for (const [method, url] of requests) {
      const response = await app.inject({ method: method as 'GET', url });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.headers['content-type'], `${method} ${url}`).toContain('application/json');
      if (method !== 'HEAD') expect(response.json<ApiError>().error, `${method} ${url}`).toBe('not_found');
    }
  });

  it('answers JSON 404 for every unknown path when there is no client build', async () => {
    const { app } = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/admin' });
    expect(response.statusCode).toBe(404);
    expect(response.json<ApiError>().error).toBe('not_found');
  });
});
