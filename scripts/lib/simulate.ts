import { randomUUID } from 'node:crypto';
import type { IncomingEvent, SessionState, Utm } from '../../src/shared/api';
import type { Step } from '../../src/shared/config';
import { nextStepId, prevStepId, progressFor } from '../../src/shared/engine';
import type { Client } from './http';
import type { Random } from './args';

export type SessionTruth = {
  sessionId: string;
  version: number;
  experimentId: string;
  variant: string;
  campaign: string | null;
  sequence: string[];
  reached: Set<string>;
  reachedResult: boolean;
  ctaClicked: boolean;
  resultId: string | null;
  stepViews: number;
  backClicks: number;
};

export type Behaviour = {
  dropAtIntro: number;
  dropPerQuestion: number;
  backChance: number;
  refreshChance: number;
  ctaChance: Record<string, number>;
};

export const DEFAULT_BEHAVIOUR: Behaviour = {
  dropAtIntro: 0.08,
  dropPerQuestion: 0.045,
  backChance: 0.08,
  refreshChance: 0.05,
  ctaChance: { A: 0.42, B: 0.52 },
};

const NUMBER_RANGES: Record<string, [number, number]> = {
  team_size: [3, 60],
  office_days: [1, 5],
  meeting_hours: [2, 26],
  tool_count: [3, 16],
};

const SINGLE_WEIGHTS: Record<string, Record<string, number>> = {
  work_mode: { remote: 0.45, hybrid: 0.35, office: 0.2 },
  timezone_span: { same: 0.5, wide: 0.3, global: 0.2 },
  async_maturity: { low: 0.4, medium: 0.4, high: 0.2 },
  security_constraints: { standard: 0.4, strict: 0.35, regulated: 0.25 },
};

