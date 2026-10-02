import { evaluateCondition, evaluateTri, type Answers, type AnswerValue } from './conditions';
import type { FunnelConfig, FunnelResult, InteractiveStep, Step } from './config';
import { deepMerge } from './merge';
import { isInteractive } from './steps';

export type ResolvedFunnel = {
  funnelId: string;
  version: number;
  experimentId: string;
  variant: string;
  locale: string;
  title: string;
  sequence: string[];
  steps: Record<string, Step>;
  results: Record<string, FunnelResult>;
  resultRules: FunnelConfig['resultRules'];
  defaultResultId: string;
  progress: FunnelConfig['progress'];
  allowedEvents: Record<string, string[]>;
  privacy: FunnelConfig['events']['privacy'];
  ttlHours: number;
};

export function resolveFunnel(config: FunnelConfig, variantKey: string): ResolvedFunnel {
  const variant = config.experiment.variants[variantKey];
  if (!variant) throw new Error(`Unknown variant "${variantKey}" for version ${config.version}.`);
  const steps: Record<string, Step> = {};
  for (const id of variant.stepSequence) {
    steps[id] = deepMerge(config.steps[id], variant.stepOverrides[id]);
  }
  const results: Record<string, FunnelResult> = {};
  for (const [id, result] of Object.entries(config.results)) {
    results[id] = deepMerge(result, variant.resultOverrides[id]);
  }
  const allowedEvents: Record<string, string[]> = {};
  for (const event of config.events.allowed) allowedEvents[event.name] = [...event.properties];
  return {
    funnelId: config.funnelId,
    version: config.version,
    experimentId: config.experiment.id,
    variant: variantKey,
    locale: config.locale,
    title: config.title,
    sequence: [...variant.stepSequence],
    steps,
    results,
    resultRules: structuredClone(config.resultRules),
    defaultResultId: config.defaultResultId,
    progress: structuredClone(config.progress),
    allowedEvents,
    privacy: structuredClone(config.events.privacy),
    ttlHours: config.session.ttlHours,
  };
}

export function answerName(step: Step): string | null {
  return isInteractive(step) ? step.input.name : null;
}

export function effectiveAnswers(funnel: ResolvedFunnel, answers: Answers): Answers {
  const effective: Answers = {};
  for (const id of funnel.sequence) {
    const step = funnel.steps[id];
    if (step.visibleWhen && !evaluateCondition(step.visibleWhen, effective)) continue;
    if (isInteractive(step) && answers[step.input.name] !== undefined) {
      effective[step.input.name] = answers[step.input.name];
    }
  }
  return effective;
}

export function visibleSequence(funnel: ResolvedFunnel, answers: Answers): string[] {
  const effective = effectiveAnswers(funnel, answers);
  return funnel.sequence.filter((id) => {
    const step = funnel.steps[id];
    return !step.visibleWhen || evaluateCondition(step.visibleWhen, effective);
  });
}

export function isStepVisible(funnel: ResolvedFunnel, answers: Answers, stepId: string): boolean {
  return visibleSequence(funnel, answers).includes(stepId);
}

export function nextStepId(funnel: ResolvedFunnel, answers: Answers, fromStepId: string): string | null {
  const from = funnel.sequence.indexOf(fromStepId);
  if (from < 0) return null;
  const visible = new Set(visibleSequence(funnel, answers));
  for (let i = from + 1; i < funnel.sequence.length; i++) {
    if (visible.has(funnel.sequence[i])) return funnel.sequence[i];
  }
  return null;
}

export function prevStepId(funnel: ResolvedFunnel, answers: Answers, fromStepId: string): string | null {
  const from = funnel.sequence.indexOf(fromStepId);
  if (from <= 0) return null;
  const visible = new Set(visibleSequence(funnel, answers));
  for (let i = from - 1; i >= 0; i--) {
    if (visible.has(funnel.sequence[i])) return funnel.sequence[i];
  }
  return null;
}

export function resultStepId(funnel: ResolvedFunnel): string {
  return funnel.sequence[funnel.sequence.length - 1];
}

export type Progress = { index: number | null; count: number };

export function progressFor(funnel: ResolvedFunnel, answers: Answers, stepId: string): Progress {
  const effective = effectiveAnswers(funnel, answers);
  const hiddenAnswers = new Set<string>();
  const counted: string[] = [];
  for (const id of funnel.sequence) {
    const step = funnel.steps[id];
    const visibility =
      !step.visibleWhen || !funnel.progress.countVisibleOnly
        ? true
        : evaluateTri(step.visibleWhen, effective, (answer) => !hiddenAnswers.has(answer));
    if (visibility === false && isInteractive(step)) hiddenAnswers.add(step.input.name);
    if (visibility !== false && !funnel.progress.excludeTypes.includes(step.type)) counted.push(id);
  }
  const position = counted.indexOf(stepId);
  return { index: position >= 0 ? position + 1 : null, count: counted.length };
}

