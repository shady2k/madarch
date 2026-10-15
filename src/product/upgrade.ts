/**
 * `madarch upgrade` (madarch-lfhu; outcome 5 of docs/milestones/standalone.md):
 * the binary fetches its repository's latest GitHub release, checks the
 * artifact for its own platform against the release's checksum file, and
 * replaces the running executable with it — after naming both versions and
 * receiving a yes; every other answer leaves the binary alone. A source
 * checkout refuses: it has nothing to replace (the compilation is its own
 * check). The GitHub addresses and the network client are injectable for
 * the tests; the command passes the process's own.
 *
 * The flow is a release contract, not a conversation: the newest release
 * is one GET on the API, the artifact and the checksum file are two
 * downloads off the named release, and the replace is one rename over the
 * running executable's path (the running process keeps its old pages; the
 * next launch runs the new binary). Windows has no release artifact, and
 * the refusal names that instead of promising a download.
 *
 * Exit codes: 0 when nothing needed doing or the replace is done; 2 when a
 * refusal names what is wrong (a source checkout, an unknown platform, an
 * answer that is not a yes, a release or an artifact not found); 1 when a
 * step failed (a network error, an unreadable checksum or one that does
 * not match, a rename refused).
 */
import { chmodSync, mkdtempSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { runningVersion } from './version.js';

/** The GitHub repository this binary upgrades itself from (the project's own). */
export const GITHUB_REPO = 'shady2k/madarch';

/** The releases' API address: `releases/latest` answers the newest release's JSON. */
export const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** The artifact name of one platform: the release build lays every binary under this name. */
export function artifactName(platform: string, arch: string): string {
  return `madarch-${platform}-${arch}`;
}

/** The checksum file every release carries: one line per artifact, `sha256  <name>`. */
export const CHECKSUMS_FILE = 'SHA256SUMS.txt';

/** One release the API answered: its tag and a full download address per asset name. */
export interface ReleaseAnswer {
  /** The release's own name: the tag the release build was made from, like `v1.2.3`. */
  tag: string;
  /** A full download address per asset name, as the releases API names them. */
  assets: Record<string, string>;
}

/** What one run decided, as the CLI's other outcomes spell theirs. */
export interface UpgradeOutcome {
  readonly prints: readonly string[];
  readonly errors: readonly string[];
  readonly exit: number;
}

/** The pieces the upgrade flow is run with; every one is the process's own when left out. */
export interface UpgradeOptions {
  /** The HTTP client the API and the downloads go through; `fetch` by default. */
  readonly fetch?: typeof fetch;
  /** The yes the prompt needs: `y`/`yes` counts, everything else refuses. Reads the process's stdin by default. */
  readonly answer?: () => string;
  /** When true, the named `--yes` flag: no prompt is asked, the answer is the yes. */
  readonly skipPrompt?: boolean;
  /** The reader of the prompt's lines (the confirmation before the answer); standard error by default. */
  readonly promptOut?: (line: string) => void;
  /** Where the releases API lives (its JSON schema stays the releases API's). */
  readonly releasesUrl?: string;
  /** The file the replace lays over; the running executable's own path by default (tests name a scratch copy). */
  readonly targetPath?: string;
  /** The version the binary answers with, over the embedded one (tests name the version the release names). */
  readonly currentVersion?: string;
}

/**
 * Reads the prompt's answer from the process's standard input: one line,
 * the way a person types it; an input ending without a line reads as a
 * no other answer would say. The default of `UpgradeOptions.answer`.
 */
export function answeredFromStdin(): () => string {
  return (): string => {
    const lines: number[] = [];
    const chunk = Buffer.alloc(1);
    // One line, one read at a time: a person types the answer and presses
    // enter; the loop stops at `\n`, at `\r` when line endings name it, or
    // when standard input ends (an empty read).
    for (;;) {
      const got = readOneByte(chunk);
      if (got === 0) break;
      const byte = chunk[0] ?? 0;
      if (byte === 0x0a) break;
      if (byte === 0x0d) continue;
      lines.push(byte);
    }
    return Buffer.from(lines).toString('utf8');
  };
}

function readOneByte(into: Buffer): number {
  // A positional read is refused on a pipe (ESPIPE), so read sequentially.
  try {
    return readSync(0, into, 0, 1, null);
  } catch {
    return 0;
  }
}

/** The checksum line of one artifact out of the whole file, by its name. */
export function checksumFor(sumFile: string | Uint8Array, name: string): string | undefined {
  const text = Buffer.from(sumFile).toString('utf8');
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length === 2 && fields[1] === name && /^[0-9a-f]{64}$/.test(fields[0]!)) return fields[0];
  }
  return undefined;
}

/** The sha256 of a buffer, the way the checksum file names it. */
export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Reads the releases API's JSON into the answer the flow asks for: the tag
 * and the platform artifact plus the checksum file. Assets of a different
 * contract (no tag, no binary with the name artifactName names) are the
 * refusal's message, not a half answer.
 */
export function parseReleases(json: unknown, wanted: string): { ok: true; release: ReleaseAnswer } | { ok: false; message: string } {
  if (json === null || typeof json !== 'object') return { ok: false, message: 'the release answered no object' };
  const record = json as { tag_name?: unknown; assets?: unknown };
  if (typeof record.tag_name !== 'string' || !/^v[a-zA-Z0-9.-]+$/.test(record.tag_name)) {
    return { ok: false, message: 'the release answered no version tag (tag_name)' };
  }
  if (!Array.isArray(record.assets)) return { ok: false, message: 'the release answered no assets list' };
  const assets: Record<string, string> = {};
  for (const asset of record.assets) {
    if (asset === null || typeof asset !== 'object') continue;
    const one = asset as { name?: unknown; browser_download_url?: unknown };
    if (typeof one.name === 'string' && typeof one.browser_download_url === 'string') assets[one.name] = one.browser_download_url;
  }
  if (assets[wanted] === undefined || assets[CHECKSUMS_FILE] === undefined) {
    return {
      ok: false,
      message: `the release carries no ${wanted}` + (assets[CHECKSUMS_FILE] === undefined ? ` and no ${CHECKSUMS_FILE}` : ''),
    };
  }
  return { ok: true, release: { tag: record.tag_name, assets } };
}

