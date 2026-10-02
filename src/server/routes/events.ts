import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_EVENTS_PER_BATCH, type EventItemResult, type EventItemStatus, type EventsResponse } from '../../shared/api';
import { isPlainObject } from '../../shared/merge';
import type { AppContext } from '../app';
import { transaction } from '../db';
import { getSession, insertEvent, insertIngestBatch, type SessionRecord, type StoredEvent } from '../store';
import { HttpError } from './http';

const ONE_MEGABYTE = 1024 * 1024;

const STEP_EVENTS = new Set(['step_viewed', 'answer_submitted', 'step_completed', 'back_clicked']);
const RESULT_EVENTS = new Set(['result_viewed', 'cta_clicked', 'recommendation_expanded']);

const batchSchema = z.object({ events: z.array(z.unknown()).max(MAX_EVENTS_PER_BATCH) });

const incomingEventSchema = z.object({
  event_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  client_timestamp: z.iso.datetime({ offset: true }),
  step_id: z.string().nullish(),
  funnel_id: z.unknown().optional(),
  funnel_version: z.unknown().optional(),
  experiment_id: z.unknown().optional(),
  variant: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).nullish(),
});

type IncomingEvent = z.infer<typeof incomingEventSchema>;

type Prepared = { ok: true; event: StoredEvent } | { ok: false; reason: string };

function reject(reason: string): Prepared {
  return { ok: false, reason };
}

function hasContextMismatch(item: IncomingEvent, session: SessionRecord): boolean {
  const pairs: [unknown, string | number][] = [
    [item.funnel_id, session.funnelId],
    [item.funnel_version, session.version],
    [item.experiment_id, session.experimentId],
    [item.variant, session.variant],
  ];
  return pairs.some(([sent, actual]) => sent != null && sent !== actual);
}

function pickProperties(properties: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (properties && Object.hasOwn(properties, key)) picked[key] = properties[key];
  }
  return picked;
}

function prepareEvent(ctx: AppContext, raw: unknown, serverTs: string): Prepared {
  const parsed = incomingEventSchema.safeParse(raw);
  if (!parsed.success) return reject('invalid_event');
  const item = parsed.data;

  const session = getSession(ctx.db, item.session_id);
  if (!session) return reject('unknown_session');

  if (item.name === 'session_started') return reject('server_only');
  const config = ctx.configFor(session.version);
  const definition = config.events.allowed.find((event) => event.name === item.name);
  if (!definition) return reject('event_not_allowed');

  if (hasContextMismatch(item, session)) return reject('context_mismatch');

  const sequence = config.experiment.variants[session.variant].stepSequence;
  const resultStep = sequence[sequence.length - 1];
  const stepId = item.step_id ?? (RESULT_EVENTS.has(item.name) ? resultStep : null);
  if (STEP_EVENTS.has(item.name) && stepId === null) return reject('unknown_step');
  if (stepId !== null && !sequence.includes(stepId)) return reject('unknown_step');

  return {
    ok: true,
    event: {
      eventId: item.event_id,
      sessionId: session.id,
      name: item.name,
      stepId,
      funnelId: session.funnelId,
      funnelVersion: session.version,
      experimentId: session.experimentId,
      variant: session.variant,
      utmSource: session.utmSource,
      utmMedium: session.utmMedium,
      utmCampaign: session.utmCampaign,
      clientTs: item.client_timestamp,
      serverTs,
      properties: pickProperties(item.properties, definition.properties),
    },
  };
}

function ingestOne(ctx: AppContext, raw: unknown, index: number, serverTs: string): EventItemResult {
  const eventId = isPlainObject(raw) && typeof raw.event_id === 'string' ? raw.event_id : null;
  const prepared = prepareEvent(ctx, raw, serverTs);
  if (!prepared.ok) return { index, event_id: eventId, status: 'rejected', reason: prepared.reason };
  const inserted = insertEvent(ctx.db, prepared.event);
  return { index, event_id: eventId, status: inserted ? 'accepted' : 'duplicate' };
}

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/events', { bodyLimit: ONE_MEGABYTE }, async (request): Promise<EventsResponse> => {
    const batch = batchSchema.safeParse(request.body);
    if (!batch.success) {
      throw new HttpError(
        400,
        'invalid_batch',
        `The body must be { events: [...] } with at most ${MAX_EVENTS_PER_BATCH} items.`,
      );
    }
    const now = ctx.now().toISOString();
    return transaction(ctx.db, () => {
      const results = batch.data.events.map((raw, index) => ingestOne(ctx, raw, index, now));
      const count = (status: EventItemStatus) => results.filter((result) => result.status === status).length;
      const accepted = count('accepted');
      const duplicates = count('duplicate');
      const rejected = count('rejected');
      insertIngestBatch(ctx.db, { receivedAt: now, total: results.length, accepted, duplicates, rejected });
      return { accepted, duplicates, rejected, results };
    });
  });
}
