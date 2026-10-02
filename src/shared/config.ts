import { z } from 'zod';
import { deepMerge } from './merge';
import { isInteractive } from './steps';

export const OPERATORS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'answered',
] as const;
export type Operator = (typeof OPERATORS)[number];

export type ConditionLeaf = { answer: string; operator: Operator; value?: unknown };
export type Condition = ConditionLeaf | { all: Condition[] } | { any: Condition[] } | { not: Condition };

const conditionLeafSchema = z.object({
  answer: z.string().min(1),
  operator: z.enum(OPERATORS),
  value: z.unknown().optional(),
});

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    conditionLeafSchema,
    z.object({ all: z.array(conditionSchema).min(1) }),
    z.object({ any: z.array(conditionSchema).min(1) }),
    z.object({ not: conditionSchema }),
  ]),
);

const contentSchema = z.looseObject({
  eyebrow: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  helperText: z.string().optional(),
  primaryActionLabel: z.string().optional(),
  loadingTitle: z.string().optional(),
  errorTitle: z.string().optional(),
  retryLabel: z.string().optional(),
});

const messagesSchema = z.record(z.string(), z.string());

const optionSchema = z.object({ value: z.string().min(1), label: z.string().min(1) });

const baseStep = {
  id: z.string().min(1),
  content: contentSchema.default({}),
  visibleWhen: conditionSchema.optional(),
};

const infoStepSchema = z.looseObject({ ...baseStep, type: z.literal('info') });

const singleSelectStepSchema = z.looseObject({
  ...baseStep,
  type: z.literal('single-select'),
  input: z.object({ name: z.string().min(1), options: z.array(optionSchema).min(1) }),
  validation: z
    .object({ required: z.boolean().optional(), messages: messagesSchema.optional() })
    .default({}),
});

const multiSelectStepSchema = z.looseObject({
  ...baseStep,
  type: z.literal('multi-select'),
  input: z.object({ name: z.string().min(1), options: z.array(optionSchema).min(1) }),
  validation: z
    .object({
      required: z.boolean().optional(),
      minSelections: z.number().int().min(0).optional(),
      maxSelections: z.number().int().min(1).optional(),
      messages: messagesSchema.optional(),
    })
    .default({}),
});

const numberStepSchema = z.looseObject({
  ...baseStep,
  type: z.literal('number'),
  input: z.object({
    name: z.string().min(1),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    unit: z.string().optional(),
  }),
  validation: z
    .object({ required: z.boolean().optional(), messages: messagesSchema.optional() })
    .default({}),
});

const resultStepSchema = z.looseObject({
  ...baseStep,
  type: z.literal('result'),
  resultSource: z.literal('resultRules').default('resultRules'),
});

export const stepSchema = z.discriminatedUnion('type', [
  infoStepSchema,
  singleSelectStepSchema,
  multiSelectStepSchema,
  numberStepSchema,
  resultStepSchema,
]);

const ctaSchema = z.object({ label: z.string().min(1), action: z.string().min(1) });

export const resultSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(''),
  recommendations: z.array(z.string()).default([]),
  cta: ctaSchema,
});

