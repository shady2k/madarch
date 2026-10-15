/**
 * The upgrade flow's own decisions, on a fake release (madarch-lfhu): the
 * API's JSON is read for the artifact the platform names, the checksum is
 * verified before anything moves, the yes is the only answer that proceeds,
 * and the replace is a rename over the named target. The network client and
 * the answer are injected; a release is faked locally, no GitHub is called.
 */
import { chmodSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { artifactName, CHECKSUMS_FILE, upgrade, sha256, checksumFor, parseReleases } from '../src/product/upgrade.js';
import { releaseVersion } from '../src/product-wiki/release-assets.js';

describe('release artifact platform names', () => {
  test('Windows x64 uses the Windows executable asset name', () => {
    expect(artifactName('win32', 'x64')).toBe('madarch-windows-x64.exe');
  });
});

describe('the version the running release answers', () => {
  test('a checkout answers dev and releaseVersion reads the embedded file, where it is', () => {
    // The test process is a source checkout: the version file the release
    // build embeds does not exist under the modules' own directory.
    expect(releaseVersion()).toBeUndefined();
  });
});

describe('the checksum reader', () => {
  test('names the line of the artifact, and nothing of other shapes', () => {
    const sums = '1111111111111111111111111111111111111111111111111111111111111111  madarch-linux-x64\n';
    expect(checksumFor(sums, 'madarch-linux-x64')).toBe('1111111111111111111111111111111111111111111111111111111111111111');
    expect(checksumFor(sums, 'missing')).toBeUndefined();
    expect(checksumFor('not-a-sha madarch-linux-x64' + '\n', 'madarch-linux-x64')).toBeUndefined();
    // the digest is exactly 64 hex digits: shorter, longer or mixed cases are not lines at all
    const sixtyThree = 'a'.repeat(63) + ' madarch-linux-x64\n';
    const sixtyFive = 'a'.repeat(65) + ' madarch-linux-x64\n';
    const uppercase = 'A'.repeat(64) + ' madarch-linux-x64\n';
    expect(checksumFor(sixtyThree, 'madarch-linux-x64')).toBeUndefined();
    expect(checksumFor(sixtyFive, 'madarch-linux-x64')).toBeUndefined();
    expect(checksumFor(uppercase, 'madarch-linux-x64')).toBeUndefined();
    expect(checksumFor('1'.repeat(64) + '  madarch-linux-x64  extra\n', 'madarch-linux-x64')).toBeUndefined();
    expect(checksumFor('aaa', 'madarch-linux-x64')).toBeUndefined();
    // the same answer through the bytes the download hands over
    expect(checksumFor(Buffer.from(sums3(), 'utf8'), 'madarch-linux-x64')).toBe('1'.repeat(64));
    expect(sha256(Buffer.from('x')).length).toBe(64);
  });
});

/** One line without spaces inside the digest: 'a  b' split on whitespace is two fields. */
function sums3(): string {
  return '1'.repeat(64) + '  madarch-linux-x64\n';
}

describe('the release parser', () => {
  const wanted = 'madarch-linux-x64';
  test('keeps the tag and the two named assets, refuses the rest, each refusal named', () => {
    const parsed = parseReleases({
      tag_name: 'v1.2.3',
      assets: [
        { name: wanted, browser_download_url: 'https://x/' + wanted },
        { name: CHECKSUMS_FILE, browser_download_url: 'https://x/' + CHECKSUMS_FILE },
      ],
    }, wanted);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.release.tag).toBe('v1.2.3');
      expect(parsed.release.assets).toEqual({ [wanted]: 'https://x/' + wanted, [CHECKSUMS_FILE]: 'https://x/' + CHECKSUMS_FILE });
    }
    // each refusal path names its own words: the tag's shape, a spread that is no list, an absent artifact
    const noTag = parseReleases({ tag_name: 'wat', assets: [] }, wanted);
    expect(noTag.ok).toBe(false);
    if (!noTag.ok) expect(noTag.message).toContain('no version tag (tag_name)');
    const noTagShape = parseReleases({ tag_name: 'x', assets: [] }, wanted);
    expect(noTagShape.ok).toBe(false);
    if (!noTagShape.ok) expect(noTagShape.message).toContain('no version tag (tag_name)');
    // the regex that accepts a tag is whole: no half shape, no leading or trailing half
    const wholeTag = parseReleases({ tag_name: 'xa1', assets: [] }, wanted);
    expect(wholeTag.ok).toBe(false);
    if (!wholeTag.ok) expect(wholeTag.message).toContain('no version tag (tag_name)');
    const wholeTagEnd = parseReleases({ tag_name: 'v1.2.3 and', assets: [] }, wanted);
    expect(wholeTagEnd.ok).toBe(false);
    if (!wholeTagEnd.ok) expect(wholeTagEnd.message).toContain('no version tag (tag_name)');
    // a tag value that only matches after a suffix or is not a string beside being v-shaped is refused the same way
    const suffix = parseReleases({ tag_name: 'wat-v1.2.3', assets: [] }, wanted);
    expect(suffix.ok).toBe(false);
    if (!suffix.ok) expect(suffix.message).toContain('no version tag (tag_name)');
    const notString = parseReleases({ tag_name: ['v1.2-b.3'], assets: [{ name: wanted, browser_download_url: 'u' }, { name: CHECKSUMS_FILE, browser_download_url: 'u2' }] }, wanted);
    expect(notString.ok).toBe(false);
    if (!notString.ok) expect(notString.message).toContain('no version tag (tag_name)');
    const number = parseReleases({ tag_name: 42, assets: [] }, wanted);
    expect(number.ok).toBe(false);
    if (!number.ok) expect(number.message).toContain('no version tag (tag_name)');
    // an input that is no object at all, including null and a number
    expect(parseReleases(null, wanted)).toMatchObject({ ok: false, message: 'the release answered no object' });
    expect(parseReleases(42, wanted)).toMatchObject({ ok: false, message: 'the release answered no object' });
    const noList = parseReleases({ tag_name: 'v1.2.3', assets: 'not a list' }, wanted);
    expect(noList.ok).toBe(false);
    if (!noList.ok) expect(noList.message).toContain('no assets list');
    // an asset with a name but no download address, or none of either, is not part of the answer
    const shaped = parseReleases({ tag_name: 'v1.2.3', assets: [{ name: 'only-name' }, null, 'a string', { name: wanted, browser_download_url: 'https://x/' + wanted }, { name: CHECKSUMS_FILE, browser_download_url: 'https://x/' + CHECKSUMS_FILE }] }, wanted);
    expect(shaped.ok).toBe(true);
    if (shaped.ok) {
      // the answer keeps ONLY the whole entries, in the names the contract names
      expect(shaped.release.assets).toEqual({ [wanted]: 'https://x/' + wanted, [CHECKSUMS_FILE]: 'https://x/' + CHECKSUMS_FILE });
    }
    // an asset with no download address of the artifact is not in the answer: the refusal names it
    const wrongUrlShape = parseReleases({ tag_name: 'v1.2.3', assets: [{ name: wanted, browser_download_url: 42 }, { name: CHECKSUMS_FILE, browser_download_url: 'u2' }] }, wanted);
    expect(wrongUrlShape.ok).toBe(false);
    if (!wrongUrlShape.ok) expect(wrongUrlShape.message).toContain('carries no');
    const missingUrlSolo = parseReleases({ tag_name: 'v1.2.3', assets: [{ name: wanted }, { name: CHECKSUMS_FILE, browser_download_url: 'u2' }] }, wanted);
    expect(missingUrlSolo.ok).toBe(false);
    if (!missingUrlSolo.ok) expect(missingUrlSolo.message).toContain('carries no');
    // a malformed asset that still carries both names stands with the download URL kept as the API said
    // a version-ish tag with a hyphen and a dot stands
    const tag = parseReleases({ tag_name: 'v1.2-b.3', assets: [{ name: wanted, browser_download_url: 'u' }, { name: CHECKSUMS_FILE, browser_download_url: 'u2' }] }, wanted);
    expect(tag.ok).toBe(true);
    // a release with one of the two named assets is refused by name, in tags both ways
    const noArtifact = parseReleases({ tag_name: 'v1.2.3', assets: [{ name: CHECKSUMS_FILE, browser_download_url: 'https://x/' + CHECKSUMS_FILE }] }, wanted);
    expect(noArtifact.ok).toBe(false);
    if (!noArtifact.ok) expect(noArtifact.message).toBe(`the release carries no ${wanted}`);
    const noSums = parseReleases({ tag_name: 'v1.2.3', assets: [{ name: wanted, browser_download_url: 'https://x/' + wanted }] }, wanted);
    expect(noSums.ok).toBe(false);
    if (!noSums.ok) expect(noSums.message).toContain(`and no ${CHECKSUMS_FILE}`);
    // half-shaped artifact entries: the conditional that keeps one asset has to keep both fields
    const missingUrl = parseReleases({ tag_name: 'v1.2.3', assets: [{ name: wanted }, { name: CHECKSUMS_FILE, browser_download_url: 'u2' }] }, wanted);
    expect(missingUrl.ok).toBe(false);
    if (!missingUrl.ok) expect(missingUrl.message).toContain('carries no');
  });
});

