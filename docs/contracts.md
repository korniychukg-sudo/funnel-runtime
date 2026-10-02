# Contracts

This file fixed the interfaces between the parts of the system before they were built in parallel. It has since been updated to match the code after the review fixes (commit `17f36b7`). Shared types live in `src/shared/api.ts`; the funnel engine lives in `src/shared/engine.ts`; config parsing lives in `src/shared/config.ts`. Those three files are the source of truth for types.

## Layout

```
configs/                 funnel JSON fixtures (v1 is seeded on first boot; others are imported from the admin page)
src/shared/              code shared by browser, server, generator and tests (no Node or DOM APIs)
  config.ts              zod schema + semantic checks (parseFunnelConfig)
  conditions.ts          condition evaluator (eq, neq, in, not_in, contains, not_contains, gt, gte, lt, lte, answered; all/any/not)
  merge.ts               deepMerge used for variant overrides (objects merge, arrays replace, never mutates)
  engine.ts              resolveFunnel, effectiveAnswers, visibleSequence, next/prev, progress, validateAnswer, computeResultId
  api.ts                 HTTP DTOs, event wire format, analytics response
src/server/              Fastify app, SQLite (node:sqlite), routes, analytics
src/client/              React app: funnel runner (/), admin (/admin), dashboard (/dashboard)
scripts/                 traffic generator and verifier
tests/                   vitest
```

## Core rules

- Answers are keyed by `step.input.name`. Conditions reference that name.
- Navigation order always comes from `experiment.variants[variant].stepSequence`, never from the key order of `steps`.
- A step is visible when it has no `visibleWhen` or its condition is true on the *effective answers*: the answers to steps that are currently visible, evaluated in sequence order. Answers to hidden steps stay stored (so they prefill if the step reappears) but never affect visibility, results or completeness.
- Progress counts steps of the variant sequence whose type is not in `progress.excludeTypes`. With `countVisibleOnly`, a conditional step is counted while its condition is true or still unknown (its source answer not given yet), and dropped from the count once the condition is known to be false. The count therefore never makes a step appear after an apparent "last" one.
- The result is computed on the server: first matching `resultRules` entry on effective answers, else `defaultResultId`.
- `resolveFunnel(config, variant)` applies `stepOverrides` and `resultOverrides` with `deepMerge`. The client only ever receives a resolved funnel.

## Sessions

- Session TTL runs from creation: `expires_at = created_at + session.ttlHours`. An expired session is never resumed; the client gets a new session on the active version. Answers of expired sessions are purged (set to `{}`) by a periodic cleanup; events are kept.
- A session pins `version`, `experiment_id` and `variant` at creation. They never change.
- Variant assignment: `sha256(experimentId + ':' + sessionId)`, first 8 hex chars as an unsigned int divided by 2^32, mapped onto the cumulative weights of the variant keys sorted alphabetically. `assignment_source = 'hash'`.
- Override: the client forwards `?variant=X` as `CreateSessionRequest.variant`. It is honoured only when creating a session and only if `X` is a key of the active version's variants (case-sensitive). `assignment_source = 'override'`. If the client has a live session whose variant differs from the requested override, the server creates a new session with the override instead of resuming (a session's variant never changes). An unknown override value is ignored (hash assignment).
- `session_started` is written by the server inside the session-creation transaction with `event_id = <sessionId>:session_started`, `step_id = null`, `client_ts = null`. Clients may not send it.

### Endpoints

