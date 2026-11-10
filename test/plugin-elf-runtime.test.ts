/**
 * What a runtime's own ELF says the sandbox must bind (decision 0035, item 9): the interpreter `PT_INTERP` names, the
 * libraries `DT_NEEDED` names resolved through `DT_RUNPATH`/`DT_RPATH`, and, for nix-ld's shim, the loader and folders
 * `NIX_LD`/`NIX_LD_LIBRARY_PATH` name. The test builds the ELF files it reads, so the interpreter and the libraries
 * stand outside `/lib` and the assertion is that their own folders are bound.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readElfDynamic, runtimeSandbox } from '../src/plugin/elf-runtime.js';
import { bwrapArguments, type SandboxSpec } from '../src/plugin/sandbox.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** One scratch folder. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'madarch-elf-runtime-'));
  roots.push(root);
  return root;
}

/** A little-endian ELF64 file stating one interpreter, its needed libraries and its search paths. */
function elf64(options: { interpreter?: string; needed?: readonly string[]; runpath?: readonly string[]; rpath?: readonly string[] } = {}): Buffer {
  const needed = options.needed ?? [];
  const runpath = (options.runpath ?? []).join(':');
  const rpath = (options.rpath ?? []).join(':');
  // The string table: every name and every search path, each NUL-terminated; an index is a string's offset in it.
  const strings: string[] = [];
  let strtab = Buffer.alloc(0);
  const intern = (text: string): number => {
    if (text === '') return 0;
    const at = strtab.length;
    strtab = Buffer.concat([strtab, Buffer.from(`${text}\0`, 'utf8')]);
    return at;
  };
  for (const name of needed) strings.push(String(intern(name)));
  const runpathAt = intern(runpath);
  const rpathAt = intern(rpath);
  const interp = options.interpreter === undefined ? undefined : `${options.interpreter}\0`;
  const interpAt = 0x200;
  const strtabAt = 0x300;
  const dynamicAt = 0x400;
  const phoff = 0x40;
  const phentsize = 56;
  const phnum = interp === undefined ? 2 : 3;
  const fileSize = dynamicAt + (needed.length + 6) * 16 + 64;
  const buf = Buffer.alloc(fileSize);
  // The ELF header: EI_MAG, class 2 (64-bit), data 1 (little-endian), version 1.
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; buf[4] = 2; buf[5] = 1; buf[6] = 1;
  buf.writeUInt16LE(2, 0x10); // e_type = ET_EXEC
  buf.writeUInt16LE(0x3e, 0x12); // e_machine (x86-64; the reader does not judge it)
  buf.writeUInt32LE(1, 0x14); // e_version
  buf.writeBigUInt64LE(BigInt(phoff), 0x20); // e_phoff
  buf.writeUInt16LE(64, 0x34); // e_ehsize
  buf.writeUInt16LE(phentsize, 0x36); // e_phentsize
  buf.writeUInt16LE(phnum, 0x38); // e_phnum
  let ph = phoff;
  const programHeader = (type: number, offset: number, vaddr: number, filesz: number): void => {
    buf.writeUInt32LE(type, ph); buf.writeUInt32LE(5, ph + 4);
    buf.writeBigUInt64LE(BigInt(offset), ph + 8); buf.writeBigUInt64LE(BigInt(vaddr), ph + 16);
    buf.writeBigUInt64LE(BigInt(offset), ph + 24); buf.writeBigUInt64LE(BigInt(filesz), ph + 32);
    buf.writeBigUInt64LE(BigInt(filesz), ph + 40); buf.writeBigUInt64LE(1n, ph + 48);
    ph += phentsize;
  };
  provider: {
    // PT_LOAD covers the whole file at address 0, so every virtual address is its own file offset.
    programHeader(1, 0, 0, fileSize);
    if (interp !== undefined) programHeader(3, interpAt, interpAt, interp.length);
    programHeader(2, dynamicAt, dynamicAt, (needed.length + 6) * 16);
  }
  if (interp !== undefined) buf.write(interp, interpAt, 'utf8');
  strtab.copy(buf, strtabAt);
  let at = dynamicAt;
  const entry = (tag: number, value: number): void => { buf.writeBigInt64LE(BigInt(tag), at); buf.writeBigUInt64LE(BigInt(value), at + 8); at += 16; };
  for (const index of strings) entry(1, Number(index)); // DT_NEEDED
  if (runpath !== '') entry(29, runpathAt); // DT_RUNPATH
  if (rpath !== '' && runpath === '') entry(15, rpathAt); // DT_RPATH
  entry(5, strtabAt); // DT_STRTAB
  entry(10, strtab.length); // DT_STRSZ
  entry(0, 0); // DT_NULL
  return buf;
}

