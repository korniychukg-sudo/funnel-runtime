import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE funnel_versions (
    version       INTEGER PRIMARY KEY,
    funnel_id     TEXT NOT NULL,
    title         TEXT NOT NULL,
    config_json   TEXT NOT NULL,
    status        TEXT NOT NULL,
    release_note  TEXT,
    created_at    TEXT NOT NULL,
    published_at  TEXT
  );
  CREATE TABLE activations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    version       INTEGER NOT NULL REFERENCES funnel_versions(version),
    action        TEXT NOT NULL,
    from_version  INTEGER,
    at            TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id                 TEXT PRIMARY KEY,
    funnel_id          TEXT NOT NULL,
    version            INTEGER NOT NULL REFERENCES funnel_versions(version),
    experiment_id      TEXT NOT NULL,
    variant            TEXT NOT NULL,
    assignment_source  TEXT NOT NULL,
    utm_source         TEXT,
    utm_medium         TEXT,
    utm_campaign       TEXT,
    run_id             TEXT,
    answers_json       TEXT NOT NULL DEFAULT '{}',
    current_step_id    TEXT NOT NULL,
    result_id          TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    expires_at         TEXT NOT NULL
  );
  CREATE TABLE events (
    event_id         TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL,
    name             TEXT NOT NULL,
    step_id          TEXT,
    funnel_id        TEXT NOT NULL,
    funnel_version   INTEGER NOT NULL,
    experiment_id    TEXT NOT NULL,
    variant          TEXT NOT NULL,
    utm_source       TEXT,
    utm_medium       TEXT,
    utm_campaign     TEXT,
    client_ts        TEXT,
    server_ts        TEXT NOT NULL,
    properties_json  TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_session ON events(session_id);
  CREATE INDEX events_version_variant ON events(funnel_version, variant);
  CREATE TABLE ingest_batches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at  TEXT NOT NULL,
    total        INTEGER NOT NULL,
    accepted     INTEGER NOT NULL,
    duplicates   INTEGER NOT NULL,
    rejected     INTEGER NOT NULL
  );
  `,
  `CREATE INDEX sessions_expires_at ON sessions(expires_at);`,
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let index = row.user_version; index < MIGRATIONS.length; index++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }
}
