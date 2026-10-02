import type { Condition, ConditionLeaf } from './config';

export type AnswerValue = string | number | string[];
export type Answers = Record<string, AnswerValue>;

export type Tri = true | false | 'unknown';

function isAnswered(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  return true;
}

function compare(op: 'gt' | 'gte' | 'lt' | 'lte', actual: unknown, expected: unknown): boolean {
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  if (op === 'gt') return actual > expected;
  if (op === 'gte') return actual >= expected;
  if (op === 'lt') return actual < expected;
  return actual <= expected;
}

function includesValue(list: unknown, value: unknown): boolean {
  return Array.isArray(list) && list.some((item) => item === value);
}

export function evaluateLeaf(leaf: ConditionLeaf, answers: Answers): boolean {
  const actual = answers[leaf.answer];
  if (leaf.operator === 'answered') return isAnswered(actual) === (leaf.value ?? true);
  if (!isAnswered(actual)) return false;
  switch (leaf.operator) {
    case 'eq':
      return actual === leaf.value;
    case 'neq':
      return actual !== leaf.value;
    case 'in':
      return includesValue(leaf.value, actual);
    case 'not_in':
      return Array.isArray(leaf.value) && !includesValue(leaf.value, actual);
    case 'contains':
      return Array.isArray(actual) && actual.includes(leaf.value as string);
    case 'not_contains':
      return Array.isArray(actual) && !actual.includes(leaf.value as string);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compare(leaf.operator, actual, leaf.value);
    default:
      return false;
  }
}

export function evaluateCondition(cond: Condition, answers: Answers): boolean {
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, answers));
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, answers));
  if ('not' in cond) return !evaluateCondition(cond.not, answers);
  return evaluateLeaf(cond, answers);
}

export function evaluateTri(cond: Condition, answers: Answers, isPending: (answer: string) => boolean = () => true): Tri {
  if ('all' in cond) {
    const parts = cond.all.map((c) => evaluateTri(c, answers, isPending));
    if (parts.includes(false)) return false;
    return parts.includes('unknown') ? 'unknown' : true;
  }
  if ('any' in cond) {
    const parts = cond.any.map((c) => evaluateTri(c, answers, isPending));
    if (parts.includes(true)) return true;
    return parts.includes('unknown') ? 'unknown' : false;
  }
  if ('not' in cond) {
    const inner = evaluateTri(cond.not, answers, isPending);
    return inner === 'unknown' ? 'unknown' : !inner;
  }
  if (!isAnswered(answers[cond.answer]) && isPending(cond.answer)) return 'unknown';
  return evaluateLeaf(cond, answers);
}
