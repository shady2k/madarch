/**
 * Installing the pinned bubblewrap the sandbox runs (decision 0035, item 9):
 * one statically linked binary, downloaded once into
 * `<madarch home>/tools/bubblewrap/<version>/`, its sha256 checked before it
 * is put in place and again before every use. The shape is
 * `src/adapters/postgres-install.ts`'s: a `.part` a killed download left is
 * continued rather than trusted, nothing half-installed is used, and the
 * marker `install.json` names the build the folder holds.
 *
 * The binary is static, so no unpacking step can lie between the check and
 * the first byte executed: the file that was hashed is the file that runs.
 */
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bwrapBinaryUrl, bwrapBuildFor, bwrapDownloadFolder, bwrapInstallFolder, bwrapPlatformKey, BWRAP_VERSION, type BwrapBuild } from './bwrap-builds.js';

/** Where a refusal stands. */
const WHERE = 'src/plugin/bwrap-install.ts';

/** The waits between a download's attempts: four attempts over about forty seconds. */
const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 20_000];

/** A download failure another attempt may answer differently: a dropped connection, a gateway's 5xx. */
class TransientDownload extends Error {}

export interface BwrapInstallOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** What the download reports as it moves: a line, without its newline. */
  readonly progress?: (line: string) => void;
  /** The build to install; the platform's pinned one unless a test names its own. */
  readonly build?: BwrapBuild;
  /** The platform key to install for; this machine's unless a test names one. */
  readonly platform?: string;
  /** Where the binary comes from; the release URL of `build` unless a test names its own. */
  readonly binaryUrl?: (build: BwrapBuild) => string;
}

/** The marker an installed folder carries: the build it holds, as this file pinned it. */
interface InstallMarker {
  readonly version: string;
  readonly platform: string;
  readonly target: string;
  readonly sha256: string;
}

/** The binary's file name inside the install folder. */
const BINARY_NAME = 'bwrap';

/** The sha256 of a file as the file states it, or null when it is not there. */
function digestOf(file: string): string | null {
  if (!existsSync(file)) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Whether the folder holds exactly the build the marker names, with the binary's bytes unchanged. */
function installedBuild(folder: string, build: BwrapBuild): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(folder, 'install.json'), 'utf8')) as Partial<InstallMarker>;
    if (marker.version !== BWRAP_VERSION || marker.platform !== build.platform || marker.target !== build.target || marker.sha256 !== build.sha256) return false;
  } catch {
    return false;
  }
  return digestOf(join(folder, BINARY_NAME)) === build.sha256;
}

/** Downloads the binary into a `.part` and renames it whole once its sha256 is the pinned one. */
async function downloadBuild(options: { build: BwrapBuild; url: string; folder: string; progress: (line: string) => void }): Promise<string> {
  const { build, url, folder } = options;
  mkdirSync(folder, { recursive: true });
  const part = join(folder, `${BINARY_NAME}-${build.target}.part`);
  let held = existsSync(part) ? statSync(part).size : 0;
  let last: Error | undefined;
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      if (held > 0) options.progress(`madarch: continuing the bubblewrap ${BWRAP_VERSION} download at ${String(held)} of ${String(build.bytes)} bytes (${folder})`);
      else options.progress(`madarch: downloading bubblewrap ${BWRAP_VERSION} for ${build.target}: ${String(build.bytes)} bytes into ${folder}`);
      let answer: Response;
      try {
        answer = await fetch(url, held > 0 ? { headers: { Range: `bytes=${String(held)}-` } } : {});
      } catch (error) {
        throw new TransientDownload(`${(error as Error).message} (${part} holds ${String(held)} bytes)`);
      }
      if (answer.status === 416) {
        rmSync(part, { force: true });
        throw new Error(`${part} holds more than the release's binary (${String(held)} bytes against ${String(build.bytes)}): it was removed, and the next run downloads it again`);
      }
      if (!answer.ok || answer.body === null) {
        await answer.body?.cancel();
        if (answer.status >= 500 || answer.status === 408 || answer.status === 429) throw new TransientDownload(`the server answered ${String(answer.status)} ${answer.statusText}`);
        throw new Error(`${WHERE}:1: bubblewrap ${BWRAP_VERSION} could not be downloaded from ${url}: the server answered ${String(answer.status)} ${answer.statusText}. The address is pinned in src/plugin/bwrap-builds.ts, and a refusal there names a change to that file, not a retry`);
      }
      if (held > 0 && answer.status !== 206) {
        held = 0;
        rmSync(part, { force: true });
      }
      const out = createWriteStream(part, { flags: held > 0 ? 'a' : 'w' });
      let written = held;
      try {
        for await (const chunk of answer.body) {
          const bytes = chunk as Uint8Array;
          if (!out.write(bytes)) await new Promise<void>((done) => out.once('drain', () => { done(); }));
          written += bytes.length;
        }
      } catch (error) {
        out.destroy();
        throw new TransientDownload(`the download ended before the binary was whole: ${(error as Error).message} (${part} holds ${String(written)} bytes)`);
      }
      await new Promise<void>((resolve, reject) => { out.end((error?: Error | null) => { if (error === null || error === undefined) resolve(); else reject(error); }); });
      const digest = digestOf(part);
      if (digest !== build.sha256) {
        rmSync(part, { force: true });
        throw new Error(`${WHERE}:1: the bubblewrap ${BWRAP_VERSION} binary downloaded from ${url} hashes to ${digest ?? 'nothing'}, and src/plugin/bwrap-builds.ts pins ${build.sha256}: the download is not the build madarch trusts, and it was removed`);
      }
      options.progress(`madarch: bubblewrap ${BWRAP_VERSION}: ${String(written)} bytes (100%), sha256 ${build.sha256}`);
      return part;
    } catch (error) {
      last = error as Error;
      held = existsSync(part) ? statSync(part).size : 0;
      // A refused address, a wrong hash and an over-long part file are answers, not accidents: only a connection's
      // own trouble is tried again.
      if (!(last instanceof TransientDownload) || attempt > RETRY_DELAYS_MS.length) break;
      const wait = RETRY_DELAYS_MS[attempt - 1]!;
      options.progress(`madarch: the bubblewrap ${BWRAP_VERSION} download failed (attempt ${String(attempt)} of ${String(RETRY_DELAYS_MS.length + 1)}): ${last.message}; trying again in ${String(Math.round(wait / 1_000))} s`);
      await Bun.sleep(wait);
    }
  }
  throw new Error(`${WHERE}:1: bubblewrap ${BWRAP_VERSION} could not be installed into ${folder}: ${last?.message ?? 'the download failed'}. The sandbox runs no plugin without it; run the command again when the release is reachable — a download cut short continues where it stopped`);
}

