import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { FunnelConfig } from '../shared/config';
import { registerAdminRoutes } from './routes/admin';
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerEventRoutes } from './routes/events';
import { HttpError } from './routes/http';
import { registerPublicRoutes } from './routes/public';
import { registerSessionRoutes } from './routes/sessions';
import { getVersion } from './store';
import { seedIfEmpty } from './versions';

export type BuildAppOptions = {
  db: DatabaseSync;
  configsDir: string;
  now?: () => Date;
  adminToken?: string | null;
  staticDir?: string | null;
  logger?: boolean;
};

export type AppContext = {
  db: DatabaseSync;
  configsDir: string;
  now: () => Date;
  adminToken: string | null;
  configFor: (version: number) => FunnelConfig;
};

function createConfigCache(db: DatabaseSync): (version: number) => FunnelConfig {
  const cache = new Map<number, FunnelConfig>();
  return (version) => {
    const cached = cache.get(version);
    if (cached) return cached;
    const record = getVersion(db, version);
    if (!record) throw new Error(`Version ${version} is not stored.`);
    cache.set(version, record.config);
    return record.config;
  };
}

export function resolveDbPath(env: NodeJS.ProcessEnv): string {
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH;
  return env.DB_PATH ?? (volume ? join(volume, 'funnel.db') : './data/funnel.db');
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function wantsSpaPage(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = url.split('?')[0];
  if (isUnder(path, '/api') || isUnder(path, '/assets')) return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}

function sendError(reply: FastifyReply, statusCode: number, error: string, message: string, details?: unknown) {
  return reply.status(statusCode).send({ error, message, details });
}

function registerJsonParser(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser('remove', 'remove');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = body.toString();
    if (text === '') done(null, undefined);
    else parseJson(request, text, done);
  });
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const ctx: AppContext = {
    db: options.db,
    configsDir: options.configsDir,
    now: options.now ?? (() => new Date()),
    adminToken: options.adminToken ?? null,
    configFor: createConfigCache(options.db),
  };
  seedIfEmpty(ctx);
  registerJsonParser(app);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return sendError(reply, error.statusCode, error.code, error.message, error.details);
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 413) return sendError(reply, 413, 'payload_too_large', 'The request body is larger than allowed.');
    if (statusCode < 500) return sendError(reply, statusCode, 'bad_request', (error as Error).message);
    request.log.error(error);
    return sendError(reply, 500, 'internal_error', 'Something went wrong.');
  });

  registerPublicRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerAnalyticsRoutes(app, ctx);
  await app.register(async (admin) => registerAdminRoutes(admin, ctx), { prefix: '/api/admin' });

  const staticDir = options.staticDir && existsSync(options.staticDir) ? resolve(options.staticDir) : null;
  if (staticDir) await app.register(fastifyStatic, { root: staticDir });

  app.setNotFoundHandler((request, reply) => {
    if (staticDir && wantsSpaPage(request.method, request.url)) return reply.sendFile('index.html');
    return sendError(reply, 404, 'not_found', `No route for ${request.method} ${request.url}.`);
  });

  return app;
}
