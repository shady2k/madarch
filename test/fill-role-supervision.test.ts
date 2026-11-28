/**
 * A server's fill role is supervised for its whole life (madarch-47vw.7): the role that ends by itself while the server
 * still serves is replaced by another with the same command, isolation and priority after 1 s, 2 s and then 5 s, a role
 * that ran 30 s returns the ladder to 1 s, a start the machine refuses is said and tried again on the same ladder, and a
 * stop cancels the replacement it waits for and ends the role it has — including an exit racing that stop.
 *
 * The ladder is checked through the narrow seam the supervision already reads its clock and its start from: the waits
 * and the children are the test's own, so every rung is asserted in milliseconds instead of waited. The production wiring
 * is then checked on a surviving host — one `startServer()` in this process, its real `--role fill` child found by the
 * process table, only that child signalled — because a signal that exits the API host cannot show a stop at all.
 *
 * A queued fill served by the replacement is covered by `test/fill-role-service.test.ts`: one real fill of a fixture
 * costs this project about 19 s on a runner (the note in `test/slow-files.json`), so it cannot share a blocking file with
 * these cases and stay inside the 30-second rule.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf } from '../src/product/store.js';
import { startServer, superviseFillRole, type FillRoleChild, type FillRoleTiming } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { retainTestStorePreparationOwner } from './prepared-server.js';

const work = mkdtempSync(join(tmpdir(), 'madarch-fill-supervision-'));
const home = join(work, 'home');
const app = join(work, 'app');
let product = '';
const servers: { stop(): Promise<void> }[] = [];
let releaseOwner: (() => Promise<void>) | undefined;

beforeAll(async () => {
  releaseOwner = await retainTestStorePreparationOwner();
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>supervision fixture</title>');
  // The smallest product a server serves: an empty draft. No case here fills it, so nothing but the role's own start is paid.
  const draft = createDraft({ home, name: 'shop', gitEnv: gitEnv({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  product = draft.folder;
});

afterAll(async () => {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  await releaseOwner?.();
  rmSync(work, { recursive: true, force: true });
});

/** Lets the promise callbacks a child's exit queues run before the case judges what the supervision did. */
async function settled(): Promise<void> {
  await Bun.sleep(0);
  await Bun.sleep(0);
}

interface StandIn extends FillRoleChild {
  /** Ends the child as a role that left by itself: exit code 0. */
  ends(): void;
  readonly killed: (NodeJS.Signals | number | undefined)[];
}

/** A role's child as the supervision reads it: a promise the case resolves, and the signals it was sent. */
function standIn(pid: number, goesWhenKilled = true): StandIn {
  let end!: () => void;
  const exited = new Promise<void>((resolve) => { end = resolve; });
  const killed: (NodeJS.Signals | number | undefined)[] = [];
  let exitCode: number | null = null;
  let signalCode: string | null = null;
  const child: StandIn = {
    pid,
    exited,
    killed,
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    kill: (signal) => {
      killed.push(signal);
      signalCode = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
      exitCode = null;
      if (goesWhenKilled && signal !== 'SIGKILL') end();
      if (signal === 'SIGKILL') end();
    },
    ends: () => { exitCode = 0; end(); },
  };
  return child;
}

/** A clock the case moves: the waits the supervision asked for, and the run that is due at each. */
function standInClock(): { timing: FillRoleTiming; advance: (ms: number) => void; waits: number[] } {
  let now = 0;
  let counter = 0;
  const waits: number[] = [];
  const timers = new Map<number, { at: number; run: () => void; cancelled: boolean }>();
  return {
    waits,
    timing: {
      now: () => now,
      schedule: (run, waitMs) => {
        const id = counter + 1;
        counter = id;
        waits.push(waitMs);
        timers.set(id, { at: now + waitMs, run, cancelled: false });
        return id;
      },
      cancel: (scheduled) => {
        const timer = timers.get(scheduled as number);
        if (timer !== undefined) timer.cancelled = true;
      },
    },
    advance: (ms) => {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => !timer.cancelled && timer.at <= until)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.run();
      }
      now = until;
    },
  };
}

