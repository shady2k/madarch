import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix } from 'node:path';

export interface EmbeddedNativeAddon {
  name: string;
  arrayBuffer(): ArrayBuffer | Promise<ArrayBuffer>;
}

type DlopenArguments = Parameters<typeof process.dlopen>;
export interface DlopenHost {
  dlopen: typeof process.dlopen;
}

type NativeAddonFs = {
  chmodSync: typeof chmodSync;
  closeSync: typeof closeSync;
  lstatSync(path: string): import('node:fs').Stats;
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  readFileSync(path: string | number): Buffer;
  readdirSync: typeof readdirSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
};

/** Injectable operating-system details for deterministic cache tests. */
export interface NativeAddonRuntime {
  platform?: NodeJS.Platform;
  pid?: number;
  randomUUID?: () => string;
  fs?: Partial<NativeAddonFs>;
}

interface ResolvedNativeAddonRuntime {
  platform: NodeJS.Platform;
  pid: number;
  randomUUID: () => string;
  fs: NativeAddonFs;
}

const defaultFs: NativeAddonFs = { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync };
const expectedPackagePath = '/node_modules/@ladybugdb/core/lbugjs.node';
const pendingByHost = new WeakMap<object, Promise<string | undefined>>();

/** Return the platform's user-owned cache base; the caller appends madarch/native/<hash>. */
export function nativeAddonCacheBase(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  home = homedir(),
): string {
  if (platform === 'win32') return env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  if (env.XDG_CACHE_HOME && posix.isAbsolute(env.XDG_CACHE_HOME)) return env.XDG_CACHE_HOME;
  return platform === 'darwin' ? join(home, 'Library', 'Caches') : join(home, '.cache');
}

function resolveRuntime(runtime: NativeAddonRuntime): ResolvedNativeAddonRuntime {
  return {
    platform: runtime.platform ?? process.platform,
    pid: runtime.pid ?? process.pid,
    randomUUID: runtime.randomUUID ?? randomUUID,
    fs: { ...defaultFs, ...runtime.fs },
  };
}

function ensurePrivateDirectory(path: string, runtime: ResolvedNativeAddonRuntime): void {
  runtime.fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = runtime.fs.lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`native addon cache path is not a real directory: ${path}`);
  }
  // LocalAppData is a per-user Windows directory whose inherited ACL is the
  // user's boundary. POSIX cache subdirectories are explicitly owner-only.
  if (runtime.platform !== 'win32') runtime.fs.chmodSync(path, 0o700);
}

function prepareDirectories(cacheBase: string, hash: string, runtime: ResolvedNativeAddonRuntime): string {
  const madarch = join(cacheBase, 'madarch');
  const native = join(madarch, 'native');
  const destination = join(native, hash);
  ensurePrivateDirectory(madarch, runtime);
  ensurePrivateDirectory(native, runtime);
  ensurePrivateDirectory(destination, runtime);
  return destination;
}

