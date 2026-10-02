import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceNameFromRemote } from '../src/send/send-model.js';
import { startServer, type StartedServer } from '../src/index.js';
import { Repo, completeRepo } from './model-check-repo.js';

/** The send command's script, run the way a person runs it. */
const SEND_SCRIPT = fileURLToPath(new URL('../scripts/send-model.ts', import.meta.url));

/** After every commit the fixtures make (test/model-check-repo.ts), so a test never depends on the clock. */
const NOW = Date.UTC(2026, 8, 30);

/** The committer time every fixture commit carries, read off the fixture's own fixed date. */
const COMMITTED_AT = new Date(1756728000 * 1000).toISOString();

/**
 * Runs the send script from a shell, waiting for it asynchronously: the
 * server under the test lives in this process' event loop, and a
 * synchronous wait would block that loop with the child's request never
 * answered. The environment is inherited on purpose, as the model
 * check's runScript says: the script's git calls only read committed
 * objects, and a sealed whitelist would strip the loader variables the
 * native model-store module needs.
 */
async function runSend(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, SEND_SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { status: status ?? -1, stdout, stderr };
}

/**
 * The send command's source name (the server capability's send
 * requirement, docs/changes/server-views/capabilities/server.md): the
 * name is the `origin` remote as host and path without a scheme,
 * credentials or a trailing `.git`, so it is stable across clones and
 * machines and no credential can reach the output, the logs or the
 * request.
 */
describe('the source name of a remote', () => {
  test('the host and path survive; scheme, credentials, port and a trailing .git do not', () => {
    const remotes: [string, string][] = [
      ['git@github.com:shady2k/nocx.git', 'github.com/shady2k/nocx'],
      ['https://user:token@github.com/shady2k/nocx.git', 'github.com/shady2k/nocx'],
      ['https://github.com/shady2k/nocx', 'github.com/shady2k/nocx'],
      ['ssh://git@github.com/shady2k/nocx.git', 'github.com/shady2k/nocx'],
      ['git://github.com/shady2k/nocx.git', 'github.com/shady2k/nocx'],
      ['ssh://git@github.com:2222/shady2k/nocx.git', 'github.com/shady2k/nocx'],
      ['http://token@10.0.0.1:7990/scm/proj/repo.git', '10.0.0.1/scm/proj/repo'],
      ['git@github.com:shady2k/nocx', 'github.com/shady2k/nocx'],
      ['https://github.com/acme/shop.git?access_token=secret#x', 'github.com/acme/shop'],
      ['https://github.com/acme/shop?ref=main#readme', 'github.com/acme/shop'],
      ['https://user:token@github.com/shady2k/nocx.git?private=token', 'github.com/shady2k/nocx'],
      ['github.com:shady2k/nocx', 'github.com/shady2k/nocx'],
      ['xy:repo', 'xy/repo'],
      ['https://github.com/shady2k/nocx//', 'github.com/shady2k/nocx'],
    ];
    for (const [remote, name] of remotes) {
      expect(sourceNameFromRemote(remote)).toBe(name);
    }
  });

  test('a remote with no host and path to name a repository by names nothing', () => {
    for (const remote of ['/srv/git/nocx.git', 'file:///srv/git/nocx.git', 'C:\\dev\\nocx', 'https://github.com/', 'git@github.com:', 'https://github.com', 'https:///x', '1https://github.com/shady2k/nocx']) {
      expect(sourceNameFromRemote(remote)).toBeUndefined();
    }
  });
});

/**
 * The send command run as a person runs it: a real server on a free
 * port over a temporary data folder, and the model check's own git
 * repository fixtures. The subprocess is the surface under test — the
 * exit codes, what is printed and what the server then holds.
 */
