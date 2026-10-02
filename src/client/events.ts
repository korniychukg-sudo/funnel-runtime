import type { IncomingEvent, SessionState } from '../shared/api';
import type { FunnelResult } from '../shared/config';
import { answerKind, progressFor, resultStepId } from '../shared/engine';

type PropertyValue = string | number | null;

function newEventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildEvent(
  state: SessionState,
  name: string,
  stepId: string,
  properties: Record<string, PropertyValue>,
): IncomingEvent | null {
  const allowedProperties = state.funnel.allowedEvents[name];
  if (!allowedProperties) return null;
  const { session } = state;
  return {
    event_id: newEventId(),
    session_id: session.id,
    name,
    client_timestamp: new Date().toISOString(),
    step_id: stepId,
    funnel_id: session.funnelId,
    funnel_version: session.version,
    experiment_id: session.experimentId,
    variant: session.variant,
    utm_source: session.utm.source,
    utm_medium: session.utm.medium,
    utm_campaign: session.utm.campaign,
    properties: Object.fromEntries(Object.entries(properties).filter(([key]) => allowedProperties.includes(key))),
  };
}

export function stepViewed(state: SessionState, stepId: string): IncomingEvent | null {
  const progress = progressFor(state.funnel, state.answers, stepId);
  return buildEvent(state, 'step_viewed', stepId, {
    step_type: state.funnel.steps[stepId].type,
    visible_step_index: progress.index,
    visible_step_count: progress.count,
  });
}

export function answerSubmitted(state: SessionState, stepId: string): IncomingEvent | null {
  return buildEvent(state, 'answer_submitted', stepId, { answer_kind: answerKind(state.funnel.steps[stepId]) });
}

export function stepCompleted(state: SessionState, stepId: string, nextStepId: string): IncomingEvent | null {
  return buildEvent(state, 'step_completed', stepId, { next_step_id: nextStepId });
}

export function backClicked(state: SessionState, leftStepId: string, destinationStepId: string): IncomingEvent | null {
  return buildEvent(state, 'back_clicked', leftStepId, { destination_step_id: destinationStepId });
}

export function resultViewed(state: SessionState, result: FunnelResult): IncomingEvent | null {
  return buildEvent(state, 'result_viewed', resultStepId(state.funnel), { result_id: result.id });
}

export function ctaClicked(state: SessionState, result: FunnelResult): IncomingEvent | null {
  return buildEvent(state, 'cta_clicked', resultStepId(state.funnel), {
    result_id: result.id,
    action: result.cta.action,
  });
}

export function recommendationExpanded(state: SessionState, result: FunnelResult): IncomingEvent | null {
  return buildEvent(state, 'recommendation_expanded', resultStepId(state.funnel), {
    result_id: result.id,
    action: result.cta.action,
    source: 'result_cta',
  });
}