function weightedPick(random: Random, weights: Record<string, number>, allowed: string[]): string {
  const entries = allowed.map((value) => [value, weights[value] ?? 1 / allowed.length] as const);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = random.next() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

function pickAnswer(step: Step, random: Random): unknown {
  if (step.type === 'single-select') {
    const values = step.input.options.map((o) => o.value);
    return weightedPick(random, SINGLE_WEIGHTS[step.id] ?? {}, values);
  }
  if (step.type === 'multi-select') {
    const values = step.input.options.map((o) => o.value);
    const max = Math.min(step.validation.maxSelections ?? values.length, values.length);
    const min = Math.max(step.validation.minSelections ?? 1, 1);
    const count = random.int(min, max);
    const chosen = random.shuffle(values.filter((v) => v !== 'compliance')).slice(0, count);
    if (values.includes('compliance') && random.chance(0.3)) chosen[0] = 'compliance';
    return [...new Set(chosen)];
  }
  if (step.type === 'number') {
    const min = step.input.min ?? 0;
    const max = step.input.max ?? min + 10;
    const [low, high] = NUMBER_RANGES[step.id] ?? [min, Math.min(max, min + 10)];
    return random.int(Math.max(low, min), Math.min(high, max));
  }
  return undefined;
}

export class SessionSimulation {
  readonly events: IncomingEvent[] = [];
  truth!: SessionTruth;
  private state!: SessionState;
  private clock: number;
  private backBudget = 1;
  finished = false;

  constructor(
    private readonly client: Client,
    private readonly random: Random,
    private readonly behaviour: Behaviour,
    private readonly utm: Utm,
    private readonly runId: string,
    startMs: number,
  ) {
    this.clock = startMs;
  }

  get sessionId() {
    return this.state.session.id;
  }

  get version() {
    return this.state.session.version;
  }

  async start() {
    this.state = await this.client.createSession(this.utm, this.runId);
    const { session, funnel } = this.state;
    this.truth = {
      sessionId: session.id,
      version: session.version,
      experimentId: session.experimentId,
      variant: session.variant,
      campaign: session.utm.campaign,
      sequence: funnel.sequence,
      reached: new Set(),
      reachedResult: false,
      ctaClicked: false,
      resultId: null,
      stepViews: 0,
      backClicks: 0,
    };
    this.view(this.state.currentStepId);
    if (this.random.chance(this.behaviour.dropAtIntro)) {
      this.finished = true;
      return;
    }
    const first = nextStepId(funnel, this.state.answers, this.state.currentStepId);
    if (first) this.state = await this.client.navigate(session.id, first);
  }

  async resume() {
    this.state = await this.client.createSession(this.utm, this.runId, this.sessionId);
    if (this.state.session.id !== this.truth.sessionId) throw new Error('Resume returned a different session.');
    if (this.state.session.version !== this.truth.version) {
      throw new Error(`Session ${this.sessionId} changed version ${this.truth.version} → ${this.state.session.version}.`);
    }
    if (this.state.session.variant !== this.truth.variant) throw new Error(`Session ${this.sessionId} changed variant.`);
  }

  async run(stopAfterAnswers = Infinity) {
    let answered = 0;
    while (!this.finished) {
      const { funnel } = this.state;
      const stepId = this.state.currentStepId;
      const step = funnel.steps[stepId];
      if (step.type === 'result') {
        await this.finishWithResult();
        return;
      }
      this.view(stepId);
      if (this.random.chance(this.behaviour.refreshChance)) this.view(stepId);
      if (this.random.chance(this.behaviour.dropPerQuestion)) {
        this.finished = true;
        return;
      }
      const prev = prevStepId(funnel, this.state.answers, stepId);
      if (this.backBudget > 0 && prev && prev !== funnel.sequence[0] && this.random.chance(this.behaviour.backChance)) {
        this.backBudget--;
        this.emit('back_clicked', stepId, { destination_step_id: prev });
        this.truth.backClicks++;
        this.state = await this.client.navigate(this.sessionId, prev);
        continue;
      }
      if (answered >= stopAfterAnswers) return;
      const value = pickAnswer(step, this.random);
      this.state = await this.client.answer(this.sessionId, stepId, value);
      answered++;
      this.emit('answer_submitted', stepId, { answer_kind: step.type });
      this.emit('step_completed', stepId, { next_step_id: this.state.currentStepId });
    }
  }

  private async finishWithResult() {
    const resultStep = this.state.currentStepId;
    this.view(resultStep);
    this.state = await this.client.result(this.sessionId);
    const resultId = this.state.resultId!;
    const action = this.state.result!.cta.action;
    this.emit('result_viewed', resultStep, { result_id: resultId });
    this.truth.reachedResult = true;
    this.truth.resultId = resultId;
    if (this.random.chance(this.behaviour.ctaChance[this.truth.variant] ?? 0.45)) {
      this.emit('cta_clicked', resultStep, { result_id: resultId, action });
      this.truth.ctaClicked = true;
      this.emit('recommendation_expanded', resultStep, { result_id: resultId, action, source: 'result_cta' });
    }
    this.finished = true;
  }

  private view(stepId: string) {
    const step = this.state.funnel.steps[stepId];
    const progress = progressFor(this.state.funnel, this.state.answers, stepId);
    this.emit('step_viewed', stepId, {
      step_type: step.type,
      visible_step_index: progress.index,
      visible_step_count: progress.count,
    });
    this.truth.reached.add(stepId);
    this.truth.stepViews++;
  }

  private emit(name: string, stepId: string, properties: Record<string, unknown>) {
    const allowed = this.state.funnel.allowedEvents[name];
    if (!allowed) return;
    this.clock += this.random.int(2, 25) * 1000;
    const { session } = this.state;
    this.events.push({
      event_id: randomUUID(),
      session_id: session.id,
      name,
      client_timestamp: new Date(this.clock).toISOString(),
      step_id: stepId,
      funnel_id: session.funnelId,
      funnel_version: session.version,
      experiment_id: session.experimentId,
      variant: session.variant,
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => allowed.includes(key))),
    });
  }
}
