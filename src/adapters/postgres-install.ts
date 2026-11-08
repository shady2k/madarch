/**
 * Installing the PostgreSQL server madarch runs on (madarch-8bdc.2.5, item 1):
 * one archive, pinned by version and sha256 in `postgres-builds.ts`, downloaded
 * once into `<madarch home>/tools/postgresql/<version>/` and unpacked there.
 * The owner's decision: "The delivery need not carry it, it can be downloaded
 * at install." and "Pin the version and the hash, always."
 *
 * The shape is `src/fill/acp-install.ts`'s: a data file holds what is installed,
 * the installer fetches it into a folder of madarch's own, and every failure
 * names the folder, the version and what the person can do. What it adds is a
 * download that shows its progress and resumes: the archive is 38-92 MB
 * (measured here: 273 s for 39.9 MB, so a reader must see it move), it is
 * fetched in ranges into a `.part` file, and a `.part` a killed process left is
 * continued rather than trusted.
 *
 * Nothing half-installed is ever used. The archive's sha256 is read before it
 * is unpacked, the unpack lands in a scratch folder beside the install and is
 * renamed whole, and `install.json` — the marker the next run reads to tell an
 * install from a folder that happens to hold files — is written last.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  POSTGRES_VERSION,
  platformKey,
  pinnedPlatforms,
  postgresArchiveName,
  postgresArchiveUrl,
  postgresBuildFor,
  postgresDownloadFolder,
  postgresInstallFolder,
  type PostgresBuild,
} from './postgres-builds.js';

/** Where one installed server's programs are, and which build they are. */
export interface InstalledPostgres {
  /** The `bin` folder: `initdb`, `pg_ctl`, `psql` and the rest. */
  readonly bin: string;
  /** The folder the build was unpacked into: `<madarch home>/tools/postgresql/<version>`. */
  readonly folder: string;
  readonly build: PostgresBuild;
}

export interface PostgresInstallOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** What the download reports as it moves: a line, without its newline. */
  readonly progress?: (line: string) => void;
  /** The user this process runs as; `process.getuid()` unless a test names one. */
  readonly uid?: number;
  /** The build to install; the platform's pinned one unless a test names its own. */
  readonly build?: PostgresBuild;
  /** The platform key to install for; this machine's unless a test names one, so a refusal for a platform the file pins nothing for can be held. */
  readonly platform?: string;
  /** Where the archive comes from; the release URL of `build` unless a test names its own. */
  readonly archiveUrl?: (build: PostgresBuild) => string;
}

/** The marker an installed folder carries: the build it holds, as this file pinned it. */
interface InstallMarker {
  readonly version: string;
  readonly platform: string;
  readonly target: string;
  readonly sha256: string;
}

/** The `bin` folder's two programs an install cannot be used without. */
const REQUIRED_PROGRAMS = ['initdb', 'pg_ctl'] as const;

/** How often a download reports where it stands: once a second, and once every 4 MB, whichever comes first. */
const PROGRESS_MS = 1_000;
const PROGRESS_BYTES = 4 * 1024 * 1024;

/** The where of every refusal, as the codebase names it. */
const WHERE = 'src/adapters/postgres-install.ts';

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}

/**
 * PostgreSQL refuses to run as root — initdb and the server both do — so the
 * install refuses first, before anything is written: a server installed by root
 * is a folder the person who runs madarch may not write.
 */
export function refuseRoot(uid: number | undefined = typeof process.getuid === 'function' ? process.getuid() : undefined): void {
  if (uid === 0) {
    throw new Error(`${WHERE}:1: madarch does not install or run PostgreSQL as root: initdb and postgres both refuse it, and a server root installed is one the person who runs madarch cannot use. Run madarch as an ordinary user, for example: sudo -u <user> bun scripts/fill-step1.ts ...`);
  }
}

/** The marker's content for a build. */
function markerFor(build: PostgresBuild): InstallMarker {
  return { version: POSTGRES_VERSION, platform: build.platform, target: build.target, sha256: build.sha256 };
}