/** One sandbox spec whose only interesting field is the runtime. */
function spec(runtime: string): SandboxSpec {
  return { closureFolder: join(tmpdir(), 'closure'), workFolder: join(tmpdir(), 'work'), runtime, entry: 'main.ts', limits: { memoryBytes: 1, cpuQuotaMicros: 1, cpuPeriodMicros: 1, pids: 1 } };
}

/** The argument list for a runtime, with a runtime resolved from the given environment. */
function args(specification: SandboxSpec, env: Record<string, string | undefined> = {}): string[] {
  return bwrapArguments({ ...specification, env }, { bwrap: 'bwrap', seccompFile: 'seccomp.bpf', syncFd: 3, seccompFd: 4, rootUid: undefined });
}

describe('a runtime outside /lib', () => {
  test('the interpreter its ELF names, its real file and its libraries are bound, wherever they stand', () => {
    const root = scratch();
    const loaderFolder = join(root, 'loader');
    const realLoaderFolder = join(root, 'real-loader');
    const libraryFolder = join(root, 'libs');
    mkdirSync(loaderFolder, { recursive: true });
    mkdirSync(realLoaderFolder, { recursive: true });
    mkdirSync(libraryFolder, { recursive: true });
    writeFileSync(join(realLoaderFolder, 'ld-madarch.so'), elf64());
    symlinkSync(join(realLoaderFolder, 'ld-madarch.so'), join(loaderFolder, 'ld-madarch.so'));
    const runtime = join(root, 'runtime');
    writeFileSync(runtime, elf64({ interpreter: join(loaderFolder, 'ld-madarch.so'), needed: ['libgreet.so.1'], runpath: [libraryFolder] }));
    writeFileSync(join(libraryFolder, 'libgreet.so.1'), elf64());

    const read = readElfDynamic(runtime);
    expect(read.interpreter).toBe(join(loaderFolder, 'ld-madarch.so'));
    expect(read.needed).toEqual(['libgreet.so.1']);
    expect(read.runpath).toEqual([libraryFolder]);

    const resolved = RuntimeOf(runtime);
    expect(resolved.mounts).toContain(loaderFolder);
    expect(resolved.mounts).toContain(realLoaderFolder);
    expect(resolved.mounts).toContain(libraryFolder);
    expect(resolved.problems).toEqual([]);
    const list = args(spec(runtime));
    for (const folder of [loaderFolder, realLoaderFolder, libraryFolder]) {
      const at = list.indexOf(folder);
      expect(at).toBeGreaterThan(0);
      expect(list[at - 1]).toBe('--ro-bind');
      expect(list[at + 1]).toBe(folder);
    }
  });

  test('a runtime whose interpreter does not stand is refused, naming it', () => {
    const root = scratch();
    const runtime = join(root, 'runtime');
    writeFileSync(runtime, elf64({ interpreter: join(root, 'gone', 'ld-madarch.so') }));
    const resolved = RuntimeOf(runtime);
    expect(resolved.refusal).toContain('names the interpreter');
    expect(resolved.refusal).toContain(join(root, 'gone', 'ld-madarch.so'));
    expect(() => args(spec(runtime))).not.toThrow();
  });

  test('a file that is no ELF is refused, naming the file', () => {
    const root = scratch();
    const runtime = join(root, 'runtime');
    writeFileSync(runtime, '# not an ELF\n');
    const resolved = RuntimeOf(runtime);
    expect(resolved.refusal).toContain('is no ELF file');
    expect(resolved.refusal).toContain(runtime);
  });
});

