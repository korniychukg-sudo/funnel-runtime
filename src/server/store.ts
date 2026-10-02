import type { DatabaseSync } from 'node:sqlite';
import type { Answers } from '../shared/conditions';
import type { FunnelConfig } from '../shared/config';
import type { Activation, ActivationAction, AssignmentSource, VersionStatus } from '../shared/api';
import type { AnalyticsEventRow, AnalyticsSessionRow, IngestTotals } from './analytics';

export type VersionRecord = {
  version: number;
  funnelId: string;
  title: string;
  config: FunnelConfig;
  status: VersionStatus;
  releaseNote: string | null;
  createdAt: string;
  publishedAt: string | null;
};

export type SessionRecord = {
  id: string;
  funnelId: string;
  version: number;
  experimentId: string;
  variant: string;
  assignmentSource: AssignmentSource;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  runId: string | null;
  answers: Answers;
  currentStepId: string;
  resultId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type StoredEvent = {
  eventId: string;
  sessionId: string;
  name: string;
  stepId: string | null;
  funnelId: string;
  funnelVersion: number;
  experimentId: string;
  variant: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  clientTs: string | null;
  serverTs: string;
  properties: Record<string, unknown>;
};

export type IngestBatch = { receivedAt: string; total: number; accepted: number; duplicates: number; rejected: number };

type VersionRow = {
  version: number;
  funnel_id: string;
  title: string;
  config_json: string;
  status: VersionStatus;
  release_note: string | null;
  created_at: string;
  published_at: string | null;
};

type SessionRow = {
  id: string;
  funnel_id: string;
  version: number;
  experiment_id: string;
  variant: string;
  assignment_source: AssignmentSource;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  run_id: string | null;
  answers_json: string;
  current_step_id: string;
  result_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

function toVersionRecord(row: VersionRow): VersionRecord {
  return {
    version: row.version,
    funnelId: row.funnel_id,
    title: row.title,
    config: JSON.parse(row.config_json) as FunnelConfig,
    status: row.status,
    releaseNote: row.release_note,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    funnelId: row.funnel_id,
    version: row.version,
    experimentId: row.experiment_id,
    variant: row.variant,
    assignmentSource: row.assignment_source,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    runId: row.run_id,
    answers: JSON.parse(row.answers_json) as Answers,
    currentStepId: row.current_step_id,
    resultId: row.result_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export function insertVersion(db: DatabaseSync, record: VersionRecord): void {
  db.prepare(
    `INSERT INTO funnel_versions (version, funnel_id, title, config_json, status, release_note, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.version,
    record.funnelId,
    record.title,
    JSON.stringify(record.config),
    record.status,
    record.releaseNote,
    record.createdAt,
    record.publishedAt,
  );
}

export function getVersion(db: DatabaseSync, version: number): VersionRecord | null {
  const row = db.prepare('SELECT * FROM funnel_versions WHERE version = ?').get(version) as VersionRow | undefined;
  return row ? toVersionRecord(row) : null;
}

export function listVersions(db: DatabaseSync): VersionRecord[] {
  const rows = db.prepare('SELECT * FROM funnel_versions ORDER BY version').all() as VersionRow[];
  return rows.map(toVersionRecord);
}

export function maxVersion(db: DatabaseSync): number | null {
  const row = db.prepare('SELECT MAX(version) AS version FROM funnel_versions').get() as { version: number | null };
  return row.version;
}

export function setVersionStatus(db: DatabaseSync, version: number, status: VersionStatus): void {
  db.prepare('UPDATE funnel_versions SET status = ? WHERE version = ?').run(status, version);
}

export function markVersionPublished(db: DatabaseSync, version: number, publishedAt: string): void {
  db.prepare(`UPDATE funnel_versions SET status = 'published', published_at = ? WHERE version = ?`).run(
    publishedAt,
    version,
  );
}

export function insertActivation(
  db: DatabaseSync,
  activation: { version: number; action: ActivationAction; fromVersion: number | null; at: string },
): void {
  db.prepare('INSERT INTO activations (version, action, from_version, at) VALUES (?, ?, ?, ?)').run(
    activation.version,
    activation.action,
    activation.fromVersion,
    activation.at,
  );
}

export function listActivations(db: DatabaseSync): Activation[] {
  return db
    .prepare('SELECT id, version, action, from_version AS fromVersion, at FROM activations ORDER BY id')
    .all() as Activation[];
}

export function countByVersion(db: DatabaseSync, table: 'sessions' | 'events'): Map<number, number> {
  const column = table === 'sessions' ? 'version' : 'funnel_version';
  const rows = db.prepare(`SELECT ${column} AS version, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all() as {
    version: number;
    count: number;
  }[];
  return new Map(rows.map((row) => [row.version, row.count]));
}

export function insertSession(db: DatabaseSync, session: SessionRecord): void {
  db.prepare(
    `INSERT INTO sessions (id, funnel_id, version, experiment_id, variant, assignment_source, utm_source, utm_medium,
       utm_campaign, run_id, answers_json, current_step_id, result_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.funnelId,
    session.version,
    session.experimentId,
    session.variant,
    session.assignmentSource,
    session.utmSource,
    session.utmMedium,
    session.utmCampaign,
    session.runId,
    JSON.stringify(session.answers),
    session.currentStepId,
    session.resultId,
    session.createdAt,
    session.updatedAt,
    session.expiresAt,
  );
}

export function getSession(db: DatabaseSync, id: string): SessionRecord | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? toSessionRecord(row) : null;
}

export function updateSessionProgress(db: DatabaseSync, session: SessionRecord): void {
  db.prepare(
    'UPDATE sessions SET answers_json = ?, current_step_id = ?, result_id = ?, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify(session.answers), session.currentStepId, session.resultId, session.updatedAt, session.id);
}

export function purgeExpiredAnswers(db: DatabaseSync, nowIso: string): number {
  const result = db
    .prepare(`UPDATE sessions SET answers_json = '{}' WHERE expires_at <= ? AND answers_json != '{}'`)
    .run(nowIso);
  return Number(result.changes);
}

export function insertEvent(db: DatabaseSync, event: StoredEvent): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO events (event_id, session_id, name, step_id, funnel_id, funnel_version, experiment_id,
         variant, utm_source, utm_medium, utm_campaign, client_ts, server_ts, properties_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.eventId,
      event.sessionId,
      event.name,
      event.stepId,
      event.funnelId,
      event.funnelVersion,
      event.experimentId,
      event.variant,
      event.utmSource,
      event.utmMedium,
      event.utmCampaign,
      event.clientTs,
      event.serverTs,
      JSON.stringify(event.properties),
    );
  return Number(result.changes) > 0;
}

export function insertIngestBatch(db: DatabaseSync, batch: IngestBatch): void {
  db.prepare('INSERT INTO ingest_batches (received_at, total, accepted, duplicates, rejected) VALUES (?, ?, ?, ?, ?)').run(
    batch.receivedAt,
    batch.total,
    batch.accepted,
    batch.duplicates,
    batch.rejected,
  );
}

export function ingestTotals(db: DatabaseSync): IngestTotals {
  const row = db
    .prepare('SELECT COALESCE(SUM(duplicates), 0) AS duplicates, COALESCE(SUM(rejected), 0) AS rejected FROM ingest_batches')
    .get() as IngestTotals;
  return { duplicates: row.duplicates, rejected: row.rejected };
}

export function listAnalyticsSessions(db: DatabaseSync): AnalyticsSessionRow[] {
  return db
    .prepare(
      `SELECT id, version, experiment_id AS experimentId, variant, assignment_source AS assignmentSource,
         utm_campaign AS utmCampaign, run_id AS runId, created_at AS createdAt
       FROM sessions`,
    )
    .all() as AnalyticsSessionRow[];
}

export function listAnalyticsEvents(db: DatabaseSync): AnalyticsEventRow[] {
  const rows = db
    .prepare(
      `SELECT rowid AS seq, event_id AS eventId, session_id AS sessionId, name, step_id AS stepId,
         funnel_version AS version, variant, client_ts AS clientTs, server_ts AS serverTs, properties_json
       FROM events ORDER BY rowid`,
    )
    .all() as (Omit<AnalyticsEventRow, 'properties'> & { properties_json: string })[];
  return rows.map(({ properties_json, ...row }) => ({
    ...row,
    properties: JSON.parse(properties_json) as Record<string, unknown>,
  }));
}