/** Whether the folder holds exactly the build the marker names: every program a server needs, and the same archive hash. */
function installedBuild(folder: string, build: PostgresBuild): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(folder, 'install.json'), 'utf8')) as Partial<InstallMarker>;
    const expected = markerFor(build);
    if (marker.version !== expected.version || marker.platform !== expected.platform || marker.target !== expected.target || marker.sha256 !== expected.sha256) return false;
  } catch {
    return false;
  }
  return REQUIRED_PROGRAMS.every((program) => existsSync(join(folder, 'bin', program)));
}

/** The sha256 of a file as the file states it, or null when it is not there. */
async function digestOf(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  const hasher = createHash('sha256');
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk as Uint8Array);
  return hasher.digest('hex');
}

/** Runs one of the system's own programs, refusing by name with what it said. */
function runProgram(program: string, args: readonly string[]): void {
  const answer = spawnSync(program, [...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const said = (answer.stderr ?? '').trim().slice(0, 2_000);
  if (answer.error !== undefined || answer.status !== 0) {
    throw new Error(`${WHERE}:1: ${program} ${args.join(' ')} failed: ${answer.error?.message ?? `exited ${String(answer.status)}`}${said === '' ? '' : `: ${said}`}`);
  }
}

/**
 * The waits between a download's attempts, in milliseconds: five attempts over about a minute. GitHub's release
 * download answers 502/504 at times (CI run 42467156631: shards 3 and 4 could not install the server at all), and a
 * connection dropped mid-archive is as transient. A 4xx, a 416 and a sha256 mismatch are not: the answer says what is
 * wrong, and waiting changes nothing.
 */
const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000];

/** A download failure another attempt may answer differently. */
class TransientDownload extends Error {}

/** Whether a status is one to try again: the server's own trouble, or a rate limit, never a refusal of the request. */
function transientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Downloads the archive, continuing a `.part` a killed process left: the range
 * asked for is what the file already holds. A server that answers the whole
 * archive instead of the range (200, not 206) is written from the start, so a
 * resumed download restarts cleanly where continuing is not offered.
 */
async function downloadArchive(options: {
  readonly build: PostgresBuild;
  readonly url: string;
  readonly archive: string;
  readonly folder: string;
  readonly progress: (line: string) => void;
}): Promise<void> {
  const { build, url, archive, folder } = options;
  const attempts = RETRY_DELAYS_MS.length + 1;
  let last: TransientDownload | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadAttempt(options);
      return;
    } catch (error) {
      if (!(error instanceof TransientDownload)) throw error;
      last = error;
      if (attempt === attempts) break;
      const wait = RETRY_DELAYS_MS[attempt - 1]!;
      options.progress(`madarch: the PostgreSQL ${POSTGRES_VERSION} download failed (attempt ${String(attempt)} of ${String(attempts)}): ${error.message}; trying again in ${String(Math.round(wait / 1_000))} s`);
      await Bun.sleep(wait);
    }
  }
  throw new Error(`${WHERE}:1: the PostgreSQL ${POSTGRES_VERSION} archive could not be downloaded from ${url} after ${String(attempts)} attempts: ${last?.message ?? 'the download failed'}. madarch installs its server once, into ${folder}; run the command again when the release is reachable — a download that was cut short continues where it stopped`);
}