All bodies are JSON. Errors use `ApiError { error, message, details? }`.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/api/sessions` | `CreateSessionRequest` | 200 `SessionState` (`resumed` true when an existing session was returned) | 400, 503 `no_active_version` |
| GET | `/api/sessions/:id` | | 200 `SessionState` | 404 `session_not_found`, 410 `session_expired` |
| POST | `/api/sessions/:id/answers` | `SubmitAnswerRequest` | 200 `SessionState` | 404, 410, 409 `step_not_available`, 422 `invalid_answer` (`details.code` = `ValidationCode`) |
| POST | `/api/sessions/:id/navigate` | `NavigateRequest` | 200 `SessionState` | 404, 410, 409 `step_not_available` |
| POST | `/api/sessions/:id/result` | | 200 `SessionState` with `resultId` and `result` | 404, 410, 409 `incomplete` (`details.missing` = step ids) |
| POST | `/api/events` | `EventsRequest` | 200 `EventsResponse` | 400 only for a body that is not `{ events: [...] }` or has more than `MAX_EVENTS_PER_BATCH` items (`invalid_batch`; `bad_request` when the body is not valid JSON); 413 `payload_too_large` over 1 MB |
| GET | `/api/funnel/active` | | 200 `{ version, funnelId, title, experimentId, variants }` | 503 `no_active_version` |
| GET | `/api/health` | | 200 `{ ok: true, activeVersion }` | |
| GET | `/api/analytics` | query: `utm_campaign`, `version`, `run_id`, `include_overrides=1` | 200 `AnalyticsResponse` | 400 |
| GET | `/api/admin/overview` | | 200 `AdminOverview` | 401 |
| GET | `/api/admin/versions/:version` | | 200 `{ version, status, config }` | 401, 404 |
| POST | `/api/admin/versions` | `{ config: object }` | 201 `VersionSummary` (status `draft`) | 401, 422 `invalid_config` (`details` = `ConfigIssue[]`), 409 `version_exists` / `version_not_newer` |
| POST | `/api/admin/fixtures/:file/import` | | 201 `VersionSummary` | 401, 404, 409, 422 |
| POST | `/api/admin/versions/:version/publish` | | 200 `AdminOverview` | 401, 404, 409 `not_draft` |
| POST | `/api/admin/versions/:version/activate` | | 200 `AdminOverview` | 401, 404, 409 `not_activatable` |
| POST | `/api/admin/rollback` | | 200 `AdminOverview` | 401, 409 `nothing_to_rollback` |

- `answers`: the step must be in the sequence, interactive, visible, and every visible interactive step before it must hold a valid answer (`canNavigateTo`). The value is validated with `validateAnswer`; the normalised value is stored. After saving, `currentStepId = nextStepId(...) ?? resultStepId`. Changing any answer clears a stored `result_id`.
- `navigate`: used for intro → first question and for Back. Allowed when `canNavigateTo` is true; the result step additionally requires `isComplete`.
- `result`: requires `isComplete`; computes and stores `result_id`, sets `currentStepId` to the result step.
- Admin endpoints require header `x-admin-token` when the server runs with `ADMIN_TOKEN` set; otherwise they are open (local development, and the public demo on purpose). With a token set, `/admin` asks for it.
- JSON bodies: `__proto__` and `constructor.prototype` keys are stripped before validation instead of failing the request with 400, so a poisoned event item is handled on its own like any other item. An empty body with content-type `application/json` is treated as no body.
- Static files and SPA fallback (`@fastify/static` ^10.1.5, fastify 5.x): `index.html` is served only for `GET`/`HEAD` requests outside `/api` and `/assets` whose last path segment has no file extension. Everything else that matches no route, including missing files under `/assets`, `/favicon.ico` and `POST` to client routes, returns JSON `404 not_found`.

## Versions and rollback

- `funnel_versions.version` is the config's own `version`. An uploaded config must parse (`parseFunnelConfig`), must not reuse an existing version and must be greater than every stored version. It is stored as `draft`. The file's own `status` field is ignored; lifecycle lives in the database.
- The per-variant checks in `parseFunnelConfig` (first step not conditional, result step last and not conditional, sequence ends with a result step, no forward `visibleWhen` dependency) run on the steps after the variant's `stepOverrides` are applied. A duplicate answer name inside one variant is reported as `Answer name "X" is used by "a" and "b" in variant V.` at `experiment.variants.V.stepSequence.i`. `session.ttlHours` must be > 0 and <= 8760 (one year).
- Activation log (`activations`) is append-only: `seed`, `publish`, `activate`, `rollback`. The active version is computed by replaying the log as a stack: `seed`/`publish`/`activate` push a version, `rollback` pops the top. The active version is the top of the stack; the rollback target is the entry below it.
- `publish` (draft only): status → `published`, `published_at` set, push.
- `rollback`: pop; the version that was rolled back gets status `rolled_back`. Nothing is deleted: its sessions keep running on it and its events stay in analytics.
- `activate`: re-activate a `published` or `rolled_back` version that is not active (roll forward). Pushes.
- On first boot with an empty database the server imports `configs/funnel-v1.json` and activates it with action `seed`.
- Fixtures: every `*.json` in `configs/` is listed in `AdminOverview.fixtures` and can be imported as a draft with one click.

## Database (SQLite via `node:sqlite`)

The database file is `DB_PATH`, else `$RAILWAY_VOLUME_MOUNT_PATH/funnel.db` when that variable is set, else `./data/funnel.db` (`resolveDbPath` in `src/server/app.ts`). The resolved absolute path is logged once at boot (`Using database`, field `dbPath`).

Migrations are an ordered list of SQL scripts applied on boot and tracked with `PRAGMA user_version`. The schema is generic: no table or column depends on a particular config, so new steps, results and event names never need a migration.

```sql
CREATE TABLE funnel_versions (
  version       INTEGER PRIMARY KEY,
  funnel_id     TEXT NOT NULL,
  title         TEXT NOT NULL,
  config_json   TEXT NOT NULL,
  status        TEXT NOT NULL,            -- draft | published | rolled_back
  release_note  TEXT,
  created_at    TEXT NOT NULL,
  published_at  TEXT
);
CREATE TABLE activations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version       INTEGER NOT NULL REFERENCES funnel_versions(version),
  action        TEXT NOT NULL,            -- seed | publish | activate | rollback
  from_version  INTEGER,
  at            TEXT NOT NULL
);
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  funnel_id          TEXT NOT NULL,
  version            INTEGER NOT NULL REFERENCES funnel_versions(version),
  experiment_id      TEXT NOT NULL,
  variant            TEXT NOT NULL,
  assignment_source  TEXT NOT NULL,       -- hash | override
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
```

Arrival order of events is the implicit `rowid` of `events`.

## Event ingestion

`POST /api/events` validates every item on its own inside one transaction; a bad item never fails the batch.

1. Item must be an object with string `event_id`, `session_id` and `name` (1–128 chars each), an ISO-8601 `client_timestamp` with `Z` or an offset, and `properties` (if present) an object. Otherwise `rejected: invalid_event`.
2. The session must exist, else `rejected: unknown_session`. Expired sessions still accept events (late delivery is normal).
3. `name` must be in the **session's pinned version** `events.allowed`, else `rejected: event_not_allowed`. `session_started` from a client is `rejected: server_only`.
4. Context fields (`funnel_id`, `funnel_version`, `experiment_id`, `variant`) are stamped from the session. If the client sent a value that differs, `rejected: context_mismatch`. UTM fields are always stamped from the session (first touch), client values are ignored.
5. `step_id`: required for `step_viewed`, `answer_submitted`, `step_completed`, `back_clicked` and must belong to the session's variant sequence (`rejected: unknown_step`). For `result_viewed`, `cta_clicked`, `recommendation_expanded` a missing `step_id` is stamped with the result step id.
6. `properties`: only keys listed for that event in the pinned config are kept; other keys are dropped silently and are not validated. This is the guard that keeps raw answers out of analytics. The server sets `step_type` (`step_viewed`) and `answer_kind` (`answer_submitted`) from the type of the variant-resolved step (base step deep-merged with the variant's `stepOverrides`). Client values are ignored, and the property is added even when the client leaves it out, if the pinned config lists it.
7. Kept property values are validated, else `rejected: invalid_property`. Every value must be `null`, a boolean, a finite number or a string of at most 256 characters. `result_id` must be an own key of the pinned version's `results` (so `null`, `constructor` and ids of another version fail). `next_step_id` and `destination_step_id` must be in the session's variant `stepSequence`. `visible_step_index` and `visible_step_count` must be `null` or non-negative integers. These checks apply by property name to any event that lists the property.
8. `server_ts` is set by the server.
9. Insert with `INSERT OR IGNORE` on `event_id`. Ignored rows are `duplicate` (first write wins, also for a different payload with the same id).
10. Each request also appends one `ingest_batches` row with its counts.

## Client event emission

The client emits only events present in `funnel.allowedEvents` and only the properties listed there. Base fields come from the session.

| Event | When | `step_id` | Properties |
|---|---|---|---|
| `step_viewed` | every time a step is rendered (first load, refresh, after Back) | current step | `step_type` (set by the server), `visible_step_index` (null for info/result), `visible_step_count` |
| `answer_submitted` | the server accepted an answer | the answered step | `answer_kind` = step type (set by the server) |
| `step_completed` | right after `answer_submitted`, when navigation advances | the answered step | `next_step_id` |
| `back_clicked` | Back button or browser back | the step being left | `destination_step_id` |
| `result_viewed` | result content rendered | result step | `result_id` |
| `cta_clicked` | primary result CTA clicked | result step | `result_id`, `action` |
| `recommendation_expanded` | detailed recommendation opened after the CTA (only if allowed by the pinned version) | result step | `result_id`, `action`, `source` = `result_cta` |

The info step (intro) emits no `step_completed`: the config defines it for interactive steps only. Intro progression is measured by the next step being reached.

Runner behaviour that affects events:

- The opened action list is remembered per session (see Client storage). After a refresh the list stays open, no CTA button is offered, and `cta_clicked` / `recommendation_expanded` are not sent again.
- The "Question X of N" label follows the answer being edited once it passes `validateAnswer` (v3 variant B on `priorities`: 6 of 6 without `compliance`, 6 of 7 with it). `step_viewed.visible_step_index` and `visible_step_count` still use the stored answers, i.e. what was shown when the step rendered.
- Question inputs sit in a `<fieldset disabled>` while a submit is pending, so the choice cannot change mid-request.
- Browser Back pressed while a request is pending is remembered and runs as soon as that request finishes, provided the step then shown has a previous step.

Outbox: events are queued in `localStorage` (`funnel.outbox`) and sent in batches of up to 50 one second after the last enqueue. A regular batch uses `keepalive: true` when its serialized body is under 60 000 bytes (the browser's keepalive limit is about 64 KB); larger batches go without it. On `pagehide`, or `visibilitychange` to hidden, the first 50 or fewer queued events are sent with `keepalive: true` even while a regular batch is in flight; duplicates are harmless because `event_id` is idempotent. There is at most one regular batch and at most one page-exit request at a time. Events leave the queue only after a 200 response (accepted, duplicate and rejected items are all final). Network errors, timeouts (10 s) and any non-200 status keep the events and retry with exponential backoff (1 s up to 30 s); a queue that turns out empty resets the backoff.

Outbox in several tabs: every save re-reads `localStorage['funnel.outbox']`, keeps other tabs' events, and removes only the ids this tab got a 200 for. Events left behind by a closed tab are sent by the next page load. Events beyond the 50 sent on page exit wait in storage for the next visit.

Client storage (`localStorage`):

- `funnel.sessionId`: the current session. `?reset=1` clears it and starts a new session.
- `funnel.outbox`: the event queue (above).
- `funnel.expanded.<sessionId>`: the result id whose action list was opened, so a different result is not shown expanded. `?reset=1` deletes the key of the previous session.
- `funnel.adminToken`: used only by `/admin`; the admin token entered when the server runs with `ADMIN_TOKEN` and asked for it.

UTM parameters are read from the URL when the session is created. If the stored `funnel.sessionId` was sent on load and the server returned a different, non-resumed session that was not created by a `?variant` override (`assignmentSource != 'override'`), the runner shows "Your previous session has expired, so we started a new one."

## Analytics (pure function `computeAnalytics` in `src/server/analytics.ts`)

Input: session rows, event rows (with arrival `seq`), parsed configs by version, ingest totals, query.

- **Population.** Sessions filtered by `version`, `utm_campaign`, `run_id`. Everything is counted in unique sessions, never in events. Only events of sessions in the population are used. `utm_campaign=(none)` (the shared `NO_CAMPAIGN` constant) selects sessions whose `utm_campaign IS NULL`; the dashboard shows it as "(no campaign)". Sessions whose campaign is literally `(none)` cannot be selected: the filter matches only sessions with no campaign, and the literal value is not listed as a separate campaign.
- **Started** = sessions in the population (each has a server-written `session_started`).
- **Funnel** per `(version, variant)` in that variant's `stepSequence` order.
  - A session *reached* a step if it has `step_viewed`, `answer_submitted`, `step_completed` or `back_clicked` with that `step_id`.
  - Implied reach: for a step **without** `visibleWhen`, a session also reached it if it reached any later step of the sequence. Conditional steps are never implied, because whether they were visible depends on raw answers that analytics does not store. The first step is reached by every started session.
  - The result step is reached on `result_viewed`, `cta_clicked` or `recommendation_expanded`.
  - `furthest(session)` = the highest sequence index the session reached.
  - `progressed(step)` = reached the step and `furthest` is beyond it. `dropped(step)` = reached the step and `furthest` equals it. `conversion = progressed / reached`, `dropOffRate = dropped / reached`.
  - For the result step row: `reached` = result reached, `progressed` = CTA clicked, `dropped` = the rest. So its conversion is the CTA CTR.
  - `views` = raw count of `step_viewed` events for the step (shows repeats from Back and refresh).
  - All of this is set-based, so duplicates, repeated views, Back and arrival order cannot change the numbers.
- **KPIs.** `reachedResult` = sessions that reached the result step. `ctaClicked` = sessions with `cta_clicked`. `resultRate = reachedResult / started`, `ctr = ctaClicked / reachedResult`, `startedToCta = ctaClicked / started`. Rates are `null` when the denominator is 0.
- **Experiments.** Per version, per variant KPIs. Sessions with `assignment_source = 'override'` are excluded unless `include_overrides=1` (they are QA traffic, not randomised). For two variants: `absoluteDiff = B − A` of `startedToCta`, `relativeLift = diff / A`, `pValue` from a pooled two-proportion z-test, `significant = pValue < 0.05`. `pValue` and `significant` are `null` unless each variant has `n·p̂ >= 5` and `n·(1−p̂) >= 5`, where `p̂` is the pooled `startedToCta` rate of both variants; `absoluteDiff` and `relativeLift` are still reported, and the dashboard says "not enough data yet".
- **Versions.** Per version KPIs (all variants together). Funnel step lists differ between versions, so versions are compared on step-agnostic KPIs.
- **Result mix.** Per `(version, variant, result_id)`: sessions whose latest `result_viewed` (by `client_ts`, then arrival) carried that `result_id`.
- **Data quality.** `eventsStored` (population events), `duplicatesDropped` and `rejectedEvents` (global, from `ingest_batches`), `repeatedStepViews` = `step_viewed` events minus distinct `(session, step)` pairs, `backClicks`, `outOfOrderEvents` = events whose `client_ts` is earlier than an event of the same session that arrived before it, and the number of sessions with at least one such event. `events: EventCount[]` = `[{ name, events, sessions }]` per event name over the population (raw event count and unique sessions), sorted by name; the events add up to `eventsStored` and include the server-written `session_started`. The dashboard data-quality panel shows it as an "Events by name" table, which is where `recommendation_expanded` becomes visible. `KpiStats` has no `recommendationExpanded` field.
- `available.campaigns` and `available.versions` are computed over all sessions, ignoring filters. `available.campaigns` lists the named campaigns sorted, then `(none)` last, only when at least one session has no campaign.

## Synthetic traffic

`npm run generate -- --base-url http://localhost:3000 --sessions 150 --seed 42` drives real sessions through the HTTP API, tags them with a `runId`, sends events in batches with duplicate copies, re-sent batches (every sixth) and shuffled order, and writes the expected aggregates to `expected-<runId>.json`. `npm run verify -- --base-url ... --expected expected-<runId>.json` compares them with `GET /api/analytics?run_id=...`, including the per-campaign filter for `(none)`.

`--seed` fixes the behaviour model (answers, drop-offs, Back, delivery faults). Variants are assigned by the server from random session ids, so every run produces a different dataset and is checked against its own expected file. `--scenario iteration2` first checks `/api/admin/overview` and stops with a clear message if v3 is already imported. If a simulation fails midway, the events of the sessions that did start are still delivered. Generated `client_timestamp`s use the real clock.