/** One printed upgrade; the command maps the outcome's exit code onto its own. */
export async function upgrade(options: UpgradeOptions = {}): Promise<UpgradeOutcome> {
  const current = options.currentVersion ?? runningVersion();
  if (current === 'dev') {
    return {
      prints: [],
      errors: ['madarch upgrade runs in a release build: this is a source checkout, madarch upgrade has nothing to replace there'],
      exit: 2,
    };
  }
  const fetch_ = options.fetch ?? fetch;
  const wanted = artifactName(process.platform, process.arch);
  let answer: Response;
  try {
    answer = await fetch_(options.releasesUrl ?? RELEASES_API, { headers: { 'user-agent': 'madarch-upgrade' } });
  } catch (error) {
    return { prints: [], errors: [`the releases at ${options.releasesUrl ?? RELEASES_API} could not be reached: ${(error as Error).message}`], exit: 1 };
  }
  if (!answer.ok) {
    return { prints: [], errors: [`the releases at ${options.releasesUrl ?? RELEASES_API} answered ${String(answer.status)}`], exit: 1 };
  }
  let text: string;
  try {
    text = await answer.text();
  } catch (error) {
    return { prints: [], errors: [`the releases at ${options.releasesUrl ?? RELEASES_API} could not be read: ${(error as Error).message}`], exit: 1 };
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (error) {
    return { prints: [], errors: [`the releases answered no JSON: ${(error as Error).message}`], exit: 1 };
  }
  const parsed = parseReleases(json, wanted);
  if (!parsed.ok) return { prints: [], errors: [`${parsed.message}: ${options.releasesUrl ?? RELEASES_API}`], exit: 1 };
  const release = parsed.release;
  if (release.tag === currentTag(current)) {
    return { prints: [`already at ${current}: nothing to upgrade`], errors: [], exit: 0 };
  }
  // The confirmation names both versions and the answer it waits for: the
  // question is asked (before the read answers it), then the answer counts.
  const promptOut = options.promptOut ?? ((line: string) => console.error(line));
  if (!options.skipPrompt) promptOut(`upgrading madarch from ${current} to ${release.tag}: the downloaded ${wanted} replaces the running binary at ${runningExecutable(options)}. proceed? [y/N]`);
  const ask = options.skipPrompt ? 'y' : (options.answer ?? answeredFromStdin())();
  if (!/^(y|yes)$/i.test(ask.trim())) {
    return { prints: [], errors: [`upgrading to ${release.tag} refused: the answer was ${JSON.stringify(ask)}, yes is y or yes`], exit: 2 };
  }
  const [binary, sums] = await Promise.all([
    download(fetch_, release.assets[wanted] ?? ''),
    download(fetch_, release.assets[CHECKSUMS_FILE] ?? ''),
  ]);
  if (binary.ok === false) return { prints: [], errors: [`the artifact ${wanted} could not be downloaded: ${binary.message}`], exit: 1 };
  if (sums.ok === false) return { prints: [], errors: [`${CHECKSUMS_FILE} could not be downloaded: ${sums.message}`], exit: 1 };
  const expected = checksumFor(sums.body, wanted);
  if (expected === undefined) {
    return { prints: [], errors: [`${CHECKSUMS_FILE} carries no line for ${wanted}`], exit: 1 };
  }
  if (sha256(binary.body) !== expected) {
    return {
      prints: [],
      errors: [`the downloaded ${wanted} does not match its checksum (expected ${expected}, got ${sha256(binary.body)}); nothing was replaced`],
      exit: 1,
    };
  }
  const target = runningExecutable(options);
  // Staging beside the target, not in the system temp: the replace is a
  // rename, a step that refuses crossing a filesystem (EXDEV), and an
  // installed binary's prefix can be a mounted volume outside the system temp directory.
  const stage = join(dirname(target), (basename(target) as string) + '.upgrade-new');
  writeFileSync(stage, binary.body);
  chmodSync(stage, 0o755);
  try {
    renameSync(stage, target);
  } catch (error) {
    rmSync(stage, { force: true });
    return { prints: [], errors: [`the binary at ${target} could not be replaced: ${(error as Error).message}`], exit: 1 };
  }
  return {
    prints: [`upgraded to ${release.tag}: the next launch runs it (this process still runs ${current})`],
    errors: [],
    exit: 0,
  };
}

/** A release tag that matches a version the binary answers with: `v1.2.3` beside `1.2.3`. */
function currentTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

/** The file the replace lays over: the running executable's own path, or the option's. */
function runningExecutable(options: UpgradeOptions): string {
  return options.targetPath ?? process.execPath;
}

async function download(fetch_: typeof fetch, url: string): Promise<{ ok: true; body: Buffer } | { ok: false; message: string }> {
  let answer: Response;
  try {
    answer = await fetch_(url, { headers: { 'user-agent': 'madarch-upgrade' } });
  } catch (error) {
    return { ok: false, message: `${url}: ${(error as Error).message}` };
  }
  if (!answer.ok) return { ok: false, message: `${url}: answered ${String(answer.status)}` };
  try {
    return { ok: true, body: Buffer.from(await answer.arrayBuffer()) };
  } catch (error) {
    return { ok: false, message: `${url}: ${(error as Error).message}` };
  }
}

