import type {
  AdminOverview,
  AnalyticsQuery,
  AnalyticsResponse,
  ApiError,
  VersionStatus,
  VersionSummary,
} from '../shared/api';
import type { ConfigIssue } from '../shared/config';

const ADMIN_TOKEN_KEY = 'funnel.adminToken';

export type VersionDetail = { version: number; status: VersionStatus; config: unknown };

export type ErrorMessage = { message: string; details?: unknown };

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, body: ApiError) {
    super(body.message);
    this.name = 'RequestError';
    this.status = status;
    this.code = body.error;
    this.details = body.details;
  }
}

let memoryToken: string | null = null;

function withStorage<T>(use: (storage: Storage) => T, fallback: T): T {
  try {
    return use(window.localStorage);
  } catch {
    return fallback;
  }
}

export function readAdminToken(): string | null {
  return withStorage((storage) => storage.getItem(ADMIN_TOKEN_KEY), null) ?? memoryToken;
}

export function saveAdminToken(token: string): void {
  memoryToken = token;
  withStorage((storage) => storage.setItem(ADMIN_TOKEN_KEY, token), undefined);
}

export function asRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RequestError(0, { error: 'client_error', message });
}

export function isUnauthorized(error: RequestError): boolean {
  return error.status === 401;
}

export function configIssues(details: unknown): ConfigIssue[] {
  if (!Array.isArray(details)) return [];
  return details.filter(
    (item): item is ConfigIssue =>
      typeof item === 'object' && item !== null && typeof item.path === 'string' && typeof item.message === 'string',
  );
}

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ApiError>;
  return typeof candidate.error === 'string' && typeof candidate.message === 'string';
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type RequestOptions = { method?: 'GET' | 'POST'; body?: unknown };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = readAdminToken();
  if (token) headers['x-admin-token'] = token;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new RequestError(0, {
      error: 'network_error',
      message: 'Could not reach the server. Check that it is running and try again.',
    });
  }

  const payload = await readJson(response);
  if (!response.ok) {
    if (isApiError(payload)) throw new RequestError(response.status, payload);
    throw new RequestError(response.status, {
      error: 'http_error',
      message: `The server answered with status ${response.status}.`,
    });
  }
  if (payload === null) {
    throw new RequestError(response.status, {
      error: 'invalid_response',
      message: 'The server sent a response that is not JSON.',
    });
  }
  return payload as T;
}

export function fetchOverview(): Promise<AdminOverview> {
  return request('/api/admin/overview');
}

export function fetchVersion(version: number): Promise<VersionDetail> {
  return request(`/api/admin/versions/${version}`);
}

export function importConfig(config: unknown): Promise<VersionSummary> {
  return request('/api/admin/versions', { method: 'POST', body: { config } });
}

export function importFixture(file: string): Promise<VersionSummary> {
  return request(`/api/admin/fixtures/${encodeURIComponent(file)}/import`, { method: 'POST' });
}

export function publishVersion(version: number): Promise<AdminOverview> {
  return request(`/api/admin/versions/${version}/publish`, { method: 'POST' });
}

export function activateVersion(version: number): Promise<AdminOverview> {
  return request(`/api/admin/versions/${version}/activate`, { method: 'POST' });
}

export function rollbackVersion(): Promise<AdminOverview> {
  return request('/api/admin/rollback', { method: 'POST' });
}

export function analyticsSearchParams(query: AnalyticsQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.utmCampaign) params.set('utm_campaign', query.utmCampaign);
  if (query.version !== undefined) params.set('version', String(query.version));
  if (query.runId) params.set('run_id', query.runId);
  if (query.includeOverrides) params.set('include_overrides', '1');
  return params;
}

export function parseAnalyticsSearch(search: string): AnalyticsQuery {
  const params = new URLSearchParams(search);
  const query: AnalyticsQuery = {};
  const campaign = params.get('utm_campaign');
  if (campaign) query.utmCampaign = campaign;
  const version = Number(params.get('version'));
  if (Number.isInteger(version) && version > 0) query.version = version;
  const runId = params.get('run_id');
  if (runId) query.runId = runId;
  if (params.get('include_overrides') === '1') query.includeOverrides = true;
  return query;
}

export function fetchAnalytics(query: AnalyticsQuery): Promise<AnalyticsResponse> {
  const search = analyticsSearchParams(query).toString();
  return request(search ? `/api/analytics?${search}` : '/api/analytics');
}
