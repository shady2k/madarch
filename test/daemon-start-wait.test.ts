import { expect, test } from 'bun:test';
import { waitForDaemonStart } from '../src/product/daemon.js';

function fixture() {
  let now = 0;
  const lines: string[] = [];
  const options = {
    pid: 42, port: 4180, log: '/tmp/products/.madarch-daemon.log',
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    readChild: () => ({ reading: 'daemon' as const, args: 'daemon-serve' }),
    tokenMatches: () => true,
    answers: async () => false,
    alive: () => true,
    phase: () => ({ phase: 'databases' as const, since: 0 }),
    print: (line: string) => { lines.push(line); },
  };
  return { options, lines, now: () => now };
}

test('a live child can spend 30 seconds in databases before ready', async () => {
  const f = fixture();
  const answer = await waitForDaemonStart({ ...f.options, answers: async () => f.now() >= 30_000 });
  expect(answer.ok).toBe(true);
  expect(f.now()).toBe(30_000);
  expect(answer.why).toBe('');
  expect(f.lines).toEqual(['starting (pid 42): stopping databases left by a crash — 2 s']);
});

test('an ended child fails immediately and names the log', async () => {
  const f = fixture();
  const answer = await waitForDaemonStart({ ...f.options, readChild: () => ({ reading: 'ended', args: undefined }) });
  expect(answer.ok).toBe(false);
  expect(answer.why).toContain('had already ended');
  expect(answer.why).toContain('/tmp/products/.madarch-daemon.log');
  expect(f.now()).toBe(0);
  expect(f.lines).toEqual([]);
});

test('a live child that never answers fails exactly at 120 seconds with its last phase', async () => {
  const f = fixture();
  const answer = await waitForDaemonStart({ ...f.options, phase: () => f.now() < 10_000
    ? { phase: 'databases', since: 0 } : { phase: 'manifests', since: 10_000 } });
  expect(answer.ok).toBe(false);
  expect(f.now()).toBe(120_000);
  expect(answer.why).toContain('manifests');
  expect(answer.why).toContain('110 s');
  expect(answer.why).not.toContain('token');
  expect(answer.why).toContain('/tmp/products/.madarch-daemon.log');
  expect(f.lines).toEqual([
    'starting (pid 42): stopping databases left by a crash — 2 s',
    'starting (pid 42): checking product manifests — 0 s',
  ]);
});

test('a foreign child fails without probing and a pre-exec child keeps waiting', async () => {
  const f = fixture();
  let probes = 0;
  const foreign = await waitForDaemonStart({ ...f.options,
    readChild: () => ({ reading: 'foreign', args: 'sleep 99' }),
    answers: async () => { probes++; return true; },
  });
  expect(foreign.why).toContain('sleep 99');
  expect(f.now()).toBe(0);
  expect(probes).toBe(0);
  const ready = await waitForDaemonStart({ ...f.options,
    readChild: () => ({ reading: f.now() < 3000 ? 'starting' : 'daemon', args: '' }),
    answers: async () => { probes++; return true; },
  });
  expect(ready.ok).toBe(true);
  expect(f.now()).toBe(3000);
  expect(probes).toBe(1);
});

test('the proof and liveness still decide readiness, never the progress file', async () => {
  const f = fixture();
  let proofs = 0;
  const missingToken = await waitForDaemonStart({ ...f.options, phase: () => undefined,
    tokenMatches: () => false, answers: async () => { proofs++; return true; },
  });
  expect(missingToken.ok).toBe(false);
  expect(missingToken.why).toContain("does not show this record's token");
  expect(proofs).toBe(0);
  const ended = await waitForDaemonStart({ ...f.options, answers: async () => true, alive: () => false });
  expect(ended.ok).toBe(false);
  expect(ended.why).toContain('answered on port 4180 and then ended');
});

test('no progress is printed for a fast ready child', async () => {
  const f = fixture();
  expect((await waitForDaemonStart({ ...f.options, answers: async () => true })).ok).toBe(true);
  expect(f.lines).toEqual([]);
  expect(f.now()).toBe(0);
});

test('a vanished phase file retains the last diagnostic without deciding liveness', async () => {
  const f = fixture();
  const answer = await waitForDaemonStart({ ...f.options,
    phase: () => f.now() === 0 ? { phase: 'listener', since: 0 } : undefined,
  });
  expect(answer.ok).toBe(false);
  expect(answer.why).toContain('last start phase listener');
  expect(answer.why).toContain('120 s');
});

test('progress begins at two seconds, even if the phase file then disappears', async () => {
  let now = 50_000;
  const lines: string[] = [];
  const f = fixture();
  await waitForDaemonStart({ ...f.options, now: () => now,
    sleep: async (ms) => { now += ms; },
    phase: () => now <= 52_000 ? { phase: 'sandbox', since: 50_000 } : undefined,
    answers: async () => now >= 52_000,
    print: (line) => { lines.push(line); },
  });
  expect(lines).toEqual(['starting (pid 42): checking the plugin sandbox — 2 s']);
  const lateOrigin = await waitForDaemonStart({ ...f.options, now: () => 500_000, answers: async () => true });
  expect(lateOrigin.ok).toBe(true);
});

test('a probe that crosses the limit cannot report ready and sleep never exceeds the remainder', async () => {
  let now = 100_000;
  const f = fixture();
  const boundary = await waitForDaemonStart({ ...f.options, now: () => now,
    answers: async () => { now += 120_000; return true; },
  });
  expect(boundary.ok).toBe(false);
  let slept = 0;
  const noAnswer = await waitForDaemonStart({ ...f.options, now: () => now,
    answers: async () => { now += 7; return false; },
    sleep: async (ms) => { slept = ms; now += ms; },
  });
  expect(noAnswer.ok).toBe(false);
  expect(now).toBe(340_000);
  expect(slept).toBeLessThan(40);
});
