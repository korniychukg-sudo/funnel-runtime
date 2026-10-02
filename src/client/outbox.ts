import type { IncomingEvent } from '../shared/api';

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type OutboxStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type OutboxFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'status'>>;

export type OutboxTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type OutboxOptions = {
  storage: OutboxStorage;
  fetch: OutboxFetch;
  timers?: OutboxTimers;
  endpoint?: string;
};

export const OUTBOX_KEY = 'funnel.outbox';
const BATCH_SIZE = 50;
const FLUSH_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const browserTimers: OutboxTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Outbox {
  private readonly storage: OutboxStorage;
  private readonly fetch: OutboxFetch;
  private readonly timers: OutboxTimers;
  private readonly endpoint: string;
  private queue: IncomingEvent[];
  private sending: Promise<void> | null = null;
  private timer: unknown = null;
  private failures = 0;

  constructor(options: OutboxOptions) {
    this.storage = options.storage;
    this.fetch = options.fetch;
    this.timers = options.timers ?? browserTimers;
    this.endpoint = options.endpoint ?? '/api/events';
    this.queue = this.load();
    if (this.queue.length > 0) this.schedule(FLUSH_DELAY_MS);
  }

  get pending(): readonly IncomingEvent[] {
    return this.queue;
  }

  enqueue(event: IncomingEvent): void {
    this.queue.push(event);
    this.save();
    if (this.failures === 0) this.schedule(FLUSH_DELAY_MS);
  }

  flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.sending) return this.sending;
    if (this.queue.length === 0) return Promise.resolve();
    this.cancelTimer();
    const batch = this.queue.slice(0, BATCH_SIZE);
    this.sending = this.deliver(batch, options.keepalive ?? false).finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async deliver(batch: IncomingEvent[], keepalive: boolean): Promise<void> {
    if (await this.post(batch, keepalive)) {
      const sent = new Set(batch.map((event) => event.event_id));
      this.queue = this.queue.filter((event) => !sent.has(event.event_id));
      this.save();
      this.failures = 0;
      if (this.queue.length > 0) this.schedule(0);
    } else {
      this.failures += 1;
      this.schedule(this.backoffDelay());
    }
  }

  private async post(batch: IncomingEvent[], keepalive: boolean): Promise<boolean> {
    const controller = new AbortController();
    const timeout = this.timers.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        keepalive,
        signal: controller.signal,
      });
      return response.status === 200;
    } catch {
      return false;
    } finally {
      this.timers.clearTimeout(timeout);
    }
  }

  private backoffDelay(): number {
    return Math.min(MIN_BACKOFF_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private load(): IncomingEvent[] {
    try {
      const stored: unknown = JSON.parse(this.storage.getItem(OUTBOX_KEY) ?? '[]');
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      this.storage.setItem(OUTBOX_KEY, JSON.stringify(this.queue));
    } catch (error) {
      console.warn('Events are kept in memory only: the outbox could not be saved.', error);
    }
  }
}

function memoryStorage(): KeyValueStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

export function browserStorage(): KeyValueStorage {
  try {
    return window.localStorage;
  } catch {
    return memoryStorage();
  }
}

function flushOnPageHide(outbox: Outbox): void {
  const flush = () => void outbox.flush({ keepalive: true });
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

let shared: Outbox | null = null;

export function sharedOutbox(): Outbox {
  if (!shared) {
    shared = new Outbox({ storage: browserStorage(), fetch: (url, init) => fetch(url, init) });
    flushOnPageHide(shared);
  }
  return shared;
}
