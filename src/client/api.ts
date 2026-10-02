import type {
  ApiError,
  CreateSessionRequest,
  NavigateRequest,
  SessionState,
  SubmitAnswerRequest,
} from '../shared/api';

const NETWORK_MESSAGE = 'We could not reach the server. Check your connection and try again.';

export class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function isSessionGone(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 404 || error.status === 410);
}

export function isConflict(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409;
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'Something went wrong. Please try again.';
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, NETWORK_MESSAGE);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(response.status, error.message ?? `The server answered with status ${response.status}.`);
  }
  return payload as T;
}

function sessionPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

export function createSession(body: CreateSessionRequest): Promise<SessionState> {
  return request('POST', '/api/sessions', body);
}

export function fetchSession(sessionId: string): Promise<SessionState> {
  return request('GET', sessionPath(sessionId));
}

export function submitAnswer(sessionId: string, body: SubmitAnswerRequest): Promise<SessionState> {
  return request('POST', `${sessionPath(sessionId)}/answers`, body);
}

export function navigateTo(sessionId: string, body: NavigateRequest): Promise<SessionState> {
  return request('POST', `${sessionPath(sessionId)}/navigate`, body);
}

export function requestResult(sessionId: string): Promise<SessionState> {
  return request('POST', `${sessionPath(sessionId)}/result`);
}