/** One attempt at the download: the network's, this file's, and the archive's own answer. */
async function downloadAttempt(options: {
  readonly build: PostgresBuild;
  readonly url: string;
  readonly archive: string;
  readonly folder: string;
  readonly progress: (line: string) => void;
}): Promise<void> {
  const { build, url, archive, folder } = options;
  // One writer per download: two processes installing at once write their own part files, and the archive is only made
  // whole by a rename, so a file the other process is still writing is never read.
  const partial = `${archive}.${String(process.pid)}.part`;
  mkdirSync(dirname(archive), { recursive: true });
  let held = existsSync(partial) ? statSync(partial).size : 0;
  if (held > 0) options.progress(`madarch: continuing the PostgreSQL ${POSTGRES_VERSION} download at ${megabytes(held)} MB of ${megabytes(build.bytes)} MB (${folder})`);
  else options.progress(`madarch: downloading PostgreSQL ${POSTGRES_VERSION} for ${build.target}: ${megabytes(build.bytes)} MB into ${folder}`);
  let response: Response;
  try {
    response = await fetch(url, held > 0 ? { headers: { Range: `bytes=${String(held)}-` } } : {});
  } catch (error) {
    // A name that does not resolve, a connection reset, a timeout: the same request may be answered later.
    throw new TransientDownload(`${error instanceof Error ? error.message : String(error)} (${partial} holds ${megabytes(held)} MB)`);
  }
  if (response.status === 416) {
    // The range is past the archive's end: what the folder holds is not this archive, so it goes.
    rmSync(partial, { force: true });
    await response.body?.cancel();
    throw new Error(`${WHERE}:1: ${partial} holds more than the PostgreSQL ${POSTGRES_VERSION} archive has (${megabytes(held)} MB against ${megabytes(build.bytes)} MB): it was removed, and the next run downloads the archive again`);
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    const said = `the server answered ${String(response.status)} ${response.statusText}`;
    if (transientStatus(response.status)) throw new TransientDownload(said);
    throw new Error(`${WHERE}:1: the PostgreSQL ${POSTGRES_VERSION} archive could not be downloaded from ${url}: ${said}. madarch installs its server once, into ${folder}; the archive's address is pinned in src/adapters/postgres-builds.ts, and a refusal there names a change to that file, not a retry`);
  }
  // A resumed request the server answered whole is a restart: the file starts again from zero.
  const restart = held > 0 && response.status !== 206;
  if (restart) {
    held = 0;
    rmSync(partial, { force: true });
  }
  const known = build.bytes;
  const total = Number(response.headers.get('content-length') ?? '') > 0 && response.status === 206 ? held + Number(response.headers.get('content-length')) : known;
  const started = Date.now();
  let written = held;
  let lastReport = 0;
  let lastBytes = 0;
  const out = createWriteStream(partial, { flags: held > 0 ? 'a' : 'w' });
  try {
    for await (const chunk of response.body) {
      const bytes = chunk as Uint8Array;
      if (!out.write(bytes)) await new Promise<void>((resolve) => out.once('drain', () => { resolve(); }));
      written += bytes.length;
      const now = Date.now();
      if (now - lastReport >= PROGRESS_MS || written - lastBytes >= PROGRESS_BYTES) {
        lastReport = now;
        lastBytes = written;
        const percent = total > 0 ? ` (${String(Math.min(100, Math.round((written / total) * 100)))}%)` : '';
        const rate = written > held ? ` at ${megabytes(((written - held) / Math.max(1, now - started)) * 1_000)} MB/s` : '';
        options.progress(`madarch: PostgreSQL ${POSTGRES_VERSION}: ${megabytes(written)} MB of ${megabytes(total)} MB${percent}${rate}`);
      }
    }
  } catch (error) {
    out.destroy();
    // The archive ended early: what arrived stays in the part file, and the next attempt continues from there.
    throw new TransientDownload(`the download ended before the archive was whole: ${error instanceof Error ? error.message : String(error)} (${partial} holds ${megabytes(written)} MB)`);
  }
  await new Promise<void>((resolve, reject) => { out.end((error?: Error | null) => { if (error) reject(error); else resolve(); }); });
  options.progress(`madarch: PostgreSQL ${POSTGRES_VERSION}: ${megabytes(written)} MB of ${megabytes(total)} MB (100%)`);
  // The whole archive, under the name the verification reads: a file that is not whole never has that name.
  renameSync(partial, archive);
}

/**
 * Installs the pinned server once into `<madarch home>/tools/postgresql/<version>/`
 * and answers where its programs are. A folder already holding the pinned build
 * is used as it stands — the marker names the archive's sha256, and a folder
 * whose marker names another build is replaced.
 *
 * A download a killed process interrupted leaves a `.part` and no install marker,
 * so the folder it was writing is never mistaken for a server.
 */
