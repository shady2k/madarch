/**
 * Installing the pinned server (madarch-8bdc.2.5, item 1): an archive served by
 * a local server stands in for the release, so the installer's own work — the
 * sha256 verified before anything is unpacked, a download that resumes where a
 * killed one stopped, progress a reader sees move, a folder that never looks
 * installed until it is — runs without the 38 MB download every case.
 *
 * The pinned archive itself is not fetched here; `test/embedded-postgres.test.ts`
 * holds the pinned builds' data, and the run's preload installs the real one
 * once per machine.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePostgresInstalled } from '../src/adapters/postgres-install.js';
import type { PostgresBuild } from '../src/adapters/postgres-builds.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** One scratch home and one archive the test made, removed when the case ends. */
let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-install-'));
  roots.push(root);
  return root;
}

/** A tar.gz holding `bin/` with the programs an install must find, as the release's own archive does. */
function archiveOf(root: string): Buffer {
  const source = join(root, 'payload');
  mkdirSync(join(source, 'bin'), { recursive: true });
  for (const program of ['initdb', 'pg_ctl', 'psql', 'pg_dump']) writeFileSync(join(source, 'bin', program), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(source, 'PG_VERSION'), '18\n');
  const archive = join(root, 'payload.tar.gz');
  const packed = Bun.spawnSync(['tar', '-czf', archive, '-C', source, '.']);
  if (packed.exitCode !== 0) throw new Error(`test/postgres-install.test.ts: tar exited ${String(packed.exitCode)}: ${packed.stderr.toString()}`);
  const bytes = readFileSync(archive);
  rmSync(source, { recursive: true, force: true });
  rmSync(archive, { force: true });
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A server that answers the archive, with the range a resumed download asks for, and keeps what it was asked.
 * `failFirst` answers that many requests with `status` before the archive is served: the release host answering 502/504
 * at times is what CI run 42467156631 hit.
 */
function serveArchive(bytes: Buffer, options: { readonly failFirst?: number; readonly status?: number } = {}): { url: string; ranges: string[]; requests: number; stop(): void } {
  const ranges: string[] = [];
  let requests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests += 1;
      if (requests <= (options.failFirst ?? 0)) return new Response('the gateway timed out', { status: options.status ?? 504 });
      const range = request.headers.get('range');
      ranges.push(range ?? '');
      if (range !== null) {
        const start = Number(/^bytes=(\d+)-$/u.exec(range)?.[1] ?? '0');
        const rest = bytes.subarray(start);
        return new Response(new Uint8Array(rest), { status: 206, headers: { 'content-length': String(rest.length) } });
      }
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-length': String(bytes.length) } });
    },
  });
  return { url: `http://127.0.0.1:${String(server.port)}/archive.tar.gz`, ranges, get requests() { return requests; }, stop: () => { void server.stop(true); } };
}

function fixtureBuild(bytes: Buffer): PostgresBuild {
  return { platform: 'linux-arm64', target: 'fixture-target', sha256: sha256(bytes), bytes: bytes.length };
}

