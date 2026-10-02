import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isPlainObject } from '../../shared/merge';
import type { AppContext } from '../app';
import {
  activateVersion,
  adminOverview,
  importFixture,
  publishVersion,
  rollback,
  uploadVersion,
  versionDetail,
} from '../versions';
import { HttpError } from './http';

type VersionParams = { Params: { version: string } };

function tokenMatches(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== 'string') return false;
  const given = Buffer.from(header);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('onRequest', async (request) => {
    if (ctx.adminToken !== null && !tokenMatches(request.headers['x-admin-token'], ctx.adminToken)) {
      throw new HttpError(401, 'unauthorized', 'A valid x-admin-token header is required.');
    }
  });

  app.get('/overview', async () => adminOverview(ctx));

  app.get<VersionParams>('/versions/:version', async (request) => versionDetail(ctx, Number(request.params.version)));

  app.post('/versions', async (request, reply) => {
    const config = isPlainObject(request.body) ? request.body.config : undefined;
    const summary = uploadVersion(ctx, config);
    reply.status(201);
    return summary;
  });

  app.post<{ Params: { file: string } }>('/fixtures/:file/import', async (request, reply) => {
    const summary = importFixture(ctx, request.params.file);
    reply.status(201);
    return summary;
  });

  app.post<VersionParams>('/versions/:version/publish', async (request) => {
    publishVersion(ctx, Number(request.params.version));
    return adminOverview(ctx);
  });

  app.post<VersionParams>('/versions/:version/activate', async (request) => {
    activateVersion(ctx, Number(request.params.version));
    return adminOverview(ctx);
  });

  app.post('/rollback', async () => {
    rollback(ctx);
    return adminOverview(ctx);
  });
}