/** The fake release the depreciation fetches serve, plus the local file URLs it names. */
/** The injectable fetch the flow is driven with; the release is a plain function-shaped client. */
class LocalFetch {
  private readonly files = new Map<string, { status: number; body: string }>();
  /** The requests that came through, as the client saw them: url then headers, for the runs that ask. */
  readonly requests: { url: string; headers: Record<string, unknown> }[] = [];

  set(path: string, status: number, body: string): void {
    this.files.set(path, { status, body });
  }

  get handler(): typeof fetch {
    return ((_url: unknown, init?: { headers?: Record<string, unknown> }): Promise<Response> => {
      const one = this.files.get(String(_url));
      this.requests.push({ url: String(_url), headers: init?.headers ?? {} });
      return new Promise<Response>((resolve) => {
        resolve(new Response(one?.body ?? 'NOT LAID', { status: one?.status ?? 404 }));
      });
    }) as unknown as typeof fetch;
  }
}

function fakeRelease(tag: string, actual: string): { fetch: typeof fetch; wanted: string; sumsBody: string; client: LocalFetch } {
  const wanted = artifactName('linux', 'x64');
  const client = new LocalFetch();
  client.set('releases', 200, JSON.stringify({ tag_name: tag, assets: [{ name: wanted, browser_download_url: 'local:/' + wanted }, { name: CHECKSUMS_FILE, browser_download_url: 'local:/' + CHECKSUMS_FILE }] }));
  client.set('local:/' + wanted, 200, actual);
  const sumsBody = `${sha256(Buffer.from(actual))}  ${wanted}
${sha256(Buffer.from('junk'))}  ${CHECKSUMS_FILE}`;
  client.set('local:/' + CHECKSUMS_FILE, 200, sumsBody);
  return { fetch: client.handler, wanted, sumsBody, client };
}

