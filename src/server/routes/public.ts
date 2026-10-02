import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app';
import { requireActiveVersion, versionState } from '../versions';

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ ok: true, activeVersion: versionState(ctx.db).activeVersion }));

  app.get('/api/funnel/active', async () => {
    const config = ctx.configFor(requireActiveVersion(ctx.db));
    return {
      version: config.version,
      funnelId: config.funnelId,
      title: config.title,
      experimentId: config.experiment.id,
      variants: Object.keys(config.experiment.variants),
    };
  });
}
