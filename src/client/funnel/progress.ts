import type { SessionState } from '../../shared/api';
import type { Answers } from '../../shared/conditions';
import type { InteractiveStep } from '../../shared/config';
import { progressFor, validateAnswer } from '../../shared/engine';
import { isInteractive } from '../../shared/steps';
import type { QuestionProgress } from './ProgressHeader';

export type DraftAnswer = string | string[];

function answersWithDraft(answers: Answers, step: InteractiveStep, draft: DraftAnswer | undefined): Answers {
  if (draft === undefined) return answers;
  const check = validateAnswer(step, draft);
  if (!check.ok) return answers;
  const next = { ...answers };
  if (check.value === undefined) delete next[step.input.name];
  else next[step.input.name] = check.value;
  return next;
}

export function questionProgress(state: SessionState, draft?: DraftAnswer): QuestionProgress | null {
  const step = state.funnel.steps[state.currentStepId];
  if (!isInteractive(step)) return null;
  const answers = answersWithDraft(state.answers, step, draft);
  const { index, count } = progressFor(state.funnel, answers, state.currentStepId);
  return index === null ? null : { index, count };
}