test('a role that ends by itself is started again after 1 s, 2 s, 5 s and 5 s, and one that ran 30 s returns the ladder to 1 s', async () => {
  const clock = standInClock();
  const said: string[] = [];
  const started: StandIn[] = [];
  const supervision = superviseFillRole({
    log: (line) => said.push(line),
    timing: clock.timing,
    start: () => {
      const child = standIn(1000 + started.length);
      started.push(child);
      return child;
    },
  });
  expect(supervision).toBeDefined();
  expect(started.length, 'the supervision starts the first role itself').toBe(1);
  const rungs: number[] = [];
  for (const wait of [1_000, 2_000, 5_000, 5_000]) {
    started.at(-1)!.ends();
    await settled();
    rungs.push(clock.waits.at(-1)!);
    expect(said.at(-1), 'the exit is said with the role and the wait it earned').toStartWith(`the fill role (pid ${String(started.at(-1)!.pid)}) ended by itself with code 0 after`);
    expect(said.at(-1)).toContain(`another starts in ${String(wait)} ms`);
    // The replacement waits its rung: not a millisecond before it, and one millisecond is enough.
    clock.advance(wait - 1);
    expect(started.length, `a role started ${String(wait - 1)} ms into a ${String(wait)} ms wait`).toBe(rungs.length);
    clock.advance(1);
    expect(started.length, `no role started after the ${String(wait)} ms wait`).toBe(rungs.length + 1);
  }
  expect(rungs).toEqual([1_000, 2_000, 5_000, 5_000]);
  // A role that served 30 s is healthy: the exit after it waits the shortest rung again.
  clock.advance(30_000);
  started.at(-1)!.ends();
  await settled();
  expect(clock.waits.at(-1)).toBe(1_000);
  await supervision!.stop();
});

test('a start the machine refuses is said and tried again on the same ladder', async () => {
  const clock = standInClock();
  const said: string[] = [];
  const started: StandIn[] = [];
  let attempts = 0;
  const supervision = superviseFillRole({
    log: (line) => said.push(line),
    timing: clock.timing,
    start: () => {
      attempts += 1;
      // The machine refuses the two starts after the first role's exit, then takes the role.
      if (attempts === 2 || attempts === 3) throw new Error('the machine refused the spawn');
      const child = standIn(2000 + started.length);
      started.push(child);
      return child;
    },
  })!;
  started[0]!.ends();
  await settled();
  expect(clock.waits).toEqual([1_000]);
  clock.advance(1_000);
  expect(attempts).toBe(2);
  expect(said.at(-1)).toContain('the fill role could not be started: the machine refused the spawn; another try in 2000 ms');
  // The refused start advances the ladder the same way an exit does.
  expect(clock.waits).toEqual([1_000, 2_000]);
  clock.advance(2_000);
  expect(attempts).toBe(3);
  expect(clock.waits).toEqual([1_000, 2_000, 5_000]);
  clock.advance(5_000);
  expect(attempts).toBe(4);
  expect(started.length, 'the start after the refusals runs the role').toBe(2);
  await supervision.stop();
});

test('a stop cancels the replacement a pending wait would start', async () => {
  const clock = standInClock();
  const started: StandIn[] = [];
  const supervision = superviseFillRole({ log: () => undefined, timing: clock.timing, start: () => { const child = standIn(3000 + started.length); started.push(child); return child; } })!;
  started[0]!.ends();
  await settled();
  expect(clock.waits).toEqual([1_000]);
  await supervision.stop();
  clock.advance(60_000);
  expect(started.length, 'a replacement the stop cancelled started anyway').toBe(1);
});

test('an exit racing the stop starts nothing', async () => {
  const clock = standInClock();
  const started: StandIn[] = [];
  const supervision = superviseFillRole({ log: () => undefined, timing: clock.timing, start: () => { const child = standIn(4000 + started.length, false); started.push(child); return child; } })!;
  // The role does not go when it is signalled: the stop is waiting for it when its own exit lands.
  const stopping = supervision.stop();
  started[0]!.ends();
  await stopping;
  await settled();
  clock.advance(60_000);
  expect(started.length, 'the exit the stop raced earned a replacement').toBe(1);
});

test('a role that does not go within the stop deadline is killed', async () => {
  // A role the machine cannot interrupt — one inside a store's synchronous start — is killed after the deadline.
  const started: StandIn[] = [];
  const supervision = superviseFillRole({ log: () => undefined, start: () => { const child = standIn(5000 + started.length, false); started.push(child); return child; } })!;
  const startedAt = Date.now();
  await supervision.stop();
  expect(started[0]!.killed).toEqual([undefined, 'SIGKILL']);
  expect(Date.now() - startedAt, 'the stop killed before its deadline passed').toBeGreaterThanOrEqual(250);
});

test('a machine that cannot start the role at all still serves', () => {
  const supervision = superviseFillRole({ log: () => undefined, start: () => { throw new Error('no such binary'); } });
  expect(supervision).toBeUndefined();
});

interface Row {
  readonly pid: number;
  readonly stat: string;
  readonly command: string;
}

