import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdminOverview, VersionSummary } from '../src/shared/api';
import { assignVariant } from '../src/server/assignment';
import { adminPost, createSession, createTestApp, post, readFixture } from './helpers';

const EXPERIMENT = 'question-order-and-result-framing-v1';
const EVEN = { A: { weight: 50 }, B: { weight: 50 } };

function shareOf(variant: string, assigned: string[]): number {
  return assigned.filter((value) => value === variant).length / assigned.length;
}

function versionTwoWithWeights(weightA: number, weightB: number): Record<string, unknown> {
  const config = readFixture('funnel-v1.json');
  const experiment = config.experiment as { variants: Record<string, { weight: number }> };
  experiment.variants.A.weight = weightA;
  experiment.variants.B.weight = weightB;
  return { ...config, version: 2 };
}

describe('variant assignment', () => {
  it('follows the documented hash formula', () => {
    for (let i = 0; i < 50; i++) {
      const sessionId = randomUUID();
      const hex = createHash('sha256').update(`${EXPERIMENT}:${sessionId}`).digest('hex').slice(0, 8);
      const expected = parseInt(hex, 16) / 2 ** 32 < 0.5 ? 'A' : 'B';
      expect(assignVariant(sessionId, EXPERIMENT, EVEN)).toBe(expected);
    }
  });

  it('is deterministic and independent of key order', () => {
    const sessionId = randomUUID();
    const first = assignVariant(sessionId, EXPERIMENT, EVEN);
    for (let i = 0; i < 10; i++) expect(assignVariant(sessionId, EXPERIMENT, EVEN)).toBe(first);
    expect(assignVariant(sessionId, EXPERIMENT, { B: { weight: 50 }, A: { weight: 50 } })).toBe(first);
  });

  it('splits 2000 random sessions close to 50/50', () => {
    const assigned = Array.from({ length: 2000 }, () => assignVariant(randomUUID(), EXPERIMENT, EVEN));
    expect(shareOf('A', assigned)).toBeGreaterThan(0.45);
    expect(shareOf('A', assigned)).toBeLessThan(0.55);
  });

  it('respects uneven weights', () => {
    const weights = { A: { weight: 90 }, B: { weight: 10 } };
    const assigned = Array.from({ length: 2000 }, () => assignVariant(randomUUID(), EXPERIMENT, weights));
    expect(shareOf('B', assigned)).toBeGreaterThan(0.05);
    expect(shareOf('B', assigned)).toBeLessThan(0.15);
  });
});

describe('variant stickiness over HTTP', () => {
  it('keeps the variant of a session across 20 resumes', async () => {
    const { app } = await createTestApp();
    const state = await createSession(app);
    expect(state.session.variant).toBe(assignVariant(state.session.id, EXPERIMENT, EVEN));

    for (let i = 0; i < 20; i++) {
      const resumed = await createSession(app, { sessionId: state.session.id });
      expect(resumed.session.id).toBe(state.session.id);
      expect(resumed.session.variant).toBe(state.session.variant);
      expect(resumed.funnel.sequence).toEqual(state.funnel.sequence);
    }
  });

  it('assigns both variants to new sessions', async () => {
    const { app } = await createTestApp();
    const assigned: string[] = [];
    for (let i = 0; i < 200; i++) assigned.push((await createSession(app)).session.variant);
    expect(shareOf('A', assigned)).toBeGreaterThan(0.35);
    expect(shareOf('A', assigned)).toBeLessThan(0.65);
  });

  it('applies the weights of a published config', async () => {
    const { app } = await createTestApp();
    const uploaded = await post(app, '/api/admin/versions', { config: versionTwoWithWeights(90, 10) });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    expect(uploaded.json<VersionSummary>().version).toBe(2);
    const published = await adminPost(app, '/versions/2/publish');
    expect(published.json<AdminOverview>().activeVersion).toBe(2);

    const assigned: string[] = [];
    for (let i = 0; i < 600; i++) assigned.push((await createSession(app)).session.variant);
    expect(shareOf('A', assigned)).toBeGreaterThan(0.85);
    expect(shareOf('A', assigned)).toBeLessThan(0.95);
  });

  it('honours an override and keeps it on resume', async () => {
    const { app } = await createTestApp();
    for (let i = 0; i < 10; i++) {
      const state = await createSession(app, { variant: 'B' });
      expect(state.session.variant).toBe('B');
      expect(state.session.assignmentSource).toBe('override');
      const resumed = await createSession(app, { sessionId: state.session.id });
      expect(resumed.session.variant).toBe('B');
    }
  });
});
