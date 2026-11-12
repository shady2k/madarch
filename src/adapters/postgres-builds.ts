/**
 * The PostgreSQL server madarch installs and the archive each platform's build
 * comes from (madarch-8bdc.2.5, item 1): one version, and for every platform
 * madarch serves a release URL and the sha256 of the archive. The owner's
 * decision behind the pin: "Pin the version and the hash, always."
 *
 * The data lives here, apart from the code that downloads it, the way
 * `src/fill/acp-probe.ts` keeps the agent adapters' catalogue apart from the
 * installer: a release is one line of this file, and the installer verifies
 * every archive against the line its platform names before anything is
 * unpacked.
 *
 * The build is theseus-rs/postgresql-binaries, the official community build of
 * PostgreSQL for the platforms madarch is installed on. It carries
 * PostgreSQL's own contrib extensions (btree_gist among them) and no pgvector;
 * `src/adapters/sql-vector-index.ts` says what needs that.
 */
import { join } from 'node:path';
import { madarchHome } from '../product/home.js';

/** The version of every build this file pins. */
export const POSTGRES_VERSION = '18.6.1';

/** One platform's build: the release target, the archive's sha256 and its size. */
export interface PostgresBuild {
  /** The platform key, as `process.platform`-`process.arch` spells it. */
  readonly platform: string;
  /** The target name inside the archive's file name. */
  readonly target: string;
  /** The sha256 of the `.tar.gz` archive, as the release's own `.sha256` file states it. */
  readonly sha256: string;
  /** The archive's size in bytes, for the progress a download shows before its headers arrive. */
  readonly bytes: number;
}

/** Every platform madarch installs a server on, in code-point order of the key. */
const POSTGRES_BUILDS: readonly PostgresBuild[] = [
  { platform: 'darwin-arm64', target: 'aarch64-apple-darwin', sha256: '89e91cc80650a43d22c018b95ca356a0c9e15838a1182fed2880bfb5d7d9c9a6', bytes: 88_814_625 },
  { platform: 'darwin-x64', target: 'x86_64-apple-darwin', sha256: '4229812543e19c91864ebdf5d8f78883c5816d51d4cc5d065298260c1f64d37e', bytes: 92_085_423 },
  { platform: 'linux-arm64', target: 'aarch64-unknown-linux-gnu', sha256: '1ab47fa2f06ff70454309ad02e5d89c46488300d43977231481fd6b160b9d556', bytes: 39_898_635 },
  { platform: 'linux-x64', target: 'x86_64-unknown-linux-gnu', sha256: 'e84b02dd8d0ce5879fb697330a789231c8b8f8d958dae3ad4d90fecc710b1315', bytes: 40_484_450 },
  { platform: 'win32-x64', target: 'x86_64-pc-windows-msvc', sha256: '0c0c845626ed77c605d716051c9e8df3368d07fbbd9f61ea39a4c5c0536fde7e', bytes: 48_696_865 },
] as const;

/** The filename carried by the platform's archive, not a PATH lookup. */
export function postgresProgram(program: string, platform: string = process.platform): string {
  return platform.startsWith('win32') ? `${program}.exe` : program;
}

/** The platform key this process asks for: `linux-arm64` on this kind of machine. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

/** The build pinned for a platform key, or undefined when this file pins none for it. */
export function postgresBuildFor(key: string): PostgresBuild | undefined {
  return POSTGRES_BUILDS.find((build) => build.platform === key);
}

/** Every platform this file pins a build for, in code-point order. */
export function pinnedPlatforms(): string[] {
  return POSTGRES_BUILDS.map((build) => build.platform).sort();
}

/** The archive's file name inside the release. */
export function postgresArchiveName(build: PostgresBuild): string {
  return `postgresql-${POSTGRES_VERSION}-${build.target}.tar.gz`;
}

/** Where the archive is downloaded from. */
export function postgresArchiveUrl(build: PostgresBuild): string {
  return `https://github.com/theseus-rs/postgresql-binaries/releases/download/${POSTGRES_VERSION}/${postgresArchiveName(build)}`;
}

/**
 * The folder the server is installed in: `<madarch home>/tools/postgresql/<version>`,
 * one installed build a machine (a home is a machine's, and one version's files
 * are one platform's).
 */
export function postgresInstallFolder(env: Readonly<Record<string, string | undefined>> = process.env): string {
  // A folder a caller names, for a run whose homes are its own (the test preload points this at the account's install, so
  // a child process does not download the server again), and otherwise the home's own.
  const named = env['MADARCH_TOOLS']?.trim();
  return join(named === undefined || named === '' ? join(madarchHome(env), 'tools') : named, 'postgresql', POSTGRES_VERSION);
}

/** The folder the archives are downloaded into and unpacked from, before they are files of an install. */
export function postgresDownloadFolder(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const named = env['MADARCH_TOOLS']?.trim();
  return join(named === undefined || named === '' ? join(madarchHome(env), 'tools') : named, 'postgresql', 'downloads');
}
