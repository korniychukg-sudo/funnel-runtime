import type { EventsResponse, IncomingEvent, SessionState, Utm } from '../../src/shared/api';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

export function createClient(baseUrl: string, adminToken?: string) {
  const root = baseUrl.replace(/\/$/, '');

  async function request<T>(method: string, path: string, body?: unknown, admin = false): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (admin && adminToken) headers['x-admin-token'] = adminToken;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${root}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        const parsed = text ? JSON.parse(text) : null;
        if (!res.ok) throw new HttpError(res.status, parsed);
        return parsed as T;
      } catch (error) {
        const retryable = !(error instanceof HttpError) || error.status >= 500;
        if (!retryable || attempt >= 3) throw error;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }

  return {
    createSession: (utm: Partial<Utm>, runId: string, sessionId?: string) =>
      request<SessionState>('POST', '/api/sessions', { utm, runId, sessionId }),
    getSession: (id: string) => request<SessionState>('GET', `/api/sessions/${id}`),
    answer: (id: string, stepId: string, value: unknown) =>
      request<SessionState>('POST', `/api/sessions/${id}/answers`, { stepId, value }),
    navigate: (id: string, stepId: string) => request<SessionState>('POST', `/api/sessions/${id}/navigate`, { stepId }),
    result: (id: string) => request<SessionState>('POST', `/api/sessions/${id}/result`),
    sendEvents: (events: IncomingEvent[]) => request<EventsResponse>('POST', '/api/events', { events }),
    analytics: (query: Record<string, string>) =>
      request<unknown>('GET', `/api/analytics?${new URLSearchParams(query).toString()}`),
    adminOverview: () =>
      request<{ activeVersion: number | null; fixtures: string[]; versions: Array<{ version: number }> }>(
        'GET',
        '/api/admin/overview',
        undefined,
        true,
      ),
    importFixture: (file: string) => request<{ version: number }>('POST', `/api/admin/fixtures/${encodeURIComponent(file)}/import`, undefined, true),
    publish: (version: number) => request<unknown>('POST', `/api/admin/versions/${version}/publish`, undefined, true),
    rollback: () => request<{ activeVersion: number | null }>('POST', '/api/admin/rollback', undefined, true),
  };
}

export type Client = ReturnType<typeof createClient>;