export type ValidationCode = 'required' | 'invalid' | 'min' | 'max' | 'step' | 'minSelections' | 'maxSelections';

export type ValidationResult =
  | { ok: true; value: AnswerValue | undefined }
  | { ok: false; code: ValidationCode; message: string };

const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

function message(step: InteractiveStep, code: ValidationCode, fallbackCodes: ValidationCode[], fallback: string): string {
  const messages = step.validation.messages ?? {};
  for (const key of [code, ...fallbackCodes]) {
    if (messages[key]) return messages[key];
  }
  return fallback;
}

function fail(step: InteractiveStep, code: ValidationCode, fallback: string, fallbackCodes: ValidationCode[] = []): ValidationResult {
  return { ok: false, code, message: message(step, code, fallbackCodes, fallback) };
}

function isEmpty(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'string') return raw.trim().length === 0;
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

export function validateAnswer(step: Step, raw: unknown): ValidationResult {
  if (!isInteractive(step)) return { ok: false, code: 'invalid', message: 'This step does not take an answer.' };
  const required = step.validation.required ?? false;

  if (isEmpty(raw)) {
    if (!required) return { ok: true, value: undefined };
    if (step.type === 'multi-select') return fail(step, 'required', 'Choose at least one option.', ['minSelections']);
    return fail(step, 'required', 'This answer is required.');
  }

  if (step.type === 'single-select') {
    if (typeof raw !== 'string' || !step.input.options.some((o) => o.value === raw)) {
      return fail(step, 'invalid', 'Choose one of the listed options.', ['required']);
    }
    return { ok: true, value: raw };
  }

  if (step.type === 'multi-select') {
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
      return fail(step, 'invalid', 'Choose from the listed options.');
    }
    const allowed = step.input.options.map((o) => o.value);
    const unique = [...new Set(raw as string[])];
    if (unique.some((v) => !allowed.includes(v))) return fail(step, 'invalid', 'Choose from the listed options.');
    const ordered = allowed.filter((v) => unique.includes(v));
    const { minSelections, maxSelections } = step.validation;
    if (minSelections !== undefined && ordered.length < minSelections) {
      return fail(step, 'minSelections', `Choose at least ${minSelections}.`);
    }
    if (maxSelections !== undefined && ordered.length > maxSelections) {
      return fail(step, 'maxSelections', `Choose no more than ${maxSelections}.`);
    }
    return { ok: true, value: ordered };
  }

  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && NUMBER_PATTERN.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    return fail(step, 'invalid', 'Enter a number.');
  }
  if (!Number.isFinite(value)) return fail(step, 'invalid', 'Enter a number.');
  const { min, max, step: increment } = step.input;
  if (increment !== undefined) {
    const offset = (value - (min ?? 0)) / increment;
    if (Math.abs(offset - Math.round(offset)) > 1e-9) {
      return fail(step, 'step', increment === 1 ? 'Enter a whole number.' : `Use steps of ${increment}.`);
    }
  }
  if (min !== undefined && value < min) return fail(step, 'min', `Enter a value of at least ${min}.`);
  if (max !== undefined && value > max) return fail(step, 'max', `Enter a value up to ${max}.`);
  return { ok: true, value };
}

export function missingSteps(funnel: ResolvedFunnel, answers: Answers, beforeStepId?: string): string[] {
  const effective = effectiveAnswers(funnel, answers);
  const visible = visibleSequence(funnel, answers);
  const stopAt = beforeStepId ? visible.indexOf(beforeStepId) : visible.length;
  const limit = stopAt < 0 ? visible.length : stopAt;
  const missing: string[] = [];
  for (const id of visible.slice(0, limit)) {
    const step = funnel.steps[id];
    if (!isInteractive(step)) continue;
    const check = validateAnswer(step, effective[step.input.name]);
    if (!check.ok) missing.push(id);
  }
  return missing;
}

export function isComplete(funnel: ResolvedFunnel, answers: Answers): boolean {
  return missingSteps(funnel, answers).length === 0;
}

export function canNavigateTo(funnel: ResolvedFunnel, answers: Answers, stepId: string): boolean {
  if (!isStepVisible(funnel, answers, stepId)) return false;
  return missingSteps(funnel, answers, stepId).length === 0;
}

export function computeResultId(funnel: ResolvedFunnel, answers: Answers): string {
  const effective = effectiveAnswers(funnel, answers);
  for (const rule of funnel.resultRules) {
    if (evaluateCondition(rule.when, effective)) return rule.resultId;
  }
  return funnel.defaultResultId;
}

export function answerKind(step: Step): string {
  return step.type;
}
