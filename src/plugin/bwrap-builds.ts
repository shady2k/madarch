/**
 * The bubblewrap build the sandbox installs (decision 0035, item 9): one
 * version, and for every Linux platform madarch runs on a release URL and the
 * sha256 of the binary. The owner's decision behind the pin is the one
 * PostgreSQL's install carries: "Pin the version and the hash, always."
 *
 * The build is VHSgunzo/bubblewrap-static, bubblewrap 0.11.2 compiled with
 * musl and linked statically, so the sandbox's own supervisor needs nothing
 * from the host beside its kernel: the same reasoning that makes Codex ship
 * its own bwrap and check its hash before every use. The data lives here,
 * apart from the installer, the way `src/adapters/postgres-builds.ts` keeps
 * PostgreSQL's builds apart from its own.
 */
import { join } from 'node:path';
import { madarchHome } from '../product/home.js';

/** The bubblewrap version every build this file pins is. */
export const BWRAP_VERSION = '0.11.2';

/** One platform's build: the target name in the release, the binary's sha256 and its size. */
export interface BwrapBuild {
  /** The platform key, as `process.platform`-`process.arch` spells it. */
  readonly platform: string;
  /** The target name inside the release's file name. */
  readonly target: string;
  /** The sha256 of the binary the release serves. */
  readonly sha256: string;
  /** The binary's size in bytes, for the progress a download shows before its headers arrive. */
  readonly bytes: number;
}

/** Every Linux platform the sandbox runs on, in code-point order of the key. */
const BWRAP_BUILDS: readonly BwrapBuild[] = [
  { platform: 'linux-arm64', target: 'aarch64', sha256: '55c0357ce849511c48040943248721a5465640aec465805d8ee05d328b20680e', bytes: 197_360 },
  { platform: 'linux-x64', target: 'x86_64', sha256: 'f364ba6e2b251c241d50c857781396ceed66e9825fb80057845ba53945ad0d26', bytes: 119_576 },
] as const;

/** The platform key this process asks for: `linux-arm64` on this kind of machine. */
export function bwrapPlatformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

/** The build pinned for a platform key, or undefined when this file pins none for it. */
export function bwrapBuildFor(key: string): BwrapBuild | undefined {
  return BWRAP_BUILDS.find((build) => build.platform === key);
}

/** Where the binary is downloaded from: the release asset named for its target. */
export function bwrapBinaryUrl(build: BwrapBuild): string {
  return `https://github.com/VHSgunzo/bubblewrap-static/releases/download/v${BWRAP_VERSION}/bwrap-${build.target}`;
}

/** The tools root: `MADARCH_TOOLS`, else `<madarch home>/tools`, which is the cache PostgreSQL's install shares. */
function toolsRoot(env: Readonly<Record<string, string | undefined>>): string {
  const named = env['MADARCH_TOOLS']?.trim();
  return named === undefined || named === '' ? join(madarchHome(env), 'tools') : named;
}

/** The folder one installed build lives in: `<tools>/bubblewrap/<version>`. */
export function bwrapInstallFolder(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(toolsRoot(env), 'bubblewrap', BWRAP_VERSION);
}

/** The folder the downloads land in, before they are files of an install. */
export function bwrapDownloadFolder(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(toolsRoot(env), 'bubblewrap', 'downloads');
}
