import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MAX_EVENTS_PER_BATCH, type EventItemResult, type EventItemStatus, type EventsResponse } from '../../shared/api';
import type { FunnelConfig, Variant } from '../../shared/config';
import { deepMerge, isPlainObject } from '../../shared/merge';
import type { AppContext } from '../app';
import { transaction } from '../db';
import { getSession, insertEvent, insertIngestBatch, type SessionRecord, type StoredEvent } from '../store';
import { HttpError } from './http';

const ONE_MEGABYTE = 1024 * 1024;
const MAX_PROPERTY_LENGTH = 256;

const STEP_EVENTS = new Set(['step_viewed', 'answer_submitted', 'step_completed', 'back_clicked']);
const RESULT_EVENTS = new Set(['result_viewed', 'cta_clicked', 'recommendation_expanded']);
const STEP_TYPE_PROPERTY = new Map([
  ['step_viewed', 'step_type'],
  ['answer_submitted', 'answer_kind'],
]);
const COUNT_PROPERTIES = new Set(['visible_step_index', 'visible_step_count']);
const STEP_PROPERTIES = new Set(['next_step_id', 'destination_step_id']);

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

function isPrimitiveValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= MAX_PROPERTY_LENGTH;
  return typeof value === 'number' && Number.isFinite(value);
}

function isCountOrNull(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && (value as number) >= 0);
}

function hasValidProperties(properties: Record<string, unknown>, config: FunnelConfig, sequence: string[]): boolean {
  return Object.entries(properties).every(([key, value]) => {
    if (!isPrimitiveValue(value)) return false;
    if (COUNT_PROPERTIES.has(key)) return isCountOrNull(value);
    if (key === 'result_id') return typeof value === 'string' && Object.hasOwn(config.results, value);
    if (STEP_PROPERTIES.has(key)) return typeof value === 'string' && sequence.includes(value);
    return true;
  });
}

function resolvedStepType(config: FunnelConfig, variant: Variant, stepId: string): string {
  return deepMerge(config.steps[stepId], variant.stepOverrides[stepId]).type;
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

  const variant = config.experiment.variants[session.variant];
  const sequence = variant.stepSequence;
  const resultStep = sequence[sequence.length - 1];
  const stepId = item.step_id ?? (RESULT_EVENTS.has(item.name) ? resultStep : null);
  if (STEP_EVENTS.has(item.name) && stepId === null) return reject('unknown_step');
  if (stepId !== null && !sequence.includes(stepId)) return reject('unknown_step');

  const properties = pickProperties(item.properties, definition.properties);
  const stepTypeKey = STEP_TYPE_PROPERTY.get(item.name);
  if (stepTypeKey && stepId !== null && definition.properties.includes(stepTypeKey)) {
    properties[stepTypeKey] = resolvedStepType(config, variant, stepId);
  }
  if (!hasValidProperties(properties, config, sequence)) return reject('invalid_property');

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
      properties,
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
