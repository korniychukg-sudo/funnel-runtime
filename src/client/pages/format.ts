import type { Rate } from '../../shared/api';

export const EMPTY = '—';

const countFormat = new Intl.NumberFormat('en-US');
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium' });

export function formatCount(value: number): string {
  return countFormat.format(value);
}

export function formatRate(rate: Rate): string {
  return rate === null ? EMPTY : `${(rate * 100).toFixed(1)}%`;
}

function signed(value: number, text: string): string {
  if (Number(text) === 0) return text;
  return value > 0 ? `+${text}` : `−${text}`;
}

export function formatPoints(diff: Rate): string {
  if (diff === null) return EMPTY;
  return `${signed(diff, Math.abs(diff * 100).toFixed(1))} pp`;
}

export function formatLift(lift: Rate): string {
  if (lift === null) return EMPTY;
  return `${signed(lift, Math.abs(lift * 100).toFixed(1))}%`;
}

export function formatPValue(pValue: number | null): string {
  if (pValue === null) return EMPTY;
  return pValue < 0.001 ? '< 0.001' : pValue.toFixed(3);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : timeFormat.format(date);
}

export function share(part: number, whole: number): Rate {
  return whole > 0 ? part / whole : null;
}

export function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;
}
