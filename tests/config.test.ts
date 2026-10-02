import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFunnelConfig, type ConfigIssue } from '../src/shared/config';

type RawConfig = {
  experiment: { variants: Record<string, { stepSequence: string[]; stepOverrides?: object; resultOverrides?: object }> };
  steps: Record<string, { visibleWhen?: unknown }>;
  resultRules: Array<{ resultId: string }>;
  [key: string]: unknown;
};

function readRaw(path: string): RawConfig {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as RawConfig;
}

const rawV1 = readRaw('../configs/funnel-v1.json');
const rawV3 = readRaw('../configs/funnel-v3.json');
const rawSynthetic = readRaw('./fixtures/funnel-synthetic.json');

function errorsOf(raw: RawConfig): ConfigIssue[] {
  const parsed = parseFunnelConfig(raw);
  return parsed.ok ? [] : parsed.errors;
}

function editedV1(edit: (raw: RawConfig) => void): RawConfig {
  const raw = structuredClone(rawV1);
  edit(raw);
  return raw;
}

describe('parseFunnelConfig', () => {
  it('parses v1, v3 and the synthetic fixture', () => {
    for (const [raw, version] of [[rawV1, 1], [rawV3, 3], [rawSynthetic, 7]] as const) {
      const parsed = parseFunnelConfig(raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.config.version).toBe(version);
    }
  });

  it('fills defaults the fixture leaves out', () => {
    const parsed = parseFunnelConfig(rawSynthetic);
    if (!parsed.ok) throw new Error('synthetic fixture must parse');
    expect(parsed.config.session.ttlHours).toBe(72);
    expect(parsed.config.experiment.variants.A.stepOverrides).toEqual({});
    expect(parsed.config.steps.result).toMatchObject({ type: 'result', resultSource: 'resultRules' });
  });

  it('allows releaseNote and unknown top-level keys', () => {
    const raw = { ...structuredClone(rawV3), owner: 'growth-team', reviewedBy: ['qa'] };
    const parsed = parseFunnelConfig(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.releaseNote).toBe(rawV3.releaseNote);
  });

  it('reports a condition on an answer asked later in some variant', () => {
    const raw = editedV1((r) => {
      r.experiment.variants.B.stepSequence = ['intro', 'office_days', 'work_mode', 'timezone_span', 'team_size', 'async_maturity', 'priorities', 'tool_count', 'result'];
    });
    expect(errorsOf(raw)).toEqual([
      {
        path: 'experiment.variants.B.stepSequence.1',
        message: 'Step "office_days" depends on "work_mode", which is not asked earlier in variant B.',
      },
    ]);
  });

  it('reports an unknown step in a sequence', () => {
    const raw = editedV1((r) => r.experiment.variants.A.stepSequence.splice(2, 0, 'ghost'));
    expect(errorsOf(raw)).toContainEqual({ path: 'experiment.variants.A.stepSequence.2', message: 'Unknown step "ghost".' });
  });

  it('reports a step listed twice in a sequence', () => {
    const raw = editedV1((r) => r.experiment.variants.A.stepSequence.splice(8, 0, 'team_size'));
    expect(errorsOf(raw)).toEqual([{ path: 'experiment.variants.A.stepSequence.8', message: 'Step "team_size" appears twice.' }]);
  });

  it('reports a condition on an unknown answer', () => {
    const raw = editedV1((r) => {
      r.steps.office_days.visibleWhen = { answer: 'commute', operator: 'eq', value: 'long' };
    });
    expect(errorsOf(raw)).toContainEqual({ path: 'steps.office_days.visibleWhen', message: 'Condition references unknown answer "commute".' });
  });

  it('reports a result rule with an unknown result', () => {
    const raw = editedV1((r) => {
      r.resultRules[1].resultId = 'ghost';
    });
    expect(errorsOf(raw)).toEqual([{ path: 'resultRules.1.resultId', message: 'Unknown result "ghost".' }]);
  });

  it('reports override keys that do not exist', () => {
    const raw = editedV1((r) => {
      r.experiment.variants.B.stepOverrides = { ghost: { content: { title: 'Boo' } } };
      r.experiment.variants.B.resultOverrides = { phantom: { title: 'Boo' } };
    });
    expect(errorsOf(raw)).toEqual([
      { path: 'experiment.variants.B.stepOverrides.ghost', message: 'Unknown step "ghost".' },
      { path: 'experiment.variants.B.resultOverrides.phantom', message: 'Unknown result "phantom".' },
    ]);
  });

  it('reports a result step that is not last', () => {
    const raw = editedV1((r) => {
      r.experiment.variants.A.stepSequence = ['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span', 'office_days', 'async_maturity', 'result', 'tool_count'];
    });
    expect(errorsOf(raw)).toEqual([
      { path: 'experiment.variants.A.stepSequence.7', message: 'The result step must be the last step.' },
      { path: 'experiment.variants.A.stepSequence', message: 'The sequence must end with a result step.' },
    ]);
  });

  it('rejects an unknown operator at the schema level', () => {
    const raw = editedV1((r) => {
      r.steps.office_days.visibleWhen = { answer: 'work_mode', operator: 'between', value: ['a', 'b'] };
    });
    expect(errorsOf(raw).map((issue) => issue.path)).toEqual(['steps.office_days.visibleWhen']);
  });
});
