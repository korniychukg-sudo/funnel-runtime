import { describe, expect, it } from 'vitest';
import type { IncomingEvent } from '../src/shared/api';
import { Outbox, OUTBOX_KEY, type OutboxFetch, type OutboxStorage, type OutboxTimers } from '../src/client/outbox';

class MemoryStorage implements OutboxStorage {
  private readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  storedIds(): string[] {
    return (JSON.parse(this.getItem(OUTBOX_KEY) ?? '[]') as IncomingEvent[]).map((event) => event.event_id);
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeClock implements OutboxTimers {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingDelays(): number[] {
    return [...this.timers.values()].map((timer) => timer.at - this.now).sort((a, b) => a - b);
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.now = timer.at;
      timer.callback();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

type Reply = number | 'network-error' | 'hang';

function fakeFetch(replies: Reply[]) {
  const calls: { ids: string[]; init: RequestInit }[] = [];
  const fetch: OutboxFetch = (_url, init) => {
    const body = JSON.parse(String(init.body)) as { events: IncomingEvent[] };
    calls.push({ ids: body.events.map((event) => event.event_id), init });
    const reply = replies.shift() ?? 200;
    if (reply === 'network-error') return Promise.reject(new TypeError('Failed to fetch'));
    if (reply === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    return Promise.resolve({ status: reply });
  };
  return { fetch, calls };
}

function event(n: number): IncomingEvent {
  return {
    event_id: `event-${n}`,
    session_id: 'session-1',
    name: 'step_viewed',
    client_timestamp: new Date(0).toISOString(),
    step_id: 'intro',
  };
}

function setup(replies: Reply[] = []) {
  const storage = new MemoryStorage();
  const clock = new FakeClock();
  const network = fakeFetch(replies);
  const outbox = new Outbox({ storage, fetch: network.fetch, timers: clock });
  return { storage, clock, network, outbox };
}

describe('Outbox', () => {
  it('sends one second after the last enqueue', async () => {
    const { clock, network, outbox } = setup();
    outbox.enqueue(event(1));
    await clock.advance(900);
    outbox.enqueue(event(2));
    await clock.advance(900);
    expect(network.calls).toHaveLength(0);

    await clock.advance(100);
    expect(network.calls.map((call) => call.ids)).toEqual([['event-1', 'event-2']]);
    expect(outbox.pending).toHaveLength(0);
  });

  it('splits the queue into batches of at most 50 events', async () => {
    const { storage, clock, network, outbox } = setup();
    for (let n = 1; n <= 120; n++) outbox.enqueue(event(n));

    await clock.advance(1_000);

    expect(network.calls.map((call) => call.ids.length)).toEqual([50, 50, 20]);
    expect(network.calls[0].ids[0]).toBe('event-1');
    expect(network.calls[2].ids.at(-1)).toBe('event-120');
    expect(storage.storedIds()).toEqual([]);
  });

  it('removes only the batch that got a 200 response', async () => {
    const { storage, clock, network, outbox } = setup([200, 'hang']);
    for (let n = 1; n <= 60; n++) outbox.enqueue(event(n));

    await clock.advance(1_000);

    expect(network.calls).toHaveLength(2);
    expect(storage.storedIds()).toEqual(network.calls[1].ids);
    expect(storage.storedIds()).toHaveLength(10);
  });

  it('keeps queued events across a page refresh', async () => {
    const storage = new MemoryStorage();
    const first = new Outbox({ storage, fetch: fakeFetch([]).fetch, timers: new FakeClock() });
    first.enqueue(event(1));
    first.enqueue(event(2));

    const clock = new FakeClock();
    const network = fakeFetch([]);
    const afterRefresh = new Outbox({ storage, fetch: network.fetch, timers: clock });
    expect(afterRefresh.pending.map((item) => item.event_id)).toEqual(['event-1', 'event-2']);

    await clock.advance(1_000);
    expect(network.calls.map((call) => call.ids)).toEqual([['event-1', 'event-2']]);
    expect(storage.storedIds()).toEqual([]);
  });

  it('starts empty when the stored queue is corrupted', () => {
    const storage = new MemoryStorage();
    storage.setItem(OUTBOX_KEY, '{not json');
    const outbox = new Outbox({ storage, fetch: fakeFetch([]).fetch, timers: new FakeClock() });
    expect(outbox.pending).toEqual([]);
  });

  it('retries the same event ids after a 10 s timeout', async () => {
    const { storage, clock, network, outbox } = setup(['hang', 200]);
    outbox.enqueue(event(1));
    outbox.enqueue(event(2));

    await clock.advance(1_000);
    expect(network.calls).toHaveLength(1);
    await clock.advance(9_999);
    expect(storage.storedIds()).toEqual(['event-1', 'event-2']);

    await clock.advance(1);
    expect(network.calls[0].init.signal?.aborted).toBe(true);
    expect(clock.pendingDelays()).toEqual([1_000]);

    await clock.advance(1_000);
    expect(network.calls).toHaveLength(2);
    expect(network.calls[1].ids).toEqual(network.calls[0].ids);
    expect(storage.storedIds()).toEqual([]);
  });

  it('backs off exponentially on 5xx and network errors and keeps the batch', async () => {
    const { storage, clock, network, outbox } = setup([503, 'network-error', 500, 200]);
    outbox.enqueue(event(1));

    await clock.advance(1_000);
    expect(clock.pendingDelays()).toEqual([1_000]);
    await clock.advance(1_000);
    expect(clock.pendingDelays()).toEqual([2_000]);
    await clock.advance(2_000);
    expect(clock.pendingDelays()).toEqual([4_000]);
    expect(storage.storedIds()).toEqual(['event-1']);

    await clock.advance(4_000);
    expect(network.calls).toHaveLength(4);
    expect(new Set(network.calls.map((call) => call.ids.join()))).toEqual(new Set(['event-1']));
    expect(storage.storedIds()).toEqual([]);
    expect(clock.pendingDelays()).toEqual([]);
  });

  it('caps the backoff at 30 s', async () => {
    const { clock, outbox } = setup(Array(8).fill(503));
    outbox.enqueue(event(1));
    await clock.advance(1_000);

    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const [delay] = clock.pendingDelays();
      delays.push(delay);
      await clock.advance(delay);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('does not reset a pending backoff when new events arrive', async () => {
    const { clock, outbox } = setup([503, 503]);
    outbox.enqueue(event(1));
    await clock.advance(1_000);
    await clock.advance(1_000);
    expect(clock.pendingDelays()).toEqual([2_000]);

    outbox.enqueue(event(2));
    expect(clock.pendingDelays()).toEqual([2_000]);
  });

  it('never sends the same batch twice at the same time', async () => {
    const { clock, network, outbox } = setup(['hang']);
    outbox.enqueue(event(1));
    await clock.advance(1_000);

    void outbox.flush();
    void outbox.flush({ keepalive: true });
    outbox.enqueue(event(2));
    await clock.advance(1_000);

    expect(network.calls).toHaveLength(1);
  });

  it('uses keepalive for the page-exit flush', async () => {
    const { network, outbox } = setup();
    outbox.enqueue(event(1));

    await outbox.flush({ keepalive: true });

    expect(network.calls).toHaveLength(1);
    expect(network.calls[0].init.keepalive).toBe(true);
    expect(outbox.pending).toHaveLength(0);
  });
});