const variantSchema = z.object({
  weight: z.number().positive(),
  stepSequence: z.array(z.string().min(1)).min(2),
  stepOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  resultOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export const funnelConfigSchema = z.looseObject({
  schemaVersion: z.string(),
  funnelId: z.string().min(1),
  version: z.number().int().positive(),
  status: z.string().optional(),
  locale: z.string().default('en'),
  title: z.string().default(''),
  description: z.string().optional(),
  releaseNote: z.string().optional(),
  session: z
    .object({
      ttlHours: z.number().positive().default(72),
      persistAnswers: z.boolean().default(true),
      pinVersion: z.boolean().default(true),
      pinExperimentVariant: z.boolean().default(true),
    })
    .default({ ttlHours: 72, persistAnswers: true, pinVersion: true, pinExperimentVariant: true }),
  progress: z
    .object({
      countVisibleOnly: z.boolean().default(true),
      excludeTypes: z.array(z.string()).default(['info', 'result']),
    })
    .default({ countVisibleOnly: true, excludeTypes: ['info', 'result'] }),
  experiment: z.object({
    id: z.string().min(1),
    assignment: z.literal('server').default('server'),
    sticky: z.boolean().default(true),
    overrideQueryParam: z.string().default('variant'),
    variants: z.record(z.string(), variantSchema),
  }),
  steps: z.record(z.string(), stepSchema),
  resultRules: z.array(z.object({ resultId: z.string().min(1), when: conditionSchema })).default([]),
  defaultResultId: z.string().min(1),
  results: z.record(z.string(), resultSchema),
  events: z.object({
    baseProperties: z.array(z.string()).default([]),
    allowed: z
      .array(
        z.object({
          name: z.string().min(1),
          trigger: z.string().optional(),
          properties: z.array(z.string()).default([]),
        }),
      )
      .min(1),
    privacy: z
      .object({ storeRawAnswers: z.boolean().default(false), allowAnswerKinds: z.boolean().default(true) })
      .default({ storeRawAnswers: false, allowAnswerKinds: true }),
  }),
});

export type FunnelConfig = z.infer<typeof funnelConfigSchema>;
export type Step = z.infer<typeof stepSchema>;
export type StepType = Step['type'];
export type InteractiveStep = Extract<Step, { input: unknown }>;
export type FunnelResult = z.infer<typeof resultSchema>;
export type Variant = z.infer<typeof variantSchema>;

export { INTERACTIVE_TYPES, isInteractive } from './steps';

export type ConfigIssue = { path: string; message: string };

export type ParseConfigResult =
  | { ok: true; config: FunnelConfig; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[] };

export function parseFunnelConfig(input: unknown): ParseConfigResult {
  const parsed = funnelConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const errors = checkConfigSemantics(parsed.data);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: parsed.data, warnings: [] };
}

export function conditionAnswers(cond: Condition): string[] {
  if ('all' in cond) return cond.all.flatMap(conditionAnswers);
  if ('any' in cond) return cond.any.flatMap(conditionAnswers);
  if ('not' in cond) return conditionAnswers(cond.not);
  return [cond.answer];
}

export function checkConfigSemantics(config: FunnelConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  const answerOwner = new Map<string, string>();
  for (const [key, step] of Object.entries(config.steps)) {
    if (step.id !== key) add(`steps.${key}.id`, `Step key "${key}" does not match id "${step.id}".`);
    if (isInteractive(step)) {
      const name = step.input.name;
      if (answerOwner.has(name)) add(`steps.${key}.input.name`, `Answer name "${name}" is used by more than one step.`);
      answerOwner.set(name, key);
      if (step.type === 'number' && step.input.min !== undefined && step.input.max !== undefined && step.input.min > step.input.max) {
        add(`steps.${key}.input`, 'min is greater than max.');
      }
      if (step.type === 'multi-select') {
        const { minSelections, maxSelections } = step.validation;
        if (minSelections !== undefined && maxSelections !== undefined && minSelections > maxSelections) {
          add(`steps.${key}.validation`, 'minSelections is greater than maxSelections.');
        }
      }
    }
  }

  for (const [key, result] of Object.entries(config.results)) {
    if (result.id !== key) add(`results.${key}.id`, `Result key "${key}" does not match id "${result.id}".`);
  }
  if (!config.results[config.defaultResultId]) add('defaultResultId', `Unknown result "${config.defaultResultId}".`);

  const checkCondition = (cond: Condition, path: string) => {
    for (const answer of conditionAnswers(cond)) {
      if (!answerOwner.has(answer)) add(path, `Condition references unknown answer "${answer}".`);
    }
  };

  config.resultRules.forEach((rule, i) => {
    if (!config.results[rule.resultId]) add(`resultRules.${i}.resultId`, `Unknown result "${rule.resultId}".`);
    checkCondition(rule.when, `resultRules.${i}.when`);
  });

  const variantKeys = Object.keys(config.experiment.variants);
  if (variantKeys.length === 0) add('experiment.variants', 'At least one variant is required.');

  for (const [variantKey, variant] of Object.entries(config.experiment.variants)) {
    const base = `experiment.variants.${variantKey}`;
    const seen = new Set<string>();
    const answeredBefore = new Set<string>();
    variant.stepSequence.forEach((stepId, i) => {
      const step = config.steps[stepId];
      if (!step) {
        add(`${base}.stepSequence.${i}`, `Unknown step "${stepId}".`);
        return;
      }
      if (seen.has(stepId)) add(`${base}.stepSequence.${i}`, `Step "${stepId}" appears twice.`);
      seen.add(stepId);
      if (step.visibleWhen) {
        checkCondition(step.visibleWhen, `steps.${stepId}.visibleWhen`);
        for (const answer of conditionAnswers(step.visibleWhen)) {
          if (answerOwner.has(answer) && !answeredBefore.has(answer)) {
            add(`${base}.stepSequence.${i}`, `Step "${stepId}" depends on "${answer}", which is not asked earlier in variant ${variantKey}.`);
          }
        }
      }
      if (step.type === 'result' && i !== variant.stepSequence.length - 1) {
        add(`${base}.stepSequence.${i}`, 'The result step must be the last step.');
      }
      if (step.type === 'result' && step.visibleWhen) {
        add(`steps.${stepId}.visibleWhen`, 'The result step cannot be conditional.');
      }
      if (isInteractive(step)) answeredBefore.add(step.input.name);
    });
    const last = config.steps[variant.stepSequence[variant.stepSequence.length - 1]];
    if (!last || last.type !== 'result') add(`${base}.stepSequence`, 'The sequence must end with a result step.');
    const first = config.steps[variant.stepSequence[0]];
    if (first?.visibleWhen) add(`${base}.stepSequence.0`, 'The first step cannot be conditional.');
    for (const [key, override] of Object.entries(variant.stepOverrides)) {
      if (!config.steps[key]) add(`${base}.stepOverrides.${key}`, `Unknown step "${key}".`);
      else if (!stepSchema.safeParse(deepMerge(config.steps[key], override)).success) {
        add(`${base}.stepOverrides.${key}`, 'The override produces an invalid step.');
      }
    }
    for (const [key, override] of Object.entries(variant.resultOverrides)) {
      if (!config.results[key]) add(`${base}.resultOverrides.${key}`, `Unknown result "${key}".`);
      else if (!resultSchema.safeParse(deepMerge(config.results[key], override)).success) {
        add(`${base}.resultOverrides.${key}`, 'The override produces an invalid result.');
      }
    }
  }

  const allowedNames = new Set<string>();
  config.events.allowed.forEach((event, i) => {
    if (allowedNames.has(event.name)) add(`events.allowed.${i}`, `Event "${event.name}" is listed twice.`);
    allowedNames.add(event.name);
  });
  if (!allowedNames.has('session_started')) add('events.allowed', 'session_started must be allowed.');

  return issues;
}
