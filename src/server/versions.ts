import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Activation, AdminOverview, VersionStatus, VersionSummary } from '../shared/api';
import { parseFunnelConfig, type FunnelConfig } from '../shared/config';
import type { AppContext } from './app';
import { transaction } from './db';
import { HttpError } from './routes/http';
import {
  countByVersion,
  getVersion,
  insertActivation,
  insertVersion,
  listActivations,
  listVersions,
  markVersionPublished,
  maxVersion,
  setVersionStatus,
  type VersionRecord,
} from './store';

const SEED_FILE = 'funnel-v1.json';

type VersionState = { activeVersion: number | null; rollbackTarget: number | null };

function activationStack(activations: Activation[]): number[] {
  const stack: number[] = [];
  for (const activation of activations) {
    if (activation.action === 'rollback') stack.pop();
    else stack.push(activation.version);
  }
  return stack;
}

export function versionState(db: DatabaseSync): VersionState {
  const stack = activationStack(listActivations(db));
  return { activeVersion: stack.at(-1) ?? null, rollbackTarget: stack.at(-2) ?? null };
}

export function requireActiveVersion(db: DatabaseSync): number {
  const { activeVersion } = versionState(db);
  if (activeVersion === null) throw new HttpError(503, 'no_active_version', 'No funnel version is active.');
  return activeVersion;
}

function requireVersion(db: DatabaseSync, version: number): VersionRecord {
  const record = Number.isInteger(version) ? getVersion(db, version) : null;
  if (!record) throw new HttpError(404, 'version_not_found', `Version ${version} does not exist.`);
  return record;
}

function parseOrThrow(input: unknown): FunnelConfig {
  const parsed = parseFunnelConfig(input);
  if (!parsed.ok) throw new HttpError(422, 'invalid_config', 'The config is not valid.', parsed.errors);
  const config = { ...parsed.config };
  delete config.status;
  return config;
}

function newVersionRecord(config: FunnelConfig, status: VersionStatus, at: string): VersionRecord {
  return {
    version: config.version,
    funnelId: config.funnelId,
    title: config.title,
    config,
    status,
    releaseNote: config.releaseNote ?? null,
    createdAt: at,
    publishedAt: status === 'published' ? at : null,
  };
}

export function seedIfEmpty(ctx: AppContext): void {
  if (maxVersion(ctx.db) !== null) return;
  const config = parseOrThrow(JSON.parse(readFileSync(join(ctx.configsDir, SEED_FILE), 'utf8')));
  const at = ctx.now().toISOString();
  transaction(ctx.db, () => {
    insertVersion(ctx.db, newVersionRecord(config, 'published', at));
    insertActivation(ctx.db, { version: config.version, action: 'seed', fromVersion: null, at });
  });
}

export function uploadVersion(ctx: AppContext, input: unknown): VersionSummary {
  const config = parseOrThrow(input);
  transaction(ctx.db, () => {
    if (getVersion(ctx.db, config.version)) {
      throw new HttpError(409, 'version_exists', `Version ${config.version} already exists.`);
    }
    const latest = maxVersion(ctx.db);
    if (latest !== null && config.version < latest) {
      throw new HttpError(409, 'version_not_newer', `Version ${config.version} must be greater than ${latest}.`);
    }
    insertVersion(ctx.db, newVersionRecord(config, 'draft', ctx.now().toISOString()));
  });
  return toSummary(requireVersion(ctx.db, config.version), null, 0, 0);
}

function listFixtures(configsDir: string): string[] {
  if (!existsSync(configsDir)) return [];
  return readdirSync(configsDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
}

export function importFixture(ctx: AppContext, file: string): VersionSummary {
  if (!listFixtures(ctx.configsDir).includes(file)) {
    throw new HttpError(404, 'fixture_not_found', `Fixture ${file} does not exist.`);
  }
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(join(ctx.configsDir, file), 'utf8'));
  } catch {
    throw new HttpError(422, 'invalid_config', `Fixture ${file} is not valid JSON.`);
  }
  return uploadVersion(ctx, input);
}

export function publishVersion(ctx: AppContext, version: number): void {
  transaction(ctx.db, () => {
    const record = requireVersion(ctx.db, version);
    if (record.status !== 'draft') throw new HttpError(409, 'not_draft', `Version ${version} is not a draft.`);
    const at = ctx.now().toISOString();
    const { activeVersion } = versionState(ctx.db);
    markVersionPublished(ctx.db, version, at);
    insertActivation(ctx.db, { version, action: 'publish', fromVersion: activeVersion, at });
  });
}

export function activateVersion(ctx: AppContext, version: number): void {
  transaction(ctx.db, () => {
    const record = requireVersion(ctx.db, version);
    const { activeVersion } = versionState(ctx.db);
    if (record.status === 'draft' || version === activeVersion) {
      throw new HttpError(409, 'not_activatable', `Version ${version} cannot be activated.`);
    }
    setVersionStatus(ctx.db, version, 'published');
    insertActivation(ctx.db, { version, action: 'activate', fromVersion: activeVersion, at: ctx.now().toISOString() });
  });
}

export function rollback(ctx: AppContext): void {
  transaction(ctx.db, () => {
    const { activeVersion, rollbackTarget } = versionState(ctx.db);
    if (activeVersion === null || rollbackTarget === null) {
      throw new HttpError(409, 'nothing_to_rollback', 'There is no previous version to roll back to.');
    }
    setVersionStatus(ctx.db, activeVersion, 'rolled_back');
    setVersionStatus(ctx.db, rollbackTarget, 'published');
    insertActivation(ctx.db, {
      version: rollbackTarget,
      action: 'rollback',
      fromVersion: activeVersion,
      at: ctx.now().toISOString(),
    });
  });
}

export function versionDetail(ctx: AppContext, version: number): { version: number; status: VersionStatus; config: FunnelConfig } {
  const record = requireVersion(ctx.db, version);
  return { version: record.version, status: record.status, config: record.config };
}

function toSummary(record: VersionRecord, activeVersion: number | null, sessions: number, events: number): VersionSummary {
  return {
    version: record.version,
    funnelId: record.funnelId,
    title: record.title,
    status: record.status,
    isActive: record.version === activeVersion,
    releaseNote: record.releaseNote,
    experimentId: record.config.experiment.id,
    variants: Object.keys(record.config.experiment.variants),
    createdAt: record.createdAt,
    publishedAt: record.publishedAt,
    sessions,
    events,
  };
}

export function adminOverview(ctx: AppContext): AdminOverview {
  const activations = listActivations(ctx.db);
  const stack = activationStack(activations);
  const activeVersion = stack.at(-1) ?? null;
  const sessions = countByVersion(ctx.db, 'sessions');
  const events = countByVersion(ctx.db, 'events');
  return {
    activeVersion,
    rollbackTarget: stack.at(-2) ?? null,
    versions: listVersions(ctx.db).map((record) =>
      toSummary(record, activeVersion, sessions.get(record.version) ?? 0, events.get(record.version) ?? 0),
    ),
    activations,
    fixtures: listFixtures(ctx.configsDir),
    adminTokenRequired: ctx.adminToken !== null,
  };
}
