import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { IncomingEvent, Utm } from '../src/shared/api';
import { createRandom, parseArgs, type Random } from './lib/args';
import { createClient, type Client } from './lib/http';
import { DEFAULT_BEHAVIOUR, SessionSimulation } from './lib/simulate';
import { buildExpected, type Expected } from './lib/truth';

const CAMPAIGNS: Utm[] = [
  { source: 'google', medium: 'cpc', campaign: 'remote_ops_search' },
  { source: 'facebook', medium: 'paid_social', campaign: 'hybrid_rules_video' },
  { source: 'linkedin', medium: 'paid_social', campaign: 'ops_leaders_q4' },
  { source: 'newsletter', medium: 'email', campaign: 'october_digest' },
  { source: 'direct', medium: null, campaign: null },
];

const USAGE = `Usage: npm run generate -- [--base-url http://localhost:3000] [--sessions 150] [--seed 42]
                           [--run-id gen-...] [--scenario simple|iteration2] [--admin-token TOKEN]
                           [--concurrency 6] [--out expected-<runId>.json]

simple      every session runs on the currently active version.
iteration2  part of the sessions start on the active version and pause mid-funnel,
            funnel-v3.json is imported and published, new sessions run on v3,
            the paused sessions resume (and must stay on their pinned version),
            then the active version is rolled back. Needs a database where v3
            has not been imported yet.

--seed fixes the behaviour model (answers, drop-offs, Back, delivery faults).
Variants are assigned by the server from random session ids, so every run
produces a different dataset; each run is checked against its own expected file.`;

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await work(queue.shift()!);
  });
  await Promise.all(workers);
}

function newSimulation(client: Client, random: Random, runId: string, index: number) {
  const utm = CAMPAIGNS[index % CAMPAIGNS.length];
  return new SessionSimulation(client, random, DEFAULT_BEHAVIOUR, utm, runId);
}

function planDelivery(events: IncomingEvent[], random: Random, sessionIds: string[]) {
  const ordered = [...events];
  let swaps = 0;
  for (let i = 0; i < ordered.length - 1; i++) {
    if (ordered[i].session_id === ordered[i + 1].session_id && random.chance(0.06)) {
      [ordered[i], ordered[i + 1]] = [ordered[i + 1], ordered[i]];
      swaps++;
      i++;
    }
  }

  const batches: IncomingEvent[][] = [];
  for (let i = 0; i < ordered.length; ) {
    const size = random.int(15, 45);
    const batch = ordered.slice(i, i + size);
    batches.push(random.chance(0.15) ? random.shuffle(batch) : batch);
    i += size;
  }

  let duplicateCopies = 0;
  for (let i = 1; i < batches.length; i++) {
    if (random.chance(0.35)) {
      const source = batches[random.int(0, i - 1)];
      batches[i].push(structuredClone(random.pick(source)));
      duplicateCopies++;
    }
  }

  const invalid = [
    { event_id: randomUUID(), session_id: sessionIds[0], name: 'step_viewed', client_timestamp: new Date().toISOString(), step_id: 'no_such_step' },
    { event_id: randomUUID(), session_id: 'missing-session', name: 'step_viewed', client_timestamp: new Date().toISOString(), step_id: 'intro' },
    { event_id: randomUUID(), session_id: sessionIds[0], name: 'session_started', client_timestamp: new Date().toISOString() },
    { event_id: randomUUID(), session_id: sessionIds[0], name: 'step_viewed' },
  ];
  batches[Math.floor(batches.length / 2)].push(...(invalid as IncomingEvent[]));
  const invalidIds = new Set<string>(invalid.map((event) => event.event_id));

  const sends: IncomingEvent[][] = [];
  let resentBatches = 0;
  batches.forEach((batch, i) => {
    sends.push(batch);
    if (i % 6 === 2) {
      sends.push(batch);
      resentBatches++;
    }
  });

  const seen = new Set<string>();
  const arrival: IncomingEvent[] = [];
  for (const batch of sends) {
    for (const event of batch) {
      if (invalidIds.has(event.event_id) || seen.has(event.event_id)) continue;
      seen.add(event.event_id);
      arrival.push(event);
    }
  }

  const invalidSends = sends.flat().filter((event) => invalidIds.has(event.event_id)).length;
  return { sends, arrival, swaps, duplicateCopies, resentBatches, invalidEvents: invalid.length, invalidSends, batches: batches.length };
}

