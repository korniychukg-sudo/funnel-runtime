import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionState } from '../../shared/api';
import type { Answers, AnswerValue } from '../../shared/conditions';
import { isInteractive, type FunnelConfig } from '../../shared/config';
import {
  canNavigateTo,
  computeResultId,
  isComplete,
  missingSteps,
  nextStepId,
  resolveFunnel,
  resultStepId,
  validateAnswer,
  type ResolvedFunnel,
} from '../../shared/engine';
import type { AppContext } from '../app';
import { assignVariant } from '../assignment';
import { transaction } from '../db';
import { getSession, insertEvent, insertSession, updateSessionProgress, type SessionRecord } from '../store';
import { requireActiveVersion } from '../versions';
import { HttpError, parseBody } from './http';

const HOUR_MS = 60 * 60 * 1000;

const utmValue = z.string().max(256).nullish();

const createSessionSchema = z.object({
  sessionId: z.string().max(128).nullish(),
  variant: z.string().max(64).nullish(),
  utm: z.object({ source: utmValue, medium: utmValue, campaign: utmValue }).nullish(),
  runId: z.string().max(128).nullish(),
});

const answerSchema = z.object({ stepId: z.string().min(1), value: z.unknown() });

const navigateSchema = z.object({ stepId: z.string().min(1) });

type CreateSessionBody = z.infer<typeof createSessionSchema>;

type SessionParams = { Params: { id: string } };

