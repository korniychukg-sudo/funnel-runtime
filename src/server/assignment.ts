import { createHash } from 'node:crypto';

function hashToUnitInterval(input: string): number {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 2 ** 32;
}

export function assignVariant(
  sessionId: string,
  experimentId: string,
  variants: Record<string, { weight: number }>,
): string {
  const keys = Object.keys(variants).sort();
  const totalWeight = keys.reduce((sum, key) => sum + variants[key].weight, 0);
  const point = hashToUnitInterval(`${experimentId}:${sessionId}`) * totalWeight;
  let cumulative = 0;
  for (const key of keys) {
    cumulative += variants[key].weight;
    if (point < cumulative) return key;
  }
  return keys[keys.length - 1];
}
