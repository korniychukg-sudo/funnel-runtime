export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return structuredClone(base);
  if (!isPlainObject(base) || !isPlainObject(override)) return structuredClone(override) as T;
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
  for (const key of keys) {
    const b = base[key];
    const o = override[key];
    if (!(key in override)) out[key] = structuredClone(b);
    else if (isPlainObject(b) && isPlainObject(o)) out[key] = deepMerge(b, o);
    else out[key] = structuredClone(o);
  }
  return out as T;
}