describe('the send command', () => {
  let folder: string | undefined;
  let server: StartedServer | undefined;
  let lines: string[];

  afterEach(() => {
    server?.stop();
    server = undefined;
    if (folder !== undefined) {
      rmSync(folder, { recursive: true, force: true });
      folder = undefined;
    }
  });

  /** A real server on a free port over a scratch data folder, removed when the test ends; returns its URL. */
  function start(): string {
    folder = mkdtempSync(join(tmpdir(), 'madarch-send-model-'));
    lines = [];
    server = startServer({
      dataFolder: folder,
      port: 0,
      clock: { now: () => NOW },
      log: (line) => lines.push(line),
      errorLog: () => {},
    });
    return server.url;
  }

  async function sources(): Promise<{ source: string; commit: string; committedAt: string; storedAt: string }[]> {
    const response = await fetch(`${server!.url}/sources`);
    expect(response.status).toBe(200);
    const list: unknown = await response.json();
    expect(Array.isArray(list)).toBe(true);
    return list as { source: string; commit: string; committedAt: string; storedAt: string }[];
  }

  test('sent-after-check: the origin git@github.com:shady2k/nocx.git is stored as github.com/shady2k/nocx at HEAD\'s commit and committer time, twice is already stored', async () => {
    const url = start();
    const repo = completeRepo();
    try {
      expect(repo.run(['remote', 'add', 'origin', 'git@github.com:shady2k/nocx.git']).ok).toBe(true);
      const commit = repo.run(['rev-parse', 'HEAD']).stdout.trim();

      const first = await runSend(repo.path, '--server', url);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('stored');
      expect(first.stdout).toContain('github.com/shady2k/nocx');
      expect(first.stdout).toContain(commit);
      expect(first.stdout).not.toContain('git@github.com');

      const list = await sources();
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({ id: expect.any(String), source: 'github.com/shady2k/nocx', commit, committedAt: COMMITTED_AT, storedAt: new Date(NOW).toISOString() });

      const second = await runSend(repo.path, '--server', url);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('already stored');
      expect(await sources()).toEqual(list);
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('an https origin with credentials stores the same name, and no credential reaches the output, the request or the server log', async () => {
    const url = start();
    const repo = completeRepo();
    try {
      expect(repo.run(['remote', 'add', 'origin', 'https://user:token@github.com/shady2k/nocx.git']).ok).toBe(true);
      const commit = repo.run(['rev-parse', 'HEAD']).stdout.trim();

      const run = await runSend(repo.path, '--server', url);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('github.com/shady2k/nocx');
      expect(run.stdout).not.toContain('token');
      expect(run.stdout).not.toContain('user:');

      const list = await sources();
      expect(list.map((head) => [head.source, head.commit])).toEqual([['github.com/shady2k/nocx', commit]]);
      for (const line of lines) expect(line).not.toContain('token');
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('an https origin carrying a query and fragment stores the bare host and path, and none of it reaches the output, the request or the server log', async () => {
    const url = start();
    const repo = completeRepo();
    try {
      expect(repo.run(['remote', 'add', 'origin', 'https://github.com/acme/shop.git?access_token=secret#x']).ok).toBe(true);
      const commit = repo.run(['rev-parse', 'HEAD']).stdout.trim();

      const run = await runSend(repo.path, '--server', url);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('github.com/acme/shop');

      const list = await sources();
      expect(list.map((head) => [head.source, head.commit])).toEqual([['github.com/acme/shop', commit]]);
      expect(lines.join('\n')).not.toContain('secret');
      expect(run.stdout).not.toContain('secret');
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('check-fails: a model naming evidence past the end of its file sends nothing and exits 1 with the finding\'s file and line', async () => {
    const url = start();
    const repo = completeRepo();
    try {
      const yaml = readFileSync(join(repo.path, 'madarch/model.yaml'), 'utf8');
      // The check names the evidence item at its own first line in the model file.
      repo.writeModel('model.yaml', yaml.replace('        line: 2\n        endLine: 4\n', '        line: 40\n        endLine: 45\n'));
      const itemLine = repo.lineOf('model.yaml', '- file: src/core.ts');

      const run = await runSend(repo.path, '--server', url);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('error:');
      expect(run.stdout).toContain('madarch/model.yaml');
      expect(run.stdout).toContain(String(itemLine));
      expect(run.stdout).toContain('has 30 lines');
      expect(await sources()).toEqual([]);
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('missing names, flags and repositories exit 2 naming what is missing', async () => {
    const url = start();
    // The subprocess is awaited before its repository is removed, and the
    // check must get past "unreadable" for the missing-name and bad-revision
    // cases to be reached, so each case builds a complete repository.
    const named = completeRepo();
    try {
      const noName = await runSend(named.path, '--server', url);
      expect(noName.status).toBe(2);
      expect(noName.stderr).toContain('has no "origin" remote');
      expect(noName.stderr).toContain('--source');
    } finally {
      rmSync(named.path, { recursive: true, force: true });
    }
    const flagged = completeRepo();
    try {
      const noServer = await runSend(flagged.path);
      expect(noServer.status).toBe(2);
      expect(noServer.stderr).toContain('--server');
      const badOption = await runSend(flagged.path, '--server', url, '--bogus');
      expect(badOption.status).toBe(2);
      expect(badOption.stderr).toContain('unknown option');
      const badRev = await runSend(flagged.path, '--server', url, '--rev', 'no-such-rev');
      expect(badRev.status).toBe(2);
      expect(badRev.stdout + badRev.stderr).toContain('unknown revision');
    } finally {
      rmSync(flagged.path, { recursive: true, force: true });
    }
    const notARepo = mkdtempSync(join(tmpdir(), 'madarch-send-notrepo-'));
    try {
      const run = await runSend(notARepo, '--server', url);
      expect(run.status).toBe(2);
      expect(run.stdout + run.stderr).toContain('not a git repository');
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  test('a server that cannot be reached exits 2 naming the server', async () => {
    const repo = completeRepo();
    try {
      expect(repo.run(['remote', 'add', 'origin', 'git@github.com:shady2k/nocx.git']).ok).toBe(true);
      const run = await runSend(repo.path, '--server', 'http://127.0.0.1:9');
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('127.0.0.1:9');
      expect(run.stderr).toContain('could not be reached');
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('--source names the source over the origin, and --rev sends that revision\'s commit and committer time', async () => {
    const url = start();
    const repo = completeRepo();
    try {
      expect(repo.run(['remote', 'add', 'origin', 'git@github.com:shady2k/nocx.git']).ok).toBe(true);
      const older = repo.run(['rev-parse', 'HEAD~1']).stdout.trim();

      const run = await runSend(repo.path, '--server', url, '--source', 'acme/shop', '--rev', older);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('acme/shop');
      expect(run.stdout).toContain(older);
      expect(run.stdout).not.toContain('github.com/shady2k/nocx');

      const list = await sources();
      expect(list).toHaveLength(1);
      expect(list[0]!.source).toBe('acme/shop');
      expect(list[0]!.commit).toBe(older);
      expect(list[0]!.committedAt).toBe(COMMITTED_AT);
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('a refusal from the server exits 2 printing its message', async () => {
    const url = start();
    const repo = completeRepo();
    try {
      expect(repo.run(['remote', 'add', 'origin', 'git@github.com:shady2k/nocx.git']).ok).toBe(true);
      expect((await runSend(repo.path, '--server', url)).status).toBe(0);

      // The same commit sent with a different model is refused, naming the commit.
      const yaml = readFileSync(join(repo.path, 'madarch/model.yaml'), 'utf8');
      repo.writeModel('model.yaml', yaml.replace('name: Places orders on the core', 'name: Places orders on the core again'));
      const commit = repo.run(['rev-parse', 'HEAD']).stdout.trim();

      const run = await runSend(repo.path, '--server', url);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('error:');
      expect(run.stderr).toContain(commit);
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('a server answer that is not a send answer exits 2 naming the problem', async () => {
    start();
    const repo = completeRepo();
    const fake = Bun.serve({
      port: 0,
      fetch: () => Response.json({ stored: 'yes' }),
    });
    try {
      expect(repo.run(['remote', 'add', 'origin', 'git@github.com:shady2k/nocx.git']).ok).toBe(true);
      const run = await runSend(repo.path, '--server', `http://127.0.0.1:${fake.port}`);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('no boolean "stored"');
    } finally {
      fake.stop(true);
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('a server answer that is no object at all exits 2 naming the problem', async () => {
    start();
    const repo = completeRepo();
    const fake = Bun.serve({
      port: 0,
      fetch: () => Response.json(42),
    });
    try {
      expect(repo.run(['remote', 'add', 'origin', 'git@github.com:shady2k/nocx.git']).ok).toBe(true);
      const run = await runSend(repo.path, '--server', `http://127.0.0.1:${fake.port}`);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('no boolean "stored"');
    } finally {
      fake.stop(true);
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('a refusal carries its field into the printed error', async () => {
    start();
    const repo = completeRepo();
    const fake = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: 'the model is not wanted', field: 'source' } }, { status: 400 }),
    });
    try {
      expect(repo.run(['remote', 'add', 'origin', 'git@github.com:shady2k/nocx.git']).ok).toBe(true);
      const run = await runSend(repo.path, '--server', `http://127.0.0.1:${fake.port}`);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('the model is not wanted');
      expect(run.stderr).toContain('(field: source)');
    } finally {
      fake.stop(true);
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test('a server address with trailing slashes is trimmed onto /models', async () => {
    const url = start();
    const repo = completeRepo();
    try {
      expect(repo.run(['remote', 'add', 'origin', 'git@github.com:shady2k/nocx.git']).ok).toBe(true);
      const run = await runSend(repo.path, '--server', `${url}//`);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('stored');
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });
});