/** The installed binary's path, its build, and the folder it was installed in. */
export interface InstalledBwrap {
  readonly binary: string;
  readonly folder: string;
  readonly build: BwrapBuild;
}

/**
 * Installs the pinned binary once into `<tools>/bubblewrap/<version>/` and
 * answers where it is. A folder already holding the pinned bytes is used as
 * it stands; a folder holding anything else is replaced, never trusted.
 */
export async function ensureBwrapInstalled(options: BwrapInstallOptions = {}): Promise<InstalledBwrap> {
  const platform = options.platform ?? bwrapPlatformKey();
  const build = options.build ?? bwrapBuildFor(platform);
  if (build === undefined) {
    throw new Error(`${WHERE}:1: the sandbox has no bubblewrap build pinned for ${platform}: src/plugin/bwrap-builds.ts pins ${['linux-arm64', 'linux-x64'].join(' and ')}, and a Linux platform it does not pin cannot run a plugin confined (decision 0035, item 9)`);
  }
  if (build.platform !== platform) {
    throw new Error(`${WHERE}:1: the build ${build.platform} cannot stand in for ${platform}: bubblewrap runs the machine it was built for`);
  }
  const folder = bwrapInstallFolder(options.env ?? process.env);
  const binary = join(folder, BINARY_NAME);
  if (installedBuild(folder, build)) return { binary, folder, build };
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const part = await downloadBuild({ build, url: (options.binaryUrl ?? bwrapBinaryUrl)(build), folder: bwrapDownloadFolder(options.env ?? process.env), progress: options.progress ?? (() => undefined) });
  chmodSync(part, 0o755);
  const staged = join(dirname(part), `${BINARY_NAME}-${build.target}.ready`);
  renameSync(part, staged);
  renameSync(staged, binary);
  writeFileSync(join(folder, 'install.json'), `${JSON.stringify({ version: BWRAP_VERSION, platform: build.platform, target: build.target, sha256: build.sha256 }, null, 2)}\n`);
  return { binary, folder, build };
}

/**
 * The binary a run may execute: the installed one, hashed again before every
 * use and refused if it is not the pinned build. A file swapped after the
 * install is never the sandbox's supervisor.
 */
export async function bwrapForUse(options: BwrapInstallOptions = {}): Promise<InstalledBwrap> {
  const installed = await ensureBwrapInstalled(options);
  const digest = digestOf(installed.binary);
  if (digest !== installed.build.sha256) {
    throw new Error(`${WHERE}:1: ${installed.binary} hashes to ${digest ?? 'nothing'}, and src/plugin/bwrap-builds.ts pins ${installed.build.sha256}: the installed sandbox is not the build madarch trusts. Remove ${installed.folder} and run again to install it`);
  }
  return installed;
}
