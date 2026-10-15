import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { linuxRuntimeRefusal, missingLinuxOpenSsl3 } from '../src/product/linux-runtime.js';
import { installEmbeddedLadybugAddon, nativeAddonCacheBase, type DlopenHost, type EmbeddedNativeAddon, type NativeAddonRuntime } from '../src/product/native-addon.js';

const scratch = mkdtempSync(join(tmpdir(), 'madarch-clean-install-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(command: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('clean install platform contracts', () => {
  test('Linux OpenSSL detection deterministically reports absent libraries and recognizes fixtures', () => {
    const libraryDir = join(scratch, 'openssl');
    mkdirSync(libraryDir, { recursive: true });
    const search = { directories: [libraryDir], cache: '' };
    expect(missingLinuxOpenSsl3({ LD_LIBRARY_PATH: '' }, search)).toEqual(['libssl.so.3', 'libcrypto.so.3']);
    writeFileSync(join(libraryDir, 'libssl.so.3'), '');
    writeFileSync(join(libraryDir, 'libcrypto.so.3'), '');
    expect(missingLinuxOpenSsl3({ LD_LIBRARY_PATH: '' }, search)).toEqual([]);
    expect(missingLinuxOpenSsl3({ LD_LIBRARY_PATH: '' }, { directories: [], cache: 'libssl.so.3' })).toEqual(['libcrypto.so.3']);
  });

  test('Linux runtime probe recognizes the provided library directory', () => {
    const libraryDir = join(scratch, 'openssl-runtime');
    mkdirSync(libraryDir, { recursive: true });
    writeFileSync(join(libraryDir, 'libssl.so.3'), '');
    writeFileSync(join(libraryDir, 'libcrypto.so.3'), '');
    expect(missingLinuxOpenSsl3({ LD_LIBRARY_PATH: libraryDir })).toEqual([]);
  });

  test('the runtime refusal is limited to Linux and names missing libraries', () => {
    expect(linuxRuntimeRefusal('darwin', ['libssl.so.3'])).toBeUndefined();
    expect(linuxRuntimeRefusal('linux', [])).toBeUndefined();
    expect(linuxRuntimeRefusal('linux', ['libssl.so.3'])).toContain('libssl.so.3');
  });

  test('Windows x64 package uses the exe artifact and wrapper selects the Windows package', () => {
    const bin = join(scratch, 'madarch-windows-x64.exe');
    const out = join(scratch, 'packages-windows');
    writeFileSync(bin, 'fixture binary', { mode: 0o600 });
    const made = run('bun', ['scripts/build-npm-package.ts', '--version', '1.2.3', '--os', 'win32', '--arch', 'x64', '--packages-dir', out, '--binary', bin]);
    expect(made.status).toBe(0);
    if (process.platform !== 'win32') expect(statSync(join(out, '@madarch-win32-x64', 'bin', 'madarch.exe')).mode & 0o777).toBe(0o600);
    const platform = JSON.parse(readFileSync(join(out, '@madarch-win32-x64', 'package.json'), 'utf8')) as { name: string; main: string; os: string[]; cpu: string[] };
    expect(platform).toMatchObject({ name: '@madarch/win32-x64', main: 'bin/madarch.exe', os: ['win32'], cpu: ['x64'] });

    const wrapped = run('bun', ['scripts/build-npm-package.ts', '--version', '1.2.3', '--wrapper', '--packages-dir', out]);
    expect(wrapped.status).toBe(0);
    const wrapper = readFileSync(join(out, 'madarch', 'bin', 'madarch.js'), 'utf8');
    const wrapperPackage = JSON.parse(readFileSync(join(out, 'madarch', 'package.json'), 'utf8')) as { optionalDependencies: Record<string, string> };
    expect(wrapper).toContain("win32: 'win32'");
    expect(wrapper).toContain('Windows arm64');
    expect(wrapperPackage.optionalDependencies['@madarch/win32-x64']).toBe('1.2.3');
  });

  test('embedded Ladybug addon is extracted only when present and redirects only its exact package path', async () => {
    const cacheBase = join(scratch, 'addon-redirect-cache');
    const seen: { filename: string; flags: number | undefined; argc: number }[] = [];
    const host: DlopenHost = { dlopen: function (_module, filename, flags) {
      seen.push({ filename, flags, argc: arguments.length });
    } as typeof process.dlopen };
    const bytes = Buffer.from('fake-native-addon');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    const unrelated: EmbeddedNativeAddon = { name: 'unrelated.node', arrayBuffer: async () => Uint8Array.from(Buffer.from('other-addon')).buffer as ArrayBuffer };
    const withoutAssetHost: DlopenHost = { dlopen: host.dlopen };
    expect(await installEmbeddedLadybugAddon([], withoutAssetHost, cacheBase)).toBeUndefined();
    expect(existsSync(join(cacheBase, 'madarch', 'native'))).toBe(false);
    const unrelatedHost: DlopenHost = { dlopen: host.dlopen };
    expect(await installEmbeddedLadybugAddon([unrelated], unrelatedHost, cacheBase)).toBeUndefined();
    const expectedPath = join(cacheBase, 'madarch', 'native', hash, 'lbugjs.node');
    expect(await installEmbeddedLadybugAddon([unrelated, asset], host, cacheBase)).toBe(expectedPath);
    const duplicateHost: DlopenHost = { dlopen: host.dlopen };
    await expect(installEmbeddedLadybugAddon([asset, asset], duplicateHost, cacheBase)).rejects.toThrow('the binary must embed exactly one LadybugDB lbugjs.node asset');

    const module = {} as Parameters<typeof process.dlopen>[0];
    host.dlopen(module, 'C:\\build\\node_modules\\@ladybugdb\\core\\lbugjs.node', 257);
    host.dlopen(module, 'C:/build/node_modules/@other/core/addon.node');
    host.dlopen(module, 'C:/build/node_modules/@other/core/lbugjs.node', 5);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ filename: expectedPath, flags: 257, argc: 3 });
    expect(seen[1]).toMatchObject({ filename: 'C:/build/node_modules/@other/core/addon.node', argc: 2 });
    expect(seen[2]).toMatchObject({ filename: 'C:/build/node_modules/@other/core/lbugjs.node', flags: 5, argc: 3 });
    expect(() => host.dlopen(module, 'C:/build/node_modules/@ladybugdb/core/lbugjs.node', 257)).toThrow('LadybugDB native addon was requested more than once in one process');

    const noFlagsSeen: number[] = [];
    const noFlagsHost: DlopenHost = { dlopen: function () { noFlagsSeen.push(arguments.length); } as typeof process.dlopen };
    await installEmbeddedLadybugAddon([asset], noFlagsHost, cacheBase);
    noFlagsHost.dlopen(module, 'C:/build/node_modules/@ladybugdb/core/lbugjs.node');
    expect(noFlagsSeen).toEqual([2]);
  });

  test('same-host addon setup shares one pending extraction promise', async () => {
    const cacheBase = join(scratch, 'addon-same-host-cache');
    let reads = 0;
    const bytes = Buffer.from('same-host-addon');
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => { reads += 1; return Uint8Array.from(bytes).buffer as ArrayBuffer; } };
    const host: DlopenHost = { dlopen: (() => undefined) as typeof process.dlopen };
    const first = installEmbeddedLadybugAddon([asset], host, cacheBase);
    const second = installEmbeddedLadybugAddon([asset], host, cacheBase);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(reads).toBe(1);
  });

  test('relative and empty XDG cache values use platform defaults', () => {
    const linuxHome = '/home/test';
    const macHome = '/Users/test';
    expect(nativeAddonCacheBase({ XDG_CACHE_HOME: 'cache' }, 'linux', linuxHome)).toBe(join(linuxHome, '.cache'));
    expect(nativeAddonCacheBase({ XDG_CACHE_HOME: 'cache' }, 'darwin', macHome)).toBe(join(macHome, 'Library', 'Caches'));
    expect(nativeAddonCacheBase({ XDG_CACHE_HOME: '' }, 'linux', linuxHome)).toBe(join(linuxHome, '.cache'));
    expect(nativeAddonCacheBase({ XDG_CACHE_HOME: '' }, 'darwin', macHome)).toBe(join(macHome, 'Library', 'Caches'));
  });

  test('embedded addon cache repairs corrupt content and is safe for concurrent extraction', async () => {
    const cacheBase = join(scratch, 'addon-concurrent-cache');
    const bytes = Buffer.from('same-addon-bytes');
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    const host = (): DlopenHost => ({ dlopen: (() => undefined) as typeof process.dlopen });
    const [first, second] = await Promise.all([
      installEmbeddedLadybugAddon([asset], host(), cacheBase),
      installEmbeddedLadybugAddon([asset], host(), cacheBase),
    ]);
    expect(first).toBe(second);
    expect(readFileSync(first!)).toEqual(bytes);
    writeFileSync(first!, 'corrupt');
    const repaired = await installEmbeddedLadybugAddon([asset], host(), cacheBase);
    expect(repaired).not.toBe(first);
    expect(readFileSync(first!)).toEqual(Buffer.from('corrupt'));
    expect(readFileSync(repaired!)).toEqual(bytes);
    if (process.platform !== 'win32') {
      chmodSync(repaired!, 0o644);
      let cacheHitOpens = 0;
      const cacheHitRuntime: NativeAddonRuntime = {
        fs: {
          openSync(path, flags, mode) {
            cacheHitOpens += 1;
            return openSync(path, flags, mode);
          },
        },
      };
      const reused = await installEmbeddedLadybugAddon([asset], host(), cacheBase, cacheHitRuntime);
      expect(reused).toBe(repaired);
      expect(cacheHitOpens).toBe(0);
      expect(statSync(repaired!).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(repaired!)).mode & 0o777).toBe(0o700);
      expect(statSync(dirname(dirname(repaired!))).mode & 0o777).toBe(0o700);
      expect(statSync(dirname(dirname(dirname(repaired!)))).mode & 0o777).toBe(0o700);
    }
    const home = '/home/test';
    expect(nativeAddonCacheBase({ LOCALAPPDATA: 'C:/Users/test/AppData/Local' }, 'win32', 'C:/Users/test')).toBe('C:/Users/test/AppData/Local');
    expect(nativeAddonCacheBase({}, 'win32', 'C:/Users/test')).toBe(join('C:/Users/test', 'AppData', 'Local'));
    expect(nativeAddonCacheBase({ XDG_CACHE_HOME: '/custom/cache' }, 'linux', home)).toBe('/custom/cache');
    expect(nativeAddonCacheBase({ XDG_CACHE_HOME: '/custom/cache' }, 'darwin', '/Users/test')).toBe('/custom/cache');
    expect(nativeAddonCacheBase({}, 'darwin', '/Users/test')).toBe(join('/Users/test', 'Library', 'Caches'));
    expect(nativeAddonCacheBase({}, 'linux', home)).toBe(join(home, '.cache'));
  });

  test('addon cache guards a non-directory result from a directory metadata race', async () => {
    const bytes = Buffer.from('directory-race-addon');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cacheBase = join(scratch, 'addon-directory-race-cache');
    const directory = join(cacheBase, 'madarch', 'native', hash);
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    const runtime: NativeAddonRuntime = {
      fs: {
        lstatSync(path) {
          const entry = lstatSync(path);
          if (String(path) !== directory) return entry;
          return new Proxy(entry, {
            get(target, property, receiver) {
              if (property === 'isDirectory') return () => false;
              if (property === 'isSymbolicLink') return () => false;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      },
    };
    await expect(installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase, runtime))
      .rejects.toThrow(`native addon cache path is not a real directory: ${directory}`);
  });

  test('corrupt-cache repair preserves a verified replacement before removing anything', async () => {
    const bytes = Buffer.from('concurrent-cache-winner-addon');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cacheBase = join(scratch, 'addon-corrupt-winner-race-cache');
    const directory = join(cacheBase, 'madarch', 'native', hash);
    const destination = join(directory, 'lbugjs.node');
    const corrupt = Buffer.from('corrupt before another installer wins');
    mkdirSync(directory, { recursive: true });
    writeFileSync(destination, corrupt);
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    let winnerInstalled = false;
    let validWinnerRemovalAttempted = false;
    const runtime: NativeAddonRuntime = {
      fs: {
        readFileSync(path) {
          const read = readFileSync(path);
          if (String(path) === destination && !winnerInstalled) {
            writeFileSync(destination, bytes);
            winnerInstalled = true;
          }
          return read;
        },
        rmSync(path, options) {
          if (String(path) === destination && readFileSync(destination).equals(bytes)) validWinnerRemovalAttempted = true;
          return rmSync(path, options);
        },
      },
    };
    const host = (): DlopenHost => ({ dlopen: (() => undefined) as typeof process.dlopen });
    const [first, second] = await Promise.all([
      installEmbeddedLadybugAddon([asset], host(), cacheBase, runtime),
      installEmbeddedLadybugAddon([asset], host(), cacheBase, runtime),
    ]);
    expect(winnerInstalled).toBe(true);
    expect(validWinnerRemovalAttempted).toBe(false);
    expect(first).toBe(destination);
    expect(second).toBe(destination);
    expect(readFileSync(destination)).toEqual(bytes);
    expect(readFileSync(first!)).toEqual(bytes);
    expect(readFileSync(second!)).toEqual(bytes);
  });

  test('simulated Windows skips chmod and reuses verified recovery files', async () => {
    const bytes = Buffer.from('simulated-windows-addon');
    const cacheBase = join(scratch, 'addon-simulated-windows-cache');
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    let chmodCalls = 0;
    let openCalls = 0;
    let renameCalls = 0;
    const runtime: NativeAddonRuntime = {
      platform: 'win32',
      fs: {
        chmodSync(path, mode) {
          chmodCalls += 1;
          return chmodSync(path, mode);
        },
        openSync(path, flags, mode) {
          openCalls += 1;
          return openSync(path, flags, mode);
        },
        renameSync(source, destination) {
          renameCalls += 1;
          if (existsSync(destination)) {
            throw Object.assign(new Error('Windows rename cannot replace an existing destination'), { code: 'EEXIST' });
          }
          return renameSync(source, destination);
        },
      },
    };
    const first = await installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase, runtime);
    expect(chmodCalls).toBe(0);
    writeFileSync(first!, 'corrupt');
    const repaired = await installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase, runtime);
    expect(repaired).not.toBe(first);
    expect(readFileSync(first!)).toEqual(Buffer.from('corrupt'));
    expect(readFileSync(repaired!)).toEqual(bytes);
    expect(chmodCalls).toBe(0);
    const opensBeforeHit = openCalls;
    const renamesBeforeHit = renameCalls;
    const hit = await installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase, runtime);
    expect(hit).toBe(repaired);
    expect(openCalls).toBe(opensBeforeHit);
    expect(renameCalls).toBe(renamesBeforeHit);
    expect(chmodCalls).toBe(0);
  });

  test('exclusive temporary creation does not overwrite or remove another cache writer file', async () => {
    const bytes = Buffer.from('exclusive-temp-addon');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cacheBase = join(scratch, 'addon-temp-collision-cache');
    const directory = join(cacheBase, 'madarch', 'native', hash);
    const pid = 81923;
    const uuid = 'fixed-collision-name';
    const temporary = join(directory, `.lbugjs.node.${pid}.${uuid}.tmp`);
    mkdirSync(directory, { recursive: true });
    const sentinel = Buffer.from('owned by another writer');
    writeFileSync(temporary, sentinel);
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    const runtime: NativeAddonRuntime = { pid, randomUUID: () => uuid };
    await expect(installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase, runtime))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(temporary)).toEqual(sentinel);
  });

  test('POSIX temporary addon is owner-readable before verification under a restrictive umask', async () => {
    if (process.platform === 'win32') return;
    const bytes = Buffer.from('restrictive-umask-addon');
    const cacheBase = join(scratch, 'addon-restrictive-umask-cache');
    const verificationModes: number[] = [];
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    const runtime: NativeAddonRuntime = {
      fs: {
        lstatSync(path) {
          const entry = lstatSync(path);
          if (String(path).endsWith('/lbugjs.node')) verificationModes.push(entry.mode & 0o777);
          return entry;
        },
      },
    };
    mkdirSync(cacheBase, { recursive: true, mode: 0o700 });
    chmodSync(cacheBase, 0o700);
    const previousUmask = process.umask(0o777);
    let installed: string | undefined;
    try {
      installed = await installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase, runtime);
    } finally {
      process.umask(previousUmask);
    }
    expect(verificationModes).toEqual([0o600]);
    expect(readFileSync(installed!)).toEqual(bytes);
    expect(statSync(installed!).mode & 0o777).toBe(0o600);
  });

  test('rename-race recovery accepts a matching concurrent winner when its temp path is already gone', async () => {
    const bytes = Buffer.from('rename-race-winner-addon');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cacheBase = join(scratch, 'addon-rename-winner-cache');
    const pid = 81924;
    const uuid = 'matching-winner';
    const directory = join(cacheBase, 'madarch', 'native', hash);
    const temporary = join(directory, `.lbugjs.node.${pid}.${uuid}.tmp`);
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    let chmodCalls = 0;
    const runtime: NativeAddonRuntime = {
      platform: 'win32',
      pid,
      randomUUID: () => uuid,
      fs: {
        chmodSync(path, mode) {
          chmodCalls += 1;
          return chmodSync(path, mode);
        },
        renameSync(source, destination) {
          renameSync(source, destination);
          throw Object.assign(new Error('simulated lost rename response'), { code: 'EEXIST' });
        },
      },
    };
    const installed = await installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase, runtime);
    expect(readFileSync(installed!)).toEqual(bytes);
    expect(existsSync(temporary)).toBe(false);
    expect(chmodCalls).toBe(0);
  });

  test('rename failure with no matching destination preserves the error and cleans the owned temp', async () => {
    const bytes = Buffer.from('rename-failure-addon');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cacheBase = join(scratch, 'addon-rename-failure-cache');
    const pid = 81925;
    const uuid = 'failed-rename';
    const directory = join(cacheBase, 'madarch', 'native', hash);
    const temporary = join(directory, `.lbugjs.node.${pid}.${uuid}.tmp`);
    const renameError = Object.assign(new Error('simulated rename failure'), { code: 'EACCES' });
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    const runtime: NativeAddonRuntime = {
      pid,
      randomUUID: () => uuid,
      fs: { renameSync() { throw renameError; } },
    };
    await expect(installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase, runtime))
      .rejects.toBe(renameError);
    expect(existsSync(temporary)).toBe(false);
  });

  test('post-rename hash verification rejects changed bytes with its diagnostic', async () => {
    const bytes = Buffer.from('post-rename-verification-addon');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cacheBase = join(scratch, 'addon-post-write-verification-cache');
    const destination = join(cacheBase, 'madarch', 'native', hash, 'lbugjs.node');
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    const runtime: NativeAddonRuntime = {
      fs: {
        renameSync(source, target) {
          renameSync(source, target);
          writeFileSync(target, 'post-write corruption');
        },
      },
    };
    await expect(installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase, runtime))
      .rejects.toThrow(`native addon cache verification failed: ${destination}`);
  });

  test('final POSIX chmod restores owner-only mode after a rename-side mode change', async () => {
    if (process.platform === 'win32') return;
    const bytes = Buffer.from('final-mode-addon');
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    const runtime: NativeAddonRuntime = {
      fs: {
        renameSync(source, destination) {
          renameSync(source, destination);
          chmodSync(destination, 0o644);
        },
      },
    };
    const installed = await installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, join(scratch, 'addon-final-mode-cache'), runtime);
    expect(statSync(installed!).mode & 0o777).toBe(0o600);
  });

  test('addon cache rejects symlinked directories and non-regular cached files', async () => {
    if (process.platform === 'win32') return;
    const bytes = Buffer.from('guard-addon');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };

    const linkedDirectoryBase = join(scratch, 'addon-linked-directory-cache');
    const linkedDirectoryParent = join(linkedDirectoryBase, 'madarch', 'native');
    const outsideDirectory = join(scratch, 'addon-cache-outside');
    mkdirSync(linkedDirectoryParent, { recursive: true });
    mkdirSync(outsideDirectory, { recursive: true });
    symlinkSync(outsideDirectory, join(linkedDirectoryParent, hash), 'dir');
    await expect(installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, linkedDirectoryBase))
      .rejects.toThrow('native addon cache path is not a real directory:');
    expect(existsSync(join(outsideDirectory, 'lbugjs.node'))).toBe(false);

    const linkedFileBase = join(scratch, 'addon-linked-file-cache');
    const linkedFileDirectory = join(linkedFileBase, 'madarch', 'native', hash);
    mkdirSync(linkedFileDirectory, { recursive: true });
    const targetFile = join(scratch, 'addon-cache-target.node');
    writeFileSync(targetFile, bytes);
    symlinkSync(targetFile, join(linkedFileDirectory, 'lbugjs.node'), 'file');
    await expect(installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, linkedFileBase))
      .rejects.toThrow('native addon cache file is not a regular file:');

    const directoryFileBase = join(scratch, 'addon-directory-file-cache');
    const directoryFilePath = join(directoryFileBase, 'madarch', 'native', hash, 'lbugjs.node');
    mkdirSync(directoryFilePath, { recursive: true });
    await expect(installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, directoryFileBase))
      .rejects.toThrow('native addon cache file is not a regular file:');
  });

  test('existing POSIX addon cache directories are reset to owner-only mode', async () => {
    if (process.platform === 'win32') return;
    const bytes = Buffer.from('mode-addon');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cacheBase = join(scratch, 'addon-existing-mode-cache');
    const madarch = join(cacheBase, 'madarch');
    const native = join(madarch, 'native');
    const destination = join(native, hash);
    mkdirSync(destination, { recursive: true });
    for (const directory of [madarch, native, destination]) chmodSync(directory, 0o755);
    const asset: EmbeddedNativeAddon = { name: 'lbugjs.node', arrayBuffer: async () => Uint8Array.from(bytes).buffer as ArrayBuffer };
    await installEmbeddedLadybugAddon([asset], { dlopen: (() => undefined) as typeof process.dlopen }, cacheBase);
    for (const directory of [madarch, native, destination]) expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  test('Unix npm package restores executable mode when the downloaded artifact lacks it', () => {
    if (process.platform === 'win32') return;
    const binary = join(scratch, 'non-executable-linux-binary');
    const packages = join(scratch, 'packages-unix-mode');
    writeFileSync(binary, 'fixture binary', { mode: 0o600 });
    const built = run('bun', ['scripts/build-npm-package.ts', '--version', '1.2.3', '--os', 'linux', '--arch', 'x64', '--packages-dir', packages, '--binary', binary]);
    expect(built.status).toBe(0);
    expect(statSync(join(packages, '@madarch-linux-x64', 'bin', 'madarch')).mode & 0o777).toBe(0o755);
  });

  test('Windows arm64 is refused by name in both binary and npm package builders', () => {
    const binary = run('bun', ['scripts/build-binary.ts', '--version', '1.2.3', '--os', 'windows', '--arch', 'arm64']);
    expect(binary.status).toBe(2);
    expect(binary.stderr).toContain('Windows arm64');
    const pkg = run('bun', ['scripts/build-npm-package.ts', '--version', '1.2.3', '--os', 'win32', '--arch', 'arm64', '--packages-dir', join(scratch, 'unsupported')]);
    expect(pkg.status).toBe(2);
    expect(pkg.stderr).toContain('Windows arm64');
  });

  test('branch clean-install walks cover macOS and Windows without publishing', () => {
    const workflow = readFileSync('.github/workflows/clean-installs.yml', 'utf8');
    expect(workflow).toContain("branches: ['**']");
    expect(workflow).toContain('runs-on: macos-14');
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('npx new then serve on macOS arm64');
    expect(workflow).toContain('npx new then serve on Windows x64');
    expect(workflow).toContain('build-macos-fixture:');
    expect(workflow).toContain('build-windows-fixture:');
    expect(workflow).toContain('Probe LadybugDB from its installed Windows npm package');
    expect(workflow).toContain('DIRECT_PACKAGE_GRAPH_EXIT=$directStatus');
    expect(workflow).toContain('Compile binary and run its embedded-addon graph smoke');
    expect(workflow).toContain('continue-on-error: true');
    expect(workflow).toContain('windows-addon-diagnosis:');
    expect(workflow).toContain('DIRECT_PACKAGE_GRAPH_EXIT=$directStatus');
    expect(workflow).toContain('EMBEDDED_BINARY_GRAPH_EXIT=$binaryStatus');
    expect(workflow).toContain('BUN_PACKAGE_GRAPH_EXIT=$bunStatus');
    expect(workflow).toContain('GIT_AUTHOR_EMAIL: windows-diagnosis@example.invalid');
    expect(workflow).toContain('EMBEDDED_EXTRACTED_ADDON_SHA256=');
    expect(workflow).toContain('Report embedded-addon build smoke failure');
    expect(workflow).toContain('always() && needs.build-windows-fixture.result != \'cancelled\'');
    expect(workflow.match(/assert clean runner has no checkout dependencies/g)).toHaveLength(3);
    expect(workflow).toContain('install script refuses before download without OpenSSL 3');
    expect(workflow).toContain('ubuntu:20.04');
    expect(workflow).toContain('chmod +x /tmp/madarch');
    expect(workflow).not.toContain('runs-on: ubuntu-20.04');
    expect(readFileSync('.github/workflows/release.yml', 'utf8')).toContain('$($env:VERSION.Substring(1))');
    expect(workflow).not.toContain('gh release create');
    expect(workflow).not.toContain('npm publish');
    expect(workflow).not.toContain('publish-homebrew-tap.sh');
    const homebrewWalk = readFileSync('scripts/clean-homebrew-walk.sh', 'utf8');
    expect(homebrewWalk).toContain('brew tap-new --no-git "$TAP"');
    expect(homebrewWalk).toContain('brew install "$TAP/madarch"');
    expect(homebrewWalk).toContain('BREW_BIN="$(brew --prefix)/bin/madarch"');
    expect(homebrewWalk).toContain('[ -x "$BREW_BIN" ]');
    expect(homebrewWalk).toContain('brew untap --force "$TAP"');
    expect(homebrewWalk).not.toContain('brew install --formula "$FORMULA"');
  });

  test('release tap step fails by secret name without attempting publication', () => {
    const missing = run('sh', ['scripts/publish-homebrew-tap.sh', join(scratch, 'no-formula.rb'), '1.2.3'], { HOMEBREW_TAP_TOKEN: '' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('HOMEBREW_TAP_TOKEN');
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(workflow).toContain('name: Require HOMEBREW_TAP_TOKEN');
    expect(workflow).toContain('sh scripts/publish-homebrew-tap.sh');
    expect(workflow).not.toContain('npm publish');
    const formula = readFileSync('Formula/madarch.rb', 'utf8');
    expect(formula).toContain('brew install shady2k/tap/madarch');
    expect(formula).toContain('ARTIFACT = if OS.mac?');
    expect(formula).toContain('libexec.install ARTIFACT => \"madarch\"');
    expect(formula).toContain('bin.write_exec_script libexec / \"madarch\"');
    expect(formula).toContain('(bin / \"madarch\").write_env_script libexec / \"madarch\"');
    expect(formula).not.toContain('@artifact');
    expect(formula).toContain('(libexec / \"madarch\").chmod 0755');
    expect(readFileSync('README.md', 'utf8')).toContain('brew install shady2k/tap/madarch');
    expect(readFileSync('scripts/install.sh', 'utf8')).toContain('brew install shady2k/tap/madarch');
  });
});