function digestFile(path: string, runtime: ResolvedNativeAddonRuntime): string | undefined {
  try {
    const entry = runtime.fs.lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`native addon cache file is not a regular file: ${path}`);
    }
    return createHash('sha256').update(runtime.fs.readFileSync(path)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function findVerifiedRecoveryAddon(directory: string, hash: string, runtime: ResolvedNativeAddonRuntime): string | undefined {
  for (const filename of runtime.fs.readdirSync(directory)) {
    if (!filename.startsWith('lbugjs.recovered.') || !filename.endsWith('.node')) continue;
    const candidate = join(directory, filename);
    if (digestFile(candidate, runtime) !== hash) continue;
    if (runtime.platform !== 'win32') runtime.fs.chmodSync(candidate, 0o600);
    return candidate;
  }
  return undefined;
}

function placeVerifiedAddon(bytes: Buffer, hash: string, directory: string, runtime: ResolvedNativeAddonRuntime): string {
  const stableDestination = join(directory, 'lbugjs.node');
  const cachedHash = digestFile(stableDestination, runtime);
  if (cachedHash === hash) {
    if (runtime.platform !== 'win32') runtime.fs.chmodSync(stableDestination, 0o600);
    return stableDestination;
  }

  const recovery = findVerifiedRecoveryAddon(directory, hash, runtime);
  if (recovery) return recovery;

  // Recheck after scanning. Another installer may have replaced the corrupt
  // stable entry while this process was inspecting recovery candidates.
  const currentHash = digestFile(stableDestination, runtime);
  if (currentHash === hash) {
    if (runtime.platform !== 'win32') runtime.fs.chmodSync(stableDestination, 0o600);
    return stableDestination;
  }

  // Never remove a corrupt stable entry: another process may have replaced it
  // with verified bytes after our hash check. Repair to a unique path instead.
  const destination = currentHash === undefined
    ? stableDestination
    : join(directory, `lbugjs.recovered.${runtime.pid}.${runtime.randomUUID()}.node`);
  const temporary = join(directory, `.${basename(destination)}.${runtime.pid}.${runtime.randomUUID()}.tmp`);
  let ownsTemporary = false;
  try {
    const descriptor = runtime.fs.openSync(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try {
      runtime.fs.writeFileSync(descriptor, bytes);
    } finally {
      runtime.fs.closeSync(descriptor);
    }
    if (runtime.platform !== 'win32') runtime.fs.chmodSync(temporary, 0o600);
    try {
      runtime.fs.renameSync(temporary, destination);
    } catch (error) {
      // Another process may have atomically installed the same hash first.
      if (digestFile(destination, runtime) !== hash) throw error;
      runtime.fs.rmSync(temporary, { force: true });
    }
    if (digestFile(destination, runtime) !== hash) throw new Error(`native addon cache verification failed: ${destination}`);
    if (runtime.platform !== 'win32') runtime.fs.chmodSync(destination, 0o600);
    return destination;
  } finally {
    // Exclusive creation can fail because a different process already owns
    // this random path. Never delete a file that this call did not create.
    if (ownsTemporary) runtime.fs.rmSync(temporary, { force: true });
  }
}

async function installRedirect(
  assets: readonly EmbeddedNativeAddon[],
  host: DlopenHost,
  cacheBase: string,
  runtime: ResolvedNativeAddonRuntime,
): Promise<string | undefined> {
  const asset = assets.filter((file) => file.name === 'lbugjs.node');
  if (asset.length === 0) return undefined;
  if (asset.length !== 1) throw new Error('the binary must embed exactly one LadybugDB lbugjs.node asset');
  const bytes = Buffer.from(await asset[0]!.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  const directory = prepareDirectories(cacheBase, hash, runtime);
  const addonPath = placeVerifiedAddon(bytes, hash, directory, runtime);
  const original = host.dlopen.bind(host);
  let redirected = false;
  const replacement: typeof process.dlopen = function (module, filename, flags) {
    const normalized = filename.replaceAll('\\', '/').toLowerCase();
    if (normalized.endsWith(expectedPackagePath)) {
      if (redirected) throw new Error('LadybugDB native addon was requested more than once in one process');
      redirected = true;
      if (arguments.length >= 3) return original(module, addonPath, flags);
      return original(module, addonPath);
    }
    if (arguments.length >= 3) return original(module, filename, flags);
    return original(module, filename);
  };
  host.dlopen = replacement;
  return addonPath;
}

/** Extract and redirect the single embedded Ladybug addon before graph code is imported. */
export function installEmbeddedLadybugAddon(
  assets: readonly EmbeddedNativeAddon[] = Bun.embeddedFiles as unknown as readonly EmbeddedNativeAddon[],
  host: DlopenHost = process,
  cacheBase = nativeAddonCacheBase(),
  runtime: NativeAddonRuntime = {},
): Promise<string | undefined> {
  const pending = pendingByHost.get(host);
  if (pending) return pending;
  const installation = installRedirect(assets, host, cacheBase, resolveRuntime(runtime));
  pendingByHost.set(host, installation);
  return installation;
}