/** The process table, as `ps` prints it: this file's role is found by the home the server gives it. */
function processes(): Row[] {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,stat=,command='], { encoding: 'utf8' });
  return (listed.stdout ?? '').split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), stat: match[2]!, command: match[3]! }];
  });
}

/** The fill roles running for this file's home: a zombie is not a role that runs. */
function fillRoles(): Row[] {
  return processes().filter((row) => !row.stat.startsWith('Z') && row.command.includes('--role fill') && row.command.includes(`--home ${home}`));
}

/** Waits for the answer the case needs, saying what was missing when it never comes. */
async function waitFor<T>(what: string, within: number, found: () => T | undefined): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const answer = found();
    if (answer !== undefined) return answer;
    if (Date.now() - startedAt >= within) throw new Error(`${what} within ${String(within)} ms; the fill roles of ${home} are ${fillRoles().map((row) => String(row.pid)).join(',') || 'none'}`);
    await Bun.sleep(20);
  }
}

/** One server of this file, started on the fixture product with its real fill role child. */
async function serve(): Promise<{ stop(): Promise<void>; log: string[] }> {
  const log: string[] = [];
  const server = await startServer({
    productFolder: product,
    knowledgeRoot: knowledgeRootOf(home),
    appFolder: app,
    port: 0,
    log: (line) => log.push(line),
    errorLog: (line) => log.push(line),
  });
  servers.push(server);
  return { stop: server.stop, log };
}

test('the role of a surviving host is replaced by a distinct process when it ends by itself', async () => {
  const server = await serve();
  const first = await waitFor('a fill role of the started server', 20_000, () => fillRoles()[0]);
  expect(first.command).toContain(`--home ${home}`);
  // Only this host's own role is ended: the server keeps serving, and nothing else is signalled.
  process.kill(first.pid, 'SIGKILL');
  const killedAt = Date.now();
  const second = await waitFor(`a fill role of ${home} other than ${String(first.pid)}`, 20_000, () => fillRoles().find((row) => row.pid !== first.pid));
  const replacedAfter = Date.now() - killedAt;
  console.log(`fill role ${String(first.pid)} ended; ${String(second.pid)} stood in its place after ${String(replacedAfter)} ms without the server restarting`);
  expect(second.pid).not.toBe(first.pid);
  // The production supervision says the exit it saw, with the role and the wait before the replacement.
  await waitFor('the exit line of the ended role', 5_000, () => server.log.find((line) => line.includes(`the fill role (pid ${String(first.pid)}) ended by itself`)));
  // A stop ends the role it has and leaves no replacement behind it.
  await server.stop();
  await Bun.sleep(1_500);
  expect(fillRoles().map((row) => row.pid), `a fill role of ${home} still ran after the server stopped`).toEqual([]);
});

test('a stop while the longest wait is pending starts no replacement across it', async () => {
  const server = await serve();
  // The ladder is walked in the host itself (1 s and 2 s), so the wait pending at the stop is the 5 s rung: a window
  // wide enough that the stop is certainly inside it, whatever the machine is doing.
  const first = await waitFor('a fill role of the started server', 20_000, () => fillRoles()[0]);
  process.kill(first.pid, 'SIGKILL');
  const second = await waitFor('the role after the 1 s rung', 20_000, () => fillRoles().find((row) => row.pid !== first.pid));
  process.kill(second.pid, 'SIGKILL');
  const third = await waitFor('the role after the 2 s rung', 20_000, () => fillRoles().find((row) => row.pid !== first.pid && row.pid !== second.pid));
  process.kill(third.pid, 'SIGKILL');
  // The role is gone and its replacement waits the 5 s rung: the stop is called inside that wait.
  await waitFor('the ended role to leave the process table', 5_000, () => (fillRoles().some((row) => row.pid === third.pid) ? undefined : true));
  const pendingAt = Date.now();
  await server.stop();
  expect(Date.now() - pendingAt, 'the stop came after the pending wait it had to cancel').toBeLessThan(5_000);
  // The wait it cancelled would have started a role by now: the stop left none behind.
  await Bun.sleep(5_500);
  expect(fillRoles().map((row) => row.pid), `a replacement of ${home} started across the wait the stop cancelled`).toEqual([]);
});

test('a stop racing the role\'s own exit leaves no role and no replacement', async () => {
  const server = await serve();
  const role = await waitFor('a fill role of the started server', 20_000, () => fillRoles()[0]);
  // The exit and the stop land together: whichever the server sees first, nothing may be left running.
  process.kill(role.pid, 'SIGKILL');
  await server.stop();
  await Bun.sleep(1_500);
  expect(fillRoles().map((row) => row.pid), `a fill role of ${home} still ran after a stop racing its exit`).toEqual([]);
});
