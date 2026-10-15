#!/usr/bin/env bun
/**
 * Assembles one release binary of the madarch command (madarch-lfhu): the
 * wiki app's built folder and the release's version are laid into a scratch
 * folder the way the compiled binary reads them (`Bun.main`'s directory),
 * then `bun build --compile` embeds and bundles the entry. The wiki app's
 * dist must be built first (`bun install --frozen-lockfile && bun run build`
 * in `wiki/app`); the release workflow and a local run both call this
 * script, so the layout the binary reads is checked here and not in the
 * workflow's steps.
 *
 *   bun scripts/build-binary.ts --version 1.2.3 [--os linux] [--arch x64] [--out dist]
 *
 * --version is what `madarch version` answers and the name `madarch
 * upgrade` matches against the release tag (`v` and what the file holds).
 * --os and --arch name the artifact (`madarch-<os>-<arch>`); the defaults
 * are this machine's own. The result is `<out>/madarch-<os>-<arch>`, and
 * the script smoke-runs it (`version`, `list` with a scratch home) before
 * it reports done: a binary that cannot start its own command is not a
 * done build.
 *
 * Exit 0 built, 1 when a step of the build fails, 2 when an argument or
 * the input (the wiki app's dist) cannot be used; every refusal names what
 * is wrong.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const USAGE = 'usage: bun scripts/build-binary.ts --version <x.y.z> [--os linux|darwin] [--arch x64|arm64] [--out <folder>]';

interface BuildOptions {
  version: string;
  os: string;
  arch: string;
  out: string;
}

/** The repo's own checkout root, where the built wiki app and the entry stand. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: readonly string[]): BuildOptions | number {
  const parsed: BuildOptions = { version: '', os: '', arch: '', out: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const takes = (name: string): string | undefined => {
      if (arg === `--${name}`) return argv[i + 1] ?? '';
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      return undefined;
    };
    const version = takes('version');
    if (version !== undefined) {
      parsed.version = version;
      if (arg === '--version') i++;
      continue;
    }
    const os = takes('os');
    if (os !== undefined) {
      parsed.os = os;
      if (arg === '--os') i++;
      continue;
    }
    const arch = takes('arch');
    if (arch !== undefined) {
      parsed.arch = arch;
      if (arg === '--arch') i++;
      continue;
    }
    const out = takes('out');
    if (out !== undefined) {
      parsed.out = out;
      if (arg === '--out') i++;
      continue;
    }
    console.error(`unknown option "${arg}"`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.os === '') parsed.os = process.platform;
  if (parsed.arch === '') parsed.arch = process.arch;
  if (parsed.os !== 'linux' && parsed.os !== 'darwin') {
    console.error(`--os ${JSON.stringify(parsed.os)} names no released platform: the release builds linux and darwin`);
    return 2;
  }
  if (parsed.arch !== 'x64' && parsed.arch !== 'arm64') {
    console.error(`--arch ${JSON.stringify(parsed.arch)} names no released architecture: the release builds x64 and arm64`);
    return 2;
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(parsed.version)) {
    console.error(`--version ${JSON.stringify(parsed.version)} is no release version: the file the binary embeds answers read as "x.y.z" text`);
    return 2;
  }
  return parsed;
}

/** Lays the embed tree the binary reads: `wiki-app` (the dist, its stamp out) and `version` (the text). */
function stageAssets(stage: string, options: BuildOptions): { ok: true } | { ok: false; message: string } {
  const sourceDist = join(REPO_ROOT, 'wiki', 'app', 'dist');
  if (!existsSync(join(sourceDist, 'index.html'))) {
    return { ok: false, message: `the wiki app's built files are not at ${join(sourceDist, 'index.html')}: build the wiki app first ("bun install --frozen-lockfile && bun run build" in wiki/app)` };
  }
  const wikiApp = join(stage, 'wiki-app');
  cpSync(sourceDist, join(wikiApp, 'dist'), { recursive: true });
  // The dist of a working checkout carries the app-folder stamp its own
  // sources hash; inside the binary there are no sources to compare with,
  // so the stamp would make every start want a rebuild. The embedded dist
  // ships without it: a dist with no stamp record is served as it stands.
  const stamp = join(wikiApp, 'dist', '.sources-hash');
  if (existsSync(stamp)) rmSync(stamp);
  rmSync(join(wikiApp, 'dist', 'node_modules'), { recursive: true, force: true });
  writeFileSync(join(stage, 'version'), `${options.version}\n`);
  return { ok: true };
}

function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  if (typeof options === 'number') return options;
  const stage = mkdtempSync(join(tmpdir(), 'madarch-build-binary-'));
  try {
    const staged = stageAssets(stage, options);
    if (!staged.ok) {
      console.error(staged.message);
      return 2;
    }
    const artifact = `madarch-${options.os}-${options.arch}`;
    const outfile = resolve(options.out, artifact);
    const target = options.os === 'darwin' ? `bun-darwin-${options.arch}` : `bun-linux-${options.arch}`;
    const run = spawnSync('bun', [
      'build', '--compile', join(REPO_ROOT, 'scripts', 'madarch.ts'),
      '--asset', join(stage, 'wiki-app'), '--asset', join(stage, 'version'),
      '--target', target, '--outfile', outfile,
    ], { encoding: 'utf8' });
    const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    if (run.status !== 0 || !existsSync(outfile) || statSync(outfile).size === 0) {
      console.error(`the binary could not be built for ${options.os}/${options.arch} (exit ${String(run.status)})${said === '' ? '' : ':\n' + said}`);
      return 1;
    }
    // Smoke: the binary answers its version; the list of a scratch home runs
    // the graph through (a refusal there is the binary onto its own words).
    const smokeHome = mkdtempSync(join(stage, 'home-'));
    const version = spawnSync(outfile, ['version'], { encoding: 'utf8' });
    if (version.status !== 0 || version.stdout.trim() !== `version: ${options.version}`) {
      console.error(`the built binary answered no version (exit ${String(version.status)}): ${version.stdout.trim() || version.stderr.trim()}`);
      return 1;
    }
    const list = spawnSync(outfile, ['list', '--home', smokeHome], { encoding: 'utf8' });
    if (list.status !== 0) {
      console.error(`the built binary could not list a scratch products home (exit ${String(list.status)}): ${list.stderr.trim()}`);
      return 1;
    }
    console.log(`built ${outfile} (version ${options.version}, smoke ok)`);
    return 0;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

process.exitCode = main(process.argv.slice(2));