describe('installing the pinned server', () => {
  test.skipIf(isRoot)('verifies the archive, unpacks it whole, says the marker and reports its progress', async () => {
    const root = scratch();
    const bytes = archiveOf(root);
    const build = fixtureBuild(bytes);
    const served = serveArchive(bytes);
    const lines: string[] = [];
    try {
      const installed = await ensurePostgresInstalled({ build, archiveUrl: () => served.url, env: { HOME: join(root, 'home') }, progress: (line) => lines.push(line) });
      expect(installed.bin).toBe(join(root, 'home', 'madarch', 'tools', 'postgresql', '18.6.1', 'bin'));
      expect(existsSync(join(installed.bin, 'initdb'))).toBe(true);
      expect(existsSync(join(installed.bin, 'pg_ctl'))).toBe(true);
      const marker = JSON.parse(readFileSync(join(root, 'home', 'madarch', 'tools', 'postgresql', '18.6.1', 'install.json'), 'utf8')) as { sha256: string; platform: string; version: string };
      expect(marker).toMatchObject({ sha256: build.sha256, platform: build.platform, version: '18.6.1' });
      // The progress a reader sees move: the size, and the end of the download.
      expect(lines.join('\n')).toContain('MB of');
      expect(lines.join('\n')).toContain('(100%)');
      // The archive has done its work and no scratch folder is left beside the install.
      expect(existsSync(join(root, 'home', 'madarch', 'tools', 'postgresql', 'downloads', 'postgresql-18.6.1-fixture-target.tar.gz'))).toBe(false);
      // A second install reads the marker and downloads nothing.
      const again = await ensurePostgresInstalled({ build, archiveUrl: () => served.url, env: { HOME: join(root, 'home') }, progress: () => undefined });
      expect(again.bin).toBe(installed.bin);
      expect(served.ranges).toHaveLength(1);
    } finally {
      served.stop();
    }
  }, 60_000);

  test.skipIf(isRoot)('resumes a download a killed process left: the range asked for is what the file already holds', async () => {
    const root = scratch();
    const bytes = archiveOf(root);
    const build = fixtureBuild(bytes);
    const served = serveArchive(bytes);
    const home = join(root, 'home');
    // The part file a download writes is the process's own, so two installs at once never write one file.
    const partial = join(home, 'madarch', 'tools', 'postgresql', 'downloads', `postgresql-18.6.1-fixture-target.tar.gz.${String(process.pid)}.part`);
    try {
      mkdirSync(join(partial, '..'), { recursive: true });
      writeFileSync(partial, bytes.subarray(0, 100));
      const installed = await ensurePostgresInstalled({ build, archiveUrl: () => served.url, env: { HOME: home }, progress: () => undefined });
      expect(served.ranges).toEqual(['bytes=100-']);
      expect(existsSync(join(installed.bin, 'initdb'))).toBe(true);
    } finally {
      served.stop();
    }
  }, 60_000);

  test.skipIf(isRoot)('retries a gateway failure and installs once the release answers', async () => {
    const root = scratch();
    const bytes = archiveOf(root);
    const build = fixtureBuild(bytes);
    // Two 504s, then the archive: the release host does answer that way, and a first CI run has an empty cache.
    const served = serveArchive(bytes, { failFirst: 2, status: 504 });
    const lines: string[] = [];
    try {
      const installed = await ensurePostgresInstalled({ build, archiveUrl: () => served.url, env: { HOME: join(root, 'home') }, progress: (line) => lines.push(line) });
      expect(existsSync(join(installed.bin, 'initdb'))).toBe(true);
      // Three requests were made, and each failure said which attempt it was and what the server answered.
      expect(served.requests).toBe(3);
      const attempts = lines.filter((line) => line.includes('download failed'));
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toContain('attempt 1 of 5');
      expect(attempts[0]).toContain('the server answered 504');
      expect(attempts[1]).toContain('attempt 2 of 5');
    } finally {
      served.stop();
    }
  }, 90_000);

  test.skipIf(isRoot)('refuses a 404 at once, naming the URL and the status, and installs nothing', async () => {
    const root = scratch();
    const bytes = archiveOf(root);
    const build = fixtureBuild(bytes);
    const served = serveArchive(bytes, { failFirst: 1, status: 404 });
    try {
      const started = Date.now();
      await expect(ensurePostgresInstalled({ build, archiveUrl: () => served.url, env: { HOME: join(root, 'home') }, progress: () => undefined }))
        .rejects.toThrow(new RegExp(`could not be downloaded from ${served.url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}: the server answered 404`));
      // A refusal is not tried again, and nothing was installed.
      expect(served.requests).toBe(1);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(existsSync(join(root, 'home', 'madarch', 'tools', 'postgresql', '18.6.1'))).toBe(false);
    } finally {
      served.stop();
    }
  }, 60_000);

  test.skipIf(isRoot)('three installers at once end with one installed server and nothing left over', async () => {
    // The wiki's own server, its fill worker and its read worker all start from a cold tools folder (CI run 42479678749:
    // the second and third installers swept the first's unpack folder while tar was writing it). One holds the lock and
    // installs; the others wait for its marker and read what it installed.
    const root = scratch();
    const bytes = archiveOf(root);
    const build = fixtureBuild(bytes);
    const served = serveArchive(bytes);
    try {
      const env = { HOME: join(root, 'home') };
      const installed = await Promise.all([1, 2, 3].map(async () => await ensurePostgresInstalled({ build, archiveUrl: () => served.url, env, progress: () => undefined })));
      const wanted = join(root, 'home', 'madarch', 'tools', 'postgresql', '18.6.1', 'bin');
      for (const one of installed) {
        expect(one.bin).toBe(wanted);
        expect(existsSync(join(one.bin, 'initdb'))).toBe(true);
      }
      // One download served all three, and nothing stands beside the install: no unpack folder of a live or dead
      // installer, no part file, no lock.
      expect(served.requests).toBe(1);
      const tools = join(root, 'home', 'madarch', 'tools', 'postgresql');
      expect(readdirSync(tools).filter((name) => /\.unpack-|\.part$|\.lock$/u.test(name))).toEqual([]);
      expect(readdirSync(join(tools, 'downloads'))).toEqual([]);
    } finally {
      served.stop();
    }
  }, 120_000);

  test.skipIf(isRoot)('refuses an archive whose sha256 is not the pinned one, and installs nothing', async () => {
    const root = scratch();
    const bytes = archiveOf(root);
    const build = { ...fixtureBuild(bytes), sha256: '0'.repeat(64) };
    const served = serveArchive(bytes);
    try {
      await expect(ensurePostgresInstalled({ build, archiveUrl: () => served.url, env: { HOME: join(root, 'home') }, progress: () => undefined }))
        .rejects.toThrow(/has sha256 [0-9a-f]{64}, and .* pins 0000.*nothing was installed and the archive was removed/s);
      expect(existsSync(join(root, 'home', 'madarch', 'tools', 'postgresql', '18.6.1'))).toBe(false);
    } finally {
      served.stop();
    }
  }, 60_000);

  test.skipIf(isRoot)('refuses a platform with no pinned build by name, naming what is pinned and no fallback', async () => {
    const root = scratch();
    await expect(ensurePostgresInstalled({ platform: 'sunos-sparc', env: { HOME: join(root, 'home') }, progress: () => undefined }))
      .rejects.toThrow(/no PostgreSQL 18\.6\.1 build is pinned for sunos-sparc: this build pins darwin-arm64, darwin-x64, linux-arm64, linux-x64/);
  }, 30_000);

  test('refuses to install as root before anything is written', async () => {
    const root = scratch();
    await expect(ensurePostgresInstalled({ env: { HOME: join(root, 'home') }, uid: 0 })).rejects.toThrow(/does not install or run PostgreSQL as root/);
    expect(existsSync(join(root, 'home'))).toBe(false);
  }, 30_000);
});