describe('a runtime run by nix-ld s shim', () => {
  test('NIX_LD and NIX_LD_LIBRARY_PATH are carried in, and what they point at is bound', () => {
    const root = scratch();
    const shimFolder = join(root, 'lib64');
    const shimRealFolder = join(root, 'nix-ld-rs-1', 'lib');
    const glibcFolder = join(root, 'glibc', 'lib');
    const moreFolder = join(root, 'more');
    for (const folder of [shimFolder, shimRealFolder, glibcFolder, moreFolder]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(shimRealFolder, 'libnix-ld.so'), elf64());
    symlinkSync(join(shimRealFolder, 'libnix-ld.so'), join(shimFolder, 'ld-linux-x86-64.so.2'));
    writeFileSync(join(glibcFolder, 'ld-linux-x86-64.so.2'), elf64());
    const runtime = join(root, 'runtime');
    writeFileSync(runtime, elf64({ interpreter: join(shimFolder, 'ld-linux-x86-64.so.2') }));
    const env = { NIX_LD: join(glibcFolder, 'ld-linux-x86-64.so.2'), NIX_LD_LIBRARY_PATH: `${glibcFolder}:${moreFolder}` };

    const resolved = runtimeSandbox(runtime, env);
    expect(resolved.nixLd).toBe(true);
    expect(resolved.environment['NIX_LD']).toBe(env.NIX_LD);
    expect(resolved.environment['NIX_LD_LIBRARY_PATH']).toBe(env.NIX_LD_LIBRARY_PATH);
    for (const folder of [shimFolder, shimRealFolder, glibcFolder, moreFolder]) expect(resolved.mounts).toContain(folder);
    const list = args(spec(runtime), env);
    const nix = list.indexOf('NIX_LD');
    expect(nix).toBeGreaterThan(0);
    expect(list[nix - 1]).toBe('--setenv');
    expect(list[nix + 1]).toBe(env.NIX_LD);
    expect(list[list.indexOf('NIX_LD_LIBRARY_PATH') + 1]).toBe(env.NIX_LD_LIBRARY_PATH);
  });

  test('a shim with no NIX_LD on the host is refused, naming the variable', () => {
    const root = scratch();
    const shimFolder = join(root, 'lib64');
    mkdirSync(shimFolder, { recursive: true });
    writeFileSync(join(shimFolder, 'libnix-ld.so'), elf64());
    symlinkSync(join(shimFolder, 'libnix-ld.so'), join(shimFolder, 'ld-linux-x86-64.so.2'));
    const runtime = join(root, 'runtime');
    writeFileSync(runtime, elf64({ interpreter: join(shimFolder, 'ld-linux-x86-64.so.2') }));
    const resolved = runtimeSandbox(runtime, {});
    expect(resolved.nixLd).toBe(true);
    expect(resolved.refusal).toContain('NIX_LD');
  });
});

/** The runtime resolution for one file, with an empty environment. */
function RuntimeOf(runtime: string) {
  return runtimeSandbox(runtime, {});
}