export async function ensurePostgresInstalled(options: PostgresInstallOptions = {}): Promise<InstalledPostgres> {
  const env = options.env ?? process.env;
  refuseRoot(options.uid);
  const key = options.platform ?? platformKey();
  const build = options.build ?? postgresBuildFor(key);
  if (build === undefined) {
    throw new Error(`${WHERE}:1: no PostgreSQL ${POSTGRES_VERSION} build is pinned for ${key}: this build pins ${pinnedPlatforms().join(', ')}. madarch downloads its server at install and pins the archive's sha256; a platform no line of src/adapters/postgres-builds.ts pins has no archive to verify, so madarch cannot install one there — run madarch on a pinned platform, or add that platform's ${POSTGRES_VERSION} build (its target, URL and sha256 as the release publishes them) to that file`);
  }
  const folder = postgresInstallFolder(env);
  if (installedBuild(folder, build)) return { bin: join(folder, 'bin'), folder, build };
  const progress = options.progress ?? defaultProgress;
  const archive = join(postgresDownloadFolder(env), postgresArchiveName(build));
  const url = (options.archiveUrl ?? postgresArchiveUrl)(build);
  const digest = await digestOf(archive);
  if (digest !== build.sha256) {
    // An archive that is not the pinned one is not kept: the download starts again (or continues its `.part`).
    if (digest !== null) rmSync(archive, { force: true });
    await downloadArchive({ build, url, archive, folder, progress });
    const downloaded = await digestOf(archive);
    if (downloaded !== build.sha256) {
      rmSync(archive, { force: true });
      throw new Error(`${WHERE}:1: the archive downloaded from ${url} has sha256 ${String(downloaded)}, and ${folder} pins ${build.sha256} (PostgreSQL ${POSTGRES_VERSION}, ${build.target}): nothing was installed and the archive was removed. Check the release page for ${POSTGRES_VERSION}; if the release moved, that is a change to src/adapters/postgres-builds.ts, not to what this machine downloads`);
    }
  }
  progress(`madarch: unpacking PostgreSQL ${POSTGRES_VERSION} into ${folder}`);
  // A scratch folder a killed install left beside the target is swept: it is never a usable install.
  const parent = dirname(folder);
  const base = folder.slice(parent.length + 1);
  for (const name of readdirSync(parent)) if (name.startsWith(`${base}.unpack-`)) rmSync(join(parent, name), { recursive: true, force: true });
  const scratch = `${folder}.unpack-${String(process.pid)}`;
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    runProgram('tar', ['-xzf', archive, '-C', scratch, '--strip-components=1']);
    const missing = REQUIRED_PROGRAMS.filter((program) => !existsSync(join(scratch, 'bin', program)));
    if (missing.length > 0) throw new Error(`${WHERE}:1: the archive ${archive} was unpacked into ${scratch} but holds no bin/${missing.join(' or bin/')}: nothing was installed. Check that ${postgresArchiveName(build)} is the release's own archive`);
    for (const program of [...REQUIRED_PROGRAMS, 'psql', 'pg_dump', 'createdb', 'dropdb']) {
      const file = join(scratch, 'bin', program);
      if (existsSync(file)) chmodSync(file, 0o755);
    }
    writeFileSync(join(scratch, 'install.json'), `${JSON.stringify(markerFor(build), null, 2)}\n`);
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(parent, { recursive: true });
  renameSync(scratch, folder);
  // The archive has done its work; 38 MB kept beside the install is a download nobody needs again.
  rmSync(archive, { force: true });
  progress(`madarch: PostgreSQL ${POSTGRES_VERSION} is installed in ${folder}`);
  return { bin: join(folder, 'bin'), folder, build };
}

/**
 * What a download says when no caller listens: a line on the error stream, a
 * carriage return when that stream is a terminal so a long download moves
 * rather than scrolls.
 */
function defaultProgress(line: string): void {
  const stream = process.stderr;
  if (stream.isTTY === true) stream.write(`\r${line}`);
  else stream.write(`${line}\n`);
}