async function runIteration2(client: Client, sims: SessionSimulation[], concurrency: number) {
  const total = sims.length;
  const firstWave = sims.slice(0, Math.ceil(total * 0.45));
  const secondWave = sims.slice(firstWave.length);
  const paused = firstWave.filter((_, i) => i % 3 === 0);

  await pool(firstWave, concurrency, async (sim) => {
    await sim.start();
    await sim.run(paused.includes(sim) ? 2 : Infinity);
  });
  const before = await client.adminOverview();
  console.log(`Wave 1 done on v${before.activeVersion}; ${paused.filter((s) => !s.finished).length} sessions paused mid-funnel.`);

  const imported = await client.importFixture('funnel-v3.json');
  await client.publish(imported.version);
  console.log(`Imported and published v${imported.version}.`);

  await pool(secondWave, concurrency, async (sim) => {
    await sim.start();
    await sim.run();
  });
  const pausedOld = paused.filter((s) => !s.finished);
  await pool(pausedOld, concurrency, async (sim) => {
    await sim.resume();
    await sim.run();
  });
  console.log(`Wave 2 done; ${pausedOld.length} paused sessions resumed on their pinned version.`);

  const after = await client.rollback();
  console.log(`Rolled back; active version is v${after.activeVersion}.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const baseUrl = args['base-url'] ?? 'http://localhost:3000';
  const total = Number(args.sessions ?? 150);
  const seed = Number(args.seed ?? 42);
  const scenario = args.scenario ?? 'simple';
  const runId = args['run-id'] ?? `gen-${seed}-${Date.now().toString(36)}`;
  const concurrency = Number(args.concurrency ?? 6);
  const out = args.out ?? `expected-${runId}.json`;
  if (!Number.isInteger(total) || total < 1) throw new Error('--sessions must be a positive integer');

  const client = createClient(baseUrl, args['admin-token'] ?? process.env.ADMIN_TOKEN);
  const random = createRandom(seed);
  const sims = Array.from({ length: total }, (_, i) => newSimulation(client, random, runId, i));

  if (scenario !== 'simple' && scenario !== 'iteration2') throw new Error(`Unknown scenario "${scenario}".`);
  if (scenario === 'iteration2') {
    const overview = await client.adminOverview();
    if (overview.versions.some((v) => v.version === 3)) {
      throw new Error('Version 3 is already imported on this server, so the iteration2 scenario cannot run. Use --scenario simple.');
    }
  }

  console.log(`Run ${runId}: ${total} sessions against ${baseUrl} (scenario ${scenario})`);

  let failure: unknown = null;
  try {
    if (scenario === 'iteration2') await runIteration2(client, sims, concurrency);
    else await pool(sims, concurrency, async (sim) => {
      await sim.start();
      await sim.run();
    });
  } catch (error) {
    failure = error;
    console.error('Simulation stopped early; delivering the events of the sessions that did start.');
  }

  const started = sims.filter((s) => s.truth);
  if (started.length === 0) throw failure ?? new Error('No session was started.');
  const events = started.flatMap((s) => s.events);
  const plan = planDelivery(events, random, started.map((s) => s.sessionId));
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;
  for (const batch of plan.sends) {
    const res = await client.sendEvents(batch);
    accepted += res.accepted;
    duplicates += res.duplicates;
    rejected += res.rejected;
  }
  console.log(
    `Events: ${events.length} generated, ${plan.sends.length} requests (${plan.resentBatches} re-sent batches, ` +
      `${plan.duplicateCopies} duplicate copies, ${plan.swaps} swapped pairs, ${plan.invalidEvents} invalid).`,
  );
  console.log(`Server: ${accepted} accepted, ${duplicates} duplicates, ${rejected} rejected.`);

  const expected: Expected = buildExpected(
    runId,
    started.map((s) => s.truth),
    plan.arrival,
    {
      eventsGenerated: events.length,
      batches: plan.batches,
      resentBatches: plan.resentBatches,
      duplicateCopies: plan.duplicateCopies,
      invalidEvents: plan.invalidEvents,
    },
  );
  writeFileSync(out, JSON.stringify(expected, null, 2));

  const problems: string[] = [];
  if (accepted !== events.length) problems.push(`accepted ${accepted} ≠ generated ${events.length}`);
  if (rejected !== plan.invalidSends) problems.push(`rejected ${rejected} ≠ invalid sent ${plan.invalidSends}`);
  const expectedDuplicates = plan.sends.flat().length - plan.invalidSends - events.length;
  if (duplicates !== expectedDuplicates) problems.push(`duplicates ${duplicates} ≠ expected ${expectedDuplicates}`);
  console.log(`Expected aggregates written to ${out}.`);
  console.log(`Check them: npm run verify -- --base-url ${baseUrl} --expected ${out}`);
  if (problems.length) {
    console.error(`Delivery mismatch: ${problems.join('; ')}`);
    process.exitCode = 1;
  }
  if (failure) throw failure;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