describe('nix-ld s folder of symlinks', () => {
  test('each needed name is looked up in the folder as given, and its own target s folder is bound', () => {
    // The shape NixOS leaves: NIX_LD_LIBRARY_PATH is a folder whose every entry is a symlink into a store path of its
    // own (libc in one, libm in another), and NIX_LD is a symlink to the loader, which is in a third.
    const root = scratch();
    const store = join(root, 'store');
    for (const folder of ['libc-1/lib', 'libm-1/lib', 'libdl-1/lib', 'glibc-1/lib', 'nix-ld-1/bin', 'alsa-lib-1/lib', 'ld-library-path/share/nix-ld/lib']) {
      mkdirSync(join(store, folder), { recursive: true });
    }
    const farmFiles: [string, string][] = [['libc-1/lib', 'libc.so.6'], ['libm-1/lib', 'libm.so.6'], ['libdl-1/lib', 'libdl.so.2']];
    for (const [folder, name] of farmFiles) {
      writeFileSync(join(store, folder, name), elf64());
    }
    writeFileSync(join(store, 'glibc-1/lib/ld.so'), elf64());
    writeFileSync(join(store, 'nix-ld-1/bin/nix-ld'), elf64());
    writeFileSync(join(store, 'alsa-lib-1/lib/libasound.so'), elf64());
    // The farm is itself a link, as `/run/current-system/sw/share/nix-ld/lib` is on NixOS.
    symlinkSync(join(store, 'ld-library-path/share/nix-ld/lib'), join(root, 'farm'));
    for (const [name, target] of farmFiles.map(([folder, name]) => [name, `${folder}/${name}`] as [string, string])) {
      symlinkSync(join(store, target), join(store, 'ld-library-path/share/nix-ld/lib', name));
    }
    symlinkSync(join(store, 'glibc-1/lib/ld.so'), join(store, 'ld-library-path/share/nix-ld/lib/ld.so'));
    // The shim: the interpreter the runtime names is /lib64/ld-linux-x86-64.so.2, a link to nix-ld's own binary.
    mkdirSync(join(root, 'lib64'), { recursive: true });
    symlinkSync(join(store, 'nix-ld-1/bin/nix-ld'), join(root, 'lib64', 'ld-linux-x86-64.so.2'));
    const runtime = join(root, 'madarch');
    writeFileSync(runtime, elf64({
      interpreter: join(root, 'lib64', 'ld-linux-x86-64.so.2'),
      needed: ['libc.so.6', 'libm.so.6', 'libdl.so.2'],
      // A store path the runtime states for a library of its own: the trace's alsa-lib.
      runpath: [join(store, 'alsa-lib-1/lib')],
    }));
    const env = { NIX_LD: join(root, 'farm', 'ld.so'), NIX_LD_LIBRARY_PATH: join(root, 'farm') };

    const resolved = runtimeSandbox(runtime, env);
    expect(resolved.nixLd).toBe(true);
    // Every name is found through the farm: before the farm was on the search path, each one was "not found".
    expect(resolved.problems).toEqual([]);
    expect(resolved.mounts).toContain(join(root, 'farm'));
    expect(resolved.mounts).toContain(join(store, 'ld-library-path/share/nix-ld/lib'));
    for (const folder of ['libc-1/lib', 'libm-1/lib', 'libdl-1/lib']) expect(resolved.mounts).toContain(join(store, folder));
    // NIX_LD's folder, and the loader's real folder: the shim opens the link, the link names the store file.
    expect(resolved.mounts).toContain(join(store, 'glibc-1/lib'));
    expect(resolved.environment['NIX_LD']).toBe(env.NIX_LD);
    expect(resolved.environment['NIX_LD_LIBRARY_PATH']).toBe(env.NIX_LD_LIBRARY_PATH);

    const list = args(spec(runtime), env);
    const at = list.indexOf(join(root, 'farm'));
    expect(at).toBeGreaterThan(0);
    expect(list[at - 1]).toBe('--ro-bind');
    expect(list[at + 1]).toBe(join(root, 'farm'));
    expect(list[list.indexOf('NIX_LD_LIBRARY_PATH') + 1]).toBe(env.NIX_LD_LIBRARY_PATH);
  });

  test('a name the farm does not hold is still named as a problem, with the farm on the search path', () => {
    const root = scratch();
    const store = join(root, 'store');
    mkdirSync(join(store, 'nix-ld-1/bin'), { recursive: true });
    mkdirSync(join(store, 'ld-library-path/share/nix-ld/lib'), { recursive: true });
    writeFileSync(join(store, 'nix-ld-1/bin/nix-ld'), elf64());
    symlinkSync(join(store, 'ld-library-path/share/nix-ld/lib'), join(root, 'farm'));
    symlinkSync(join(store, 'nix-ld-1/bin/nix-ld'), join(store, 'ld-library-path/share/nix-ld/lib/ld.so'));
    mkdirSync(join(root, 'lib64'), { recursive: true });
    symlinkSync(join(store, 'nix-ld-1/bin/nix-ld'), join(root, 'lib64', 'ld-linux-x86-64.so.2'));
    const runtime = join(root, 'madarch');
    writeFileSync(runtime, elf64({ interpreter: join(root, 'lib64', 'ld-linux-x86-64.so.2'), needed: ['libmadarch-test-gone.so.1'] }));
    const resolved = runtimeSandbox(runtime, { NIX_LD: join(root, 'farm', 'ld.so'), NIX_LD_LIBRARY_PATH: join(root, 'farm') });
    expect(resolved.problems.some((problem) => problem.includes('libmadarch-test-gone.so.1'))).toBe(true);
    expect(resolved.problems.some((problem) => problem.includes(join(root, 'farm')))).toBe(true);
  });
});