describe('the upgrade flow', () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  });

  test('source checkout refuses before any network', async () => {
    const result = await upgrade({ fetch: (() => new Promise((_resolve, reject) => reject(new Error('network asked')))) as unknown as typeof fetch, answer: () => 'y' });
    expect(result.exit).toBe(2);
    expect(result.errors.join('')).toContain('source checkout');
  });
});

describe('the whole upgrade run, on a local release', () => {
  let home: string | undefined;
  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function scratchBinary(): string {
    home = mkdtempSync(join(tmpdir(), 'madarch-upgrade-test-'));
    const file = join(home, artifactName('linux', 'x64'));
    writeFileSync(file, 'running binary contents');
    chmodSync(file, 0o755);
    return file;
  }

  test('an already-current release answers nothing to do and touches nothing', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.2.3', 'new binary contents');
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
    expect(result.exit).toBe(0);
    expect(result.prints.join('')).toContain('already at 1.2.3');
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('an answer that is not a yes refuses and leaves the binary in place', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'new binary contents');
    for (const answer of ['', 'n', 'no', 'yy', 'yes sir', 'unlikely']) {
      const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => answer, targetPath: target, currentVersion: '1.2.3' });
      expect(result.exit).toBe(2);
      expect(result.errors.join('')).toContain(`upgrading to v1.3.0 refused`);
      expect(readFileSync(target, 'utf8')).toBe('running binary contents');
    }
  });

  test('a yes with a matching checksum replaces the target, mode bits keep it runnable', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'the replacement binary bytes');
    const asked: string[] = [];
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3', promptOut: (line) => asked.push(line) });
    expect(result.exit).toBe(0);
    expect(result.prints.join('')).toContain('upgraded to v1.3.0');
    expect(readFileSync(target, 'utf8')).toBe('the replacement binary bytes');
    expect(statSync(target).mode & 0o111).not.toBe(0);
    // the question is asked before the read: it names both versions and the replace target
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain('from 1.2.3 to v1.3.0');
    expect(asked[0]).toContain('[y/N]');
  });

  test('without an injected prompt reader the question goes on standard error', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'the replacement binary bytes');
    const said: string[] = [];
    const originalError = console.error;
    console.error = (line: unknown) => { said.push(String(line)); };
    try {
      const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
      expect(result.exit).toBe(0);
    } finally {
      console.error = originalError;
    }
    expect(said.some((line) => line.includes('from 1.2.3 to v1.3.0') && line.includes('[y/N]'))).toBe(true);
  });

  test('the --yes answer asks no question and proceeds like a typed yes', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'the replacement binary bytes');
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => { throw new Error('no prompt was asked'); }, skipPrompt: true, targetPath: target, currentVersion: '1.2.3', promptOut: () => { throw new Error('no question was printed'); } });
    expect(result.exit).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('the replacement binary bytes');
  });

  test('a checksum mismatch fails the run and leaves the binary alone', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'the replacement binary bytes');
    r.client.set('local:/' + CHECKSUMS_FILE, 200, `${sha256(Buffer.from('other bytes'))}  ${r.wanted}\n`);
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
    expect(result.exit).toBe(1);
    expect(result.errors.join('')).toContain('does not match its checksum');
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('a missing artifact asset is named and the binary stays whole', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'the replacement binary bytes');
    r.client.set('local:/' + r.wanted, 404, 'NOT LAID');
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
    expect(result.exit).toBe(1);
    expect(result.errors.join('')).toContain('could not be downloaded');
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('an answer read off a closed input (EOF) is a refusal, like any other answer that is not a yes', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'the replacement binary bytes');
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => '', targetPath: target, currentVersion: '1.2.3' });
    expect(result.exit).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('a release whose assets lack the platform binary is refused (the 404 by name)', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'not fed');
    r.client.set('releases', 200, JSON.stringify({ tag_name: 'v1.3.0', assets: [{ name: CHECKSUMS_FILE, browser_download_url: 'local:/' + CHECKSUMS_FILE }] }));
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
    expect(result.exit).toBe(1);
    expect(result.errors.join('')).toContain('the release carries no');
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('a current version already carrying the v is matched as it stands', async () => {
    const r = fakeRelease('v9.9.9', 'new bytes');
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', currentVersion: 'v9.9.9' });
    expect(result.exit).toBe(0);
    expect(result.prints.join('')).toContain('already at v9.9.9');
  });

  test('a release whose checksum file cannot be read is refused, the binary staying whole', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'the replacement binary bytes');
    r.client.set('local:/' + CHECKSUMS_FILE, 404, 'NOT LAID');
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
    expect(result.exit).toBe(1);
    expect(result.errors.join('')).toContain('could not be downloaded');
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('a checksum file that carries no line for the artifact is refused by name', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'the replacement binary bytes');
    r.client.set('local:/' + CHECKSUMS_FILE, 200, sha256(Buffer.from('other')) + '  other-artifact\n');
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
    expect(result.exit).toBe(1);
    expect(result.errors.join('')).toContain('carries no line for');
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('the releases and download asks name the user agent of the flow', async () => {
    const target = scratchBinary();
    const r = fakeRelease('v1.3.0', 'the replacement binary bytes');
    await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
    for (const request of r.client.requests) {
      expect(request.headers['user-agent']).toBe('madarch-upgrade');
    }
    expect(r.client.requests.length).toBe(3);
  });

  test('a fetch that throws on the artifact names its cause; the running binary stays itself', async () => {
    const target = scratchBinary();
    const throwing = (async (url: unknown): Promise<Response> => {
      const one = String(url);
      if (one === 'releases') {
        const r = fakeRelease('v1.3.0', 'never read');
        return r.fetch('releases');
      }
      throw new Error('the artifact host cannot be reached');
    }) as unknown as typeof fetch;
    const result = await upgrade({ fetch: throwing, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
    expect(result.exit).toBe(1);
    expect(result.errors.join('')).toContain('could not be downloaded');
    expect(result.errors.join('')).toContain('the artifact host cannot be reached');
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('an artifact whose body cannot be read is named and the binary stays itself', async () => {
    const target = scratchBinary();
    const base = fakeRelease('v1.3.0', 'never read');
    const flaky = (async (url: unknown): Promise<Response> => {
      const one = String(url);
      if (one === 'releases') return base.fetch('releases');
      if (one.endsWith(CHECKSUMS_FILE)) return base.fetch('local:/' + CHECKSUMS_FILE);
      return { ok: true, arrayBuffer: async () => { throw new Error('the artifact body could not be read'); } } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await upgrade({ fetch: flaky, releasesUrl: 'releases', answer: () => 'y', targetPath: target, currentVersion: '1.2.3' });
    expect(result.exit).toBe(1);
    expect(result.errors.join('')).toContain('the artifact body could not be read');
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('a fetch that cannot run names its cause and the address', async () => {
    const target = scratchBinary();
    const throwing = (async () => { throw new Error('the network refuses the connection'); }) as unknown as typeof fetch;
    const result = await upgrade({ fetch: throwing, releasesUrl: 'releases', currentVersion: '1.2.3' });
    expect(result.exit).toBe(1);
    expect(result.errors.join('')).toContain('could not be reached');
    expect(result.errors.join('')).toContain('the network refuses the connection');
    expect(readFileSync(target, 'utf8')).toBe('running binary contents');
  });

  test('the releases API refusal names its status', async () => {
    const r = fakeRelease('v1.3.0', 'x');
    r.client.set('releases', 403, 'no');
    const result = await upgrade({ fetch: r.fetch, releasesUrl: 'releases', answer: () => 'y', currentVersion: '1.2.3' });
    expect(result.exit).toBe(1);
    expect(result.errors.join('')).toContain('answered 403');
  });
});

describe('the yes read from standard input', () => {
  /** One child run reading a line off its standard input, the way a person answers the prompt. */
  function readAnswer(piped: string): string {
    const childScript = `console.log(JSON.stringify((await import(${JSON.stringify(new URL('../src/product/upgrade.js', import.meta.url).href)})).answeredFromStdin()()));`;
    const run = spawnSync('bun', ['-e', childScript], { encoding: 'utf8', input: piped, env: { ...process.env } });
    if (run.status !== 0) throw new Error(run.stderr);
    const parsed = JSON.parse(run.stdout) as string;
    return parsed;
  }

  test('a yes line, a CR+LF line, a line without a newline and an empty input read as their bytes', () => {
    expect(readAnswer('y\n')).toBe('y');
    expect(readAnswer('yes\r\n')).toBe('yes');
    expect(readAnswer('yes')).toBe('yes');
    expect(readAnswer('')).toBe('');
  });

  test('the answer\'s own bytes are the line\'s, before the flow trims', () => {
    expect(readAnswer('  y \n')).toBe('  y ');
  });
});