function isExpired(session: SessionRecord, now: Date): boolean {
  return Date.parse(session.expiresAt) <= now.getTime();
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function validOverride(config: FunnelConfig, requested: string | null | undefined): string | null {
  return requested && Object.hasOwn(config.experiment.variants, requested) ? requested : null;
}

function funnelFor(ctx: AppContext, session: SessionRecord): ResolvedFunnel {
  return resolveFunnel(ctx.configFor(session.version), session.variant);
}

function sessionState(session: SessionRecord, funnel: ResolvedFunnel, resumed: boolean): SessionState {
  return {
    session: {
      id: session.id,
      funnelId: session.funnelId,
      version: session.version,
      experimentId: session.experimentId,
      variant: session.variant,
      assignmentSource: session.assignmentSource,
      utm: { source: session.utmSource, medium: session.utmMedium, campaign: session.utmCampaign },
      runId: session.runId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    },
    funnel,
    answers: session.answers,
    currentStepId: session.currentStepId,
    resultId: session.resultId,
    result: session.resultId ? (funnel.results[session.resultId] ?? null) : null,
    resumed,
  };
}

function createSession(ctx: AppContext, config: FunnelConfig, body: CreateSessionBody, override: string | null) {
  const id = randomUUID();
  const createdAt = ctx.now();
  const at = createdAt.toISOString();
  const variant = override ?? assignVariant(id, config.experiment.id, config.experiment.variants);
  const session: SessionRecord = {
    id,
    funnelId: config.funnelId,
    version: config.version,
    experimentId: config.experiment.id,
    variant,
    assignmentSource: override ? 'override' : 'hash',
    utmSource: blankToNull(body.utm?.source),
    utmMedium: blankToNull(body.utm?.medium),
    utmCampaign: blankToNull(body.utm?.campaign),
    runId: blankToNull(body.runId),
    answers: {},
    currentStepId: config.experiment.variants[variant].stepSequence[0],
    resultId: null,
    createdAt: at,
    updatedAt: at,
    expiresAt: new Date(createdAt.getTime() + config.session.ttlHours * HOUR_MS).toISOString(),
  };
  transaction(ctx.db, () => {
    insertSession(ctx.db, session);
    insertEvent(ctx.db, {
      eventId: `${id}:session_started`,
      sessionId: id,
      name: 'session_started',
      stepId: null,
      funnelId: session.funnelId,
      funnelVersion: session.version,
      experimentId: session.experimentId,
      variant,
      utmSource: session.utmSource,
      utmMedium: session.utmMedium,
      utmCampaign: session.utmCampaign,
      clientTs: null,
      serverTs: at,
      properties: {},
    });
  });
  return session;
}

function loadLiveSession(ctx: AppContext, id: string): SessionRecord {
  const session = getSession(ctx.db, id);
  if (!session) throw new HttpError(404, 'session_not_found', 'Session not found.');
  if (isExpired(session, ctx.now())) throw new HttpError(410, 'session_expired', 'The session has expired.');
  return session;
}

function stepNotAvailable(stepId: string): HttpError {
  return new HttpError(409, 'step_not_available', `Step ${stepId} is not available yet.`);
}

function withAnswer(answers: Answers, name: string, value: AnswerValue | undefined): Answers {
  const next = { ...answers };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return next;
}

function saveProgress(ctx: AppContext, session: SessionRecord, changes: Partial<SessionRecord>): SessionRecord {
  const updated = { ...session, ...changes, updatedAt: ctx.now().toISOString() };
  updateSessionProgress(ctx.db, updated);
  return updated;
}

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/sessions', async (request) => {
    const body = parseBody(createSessionSchema, request.body);
    const activeConfig = ctx.configFor(requireActiveVersion(ctx.db));
    const override = validOverride(activeConfig, body.variant);
    const existing = body.sessionId ? getSession(ctx.db, body.sessionId) : null;
    if (existing && !isExpired(existing, ctx.now()) && (override === null || override === existing.variant)) {
      return sessionState(existing, funnelFor(ctx, existing), true);
    }
    const session = createSession(ctx, activeConfig, body, override);
    return sessionState(session, funnelFor(ctx, session), false);
  });

  app.get<SessionParams>('/api/sessions/:id', async (request) => {
    const session = loadLiveSession(ctx, request.params.id);
    return sessionState(session, funnelFor(ctx, session), true);
  });

  app.post<SessionParams>('/api/sessions/:id/answers', async (request) => {
    const { stepId, value } = parseBody(answerSchema, request.body);
    const session = loadLiveSession(ctx, request.params.id);
    const funnel = funnelFor(ctx, session);
    const step = funnel.sequence.includes(stepId) ? funnel.steps[stepId] : null;
    if (!step || !isInteractive(step) || !canNavigateTo(funnel, session.answers, stepId)) {
      throw stepNotAvailable(stepId);
    }
    const validation = validateAnswer(step, value);
    if (!validation.ok) throw new HttpError(422, 'invalid_answer', validation.message, { code: validation.code });
    const name = step.input.name;
    const answers = withAnswer(session.answers, name, validation.value);
    const changed = JSON.stringify(session.answers[name]) !== JSON.stringify(validation.value);
    const updated = saveProgress(ctx, session, {
      answers,
      currentStepId: nextStepId(funnel, answers, stepId) ?? resultStepId(funnel),
      resultId: changed ? null : session.resultId,
    });
    return sessionState(updated, funnel, false);
  });

  app.post<SessionParams>('/api/sessions/:id/navigate', async (request) => {
    const { stepId } = parseBody(navigateSchema, request.body);
    const session = loadLiveSession(ctx, request.params.id);
    const funnel = funnelFor(ctx, session);
    const reachable = funnel.sequence.includes(stepId) && canNavigateTo(funnel, session.answers, stepId);
    const resultReady = stepId !== resultStepId(funnel) || isComplete(funnel, session.answers);
    if (!reachable || !resultReady) throw stepNotAvailable(stepId);
    const updated = saveProgress(ctx, session, { currentStepId: stepId });
    return sessionState(updated, funnel, false);
  });

  app.post<SessionParams>('/api/sessions/:id/result', async (request) => {
    const session = loadLiveSession(ctx, request.params.id);
    const funnel = funnelFor(ctx, session);
    const missing = missingSteps(funnel, session.answers);
    if (missing.length > 0) {
      throw new HttpError(409, 'incomplete', 'Some steps still need a valid answer.', { missing });
    }
    const updated = saveProgress(ctx, session, {
      resultId: computeResultId(funnel, session.answers),
      currentStepId: resultStepId(funnel),
    });
    return sessionState(updated, funnel, false);
  });
}
