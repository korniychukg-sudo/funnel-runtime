import type { InteractiveStep, Step, StepType } from './config';

export const INTERACTIVE_TYPES: StepType[] = ['single-select', 'multi-select', 'number'];

export function isInteractive(step: Step): step is InteractiveStep {
  return step.type === 'single-select' || step.type === 'multi-select' || step.type === 'number';
}
