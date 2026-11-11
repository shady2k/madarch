/**
 * What a runtime needs beside its own file (decision 0035, item 9): the ELF
 * interpreter its header names, the libraries its dynamic section names, and
 * the search paths those names are resolved through — read from the file
 * itself, never guessed from a platform's name and never asked of `ldd`.
 *
 * The sandbox binds a plugin's runtime at `/runtime/bun`, and the loader runs
 * it from the paths the ELF states: on a distribution those are `/lib64/...`
 * and `/lib/...`, on NixOS they are a store path or the nix-ld shim, and on a
 * machine whose loader lives elsewhere they are wherever they are. So the
 * interpreter's own folder, every resolved library's folder (each symlink hop
 * through to the real file, including directory links), and the folders
 * `DT_RUNPATH`/`DT_RPATH` state are bound read-only at their own paths.
 *
 * A nix-ld shim is an interpreter that is not a loader: it reads `NIX_LD` and
 * `NIX_LD_LIBRARY_PATH` from the environment to find the real loader and the
 * libraries. The sandbox clears the environment, so those two are carried in
 * from the host and what they point at is bound too — nothing else of the
 * host's environment reaches the plugin.
 */
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';

/** Where a refusal stands. */
const WHERE = 'src/plugin/elf-runtime.ts';

/** The ELF constants this reader knows: the file's classes and its dynamic tags. */
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_STRSZ = 10;
const DT_RPATH = 15;
const DT_RUNPATH = 29;

/** What one ELF file states about its loader and its libraries. */
export interface ElfDynamic {
  /** The interpreter `PT_INTERP` names, when the file has one: a static file has none. */
  readonly interpreter?: string;
  /** The libraries `DT_NEEDED` names, in the file's order. */
  readonly needed: readonly string[];
  /** The folders `DT_RUNPATH` states, in its order (they replace `DT_RPATH` when both stand). */
  readonly runpath: readonly string[];
  /** The folders `DT_RPATH` states, when the file has no `DT_RUNPATH`. */
  readonly rpath: readonly string[];
}

/** One program header, as the reader holds it. */
interface ProgramHeader {
  readonly type: number;
  readonly offset: number;
  readonly vaddr: number;
  readonly filesz: number;
}

/** A file's bytes read at an offset without holding the whole file: a runtime is a hundred megabytes. */
class BytesAt {
  private readonly fd: number;
  private readonly size: number;
  constructor(file: string) {
    this.fd = openSync(file, 'r');
    this.size = statSync(file).size;
  }
  read(offset: number, length: number): Buffer {
    const wanted = Math.min(length, Math.max(0, this.size - offset));
    if (offset < 0 || wanted <= 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(wanted);
    let at = 0;
    while (at < wanted) {
      const got = readSync(this.fd, buffer, at, wanted - at, offset + at);
      if (got <= 0) break;
      at += got;
    }
    return at === wanted ? buffer : buffer.subarray(0, at);
  }
  close(): void {
    closeSync(this.fd);
  }
}

/** A little- or big-endian reader over one buffer: the ELF file states which its numbers are in. */
function readerOf(buffer: Buffer, little: boolean, where: string) {
  return {
    u16: (at: number): number => little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at),
    u32: (at: number): number => little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at),
    u64: (at: number): number => {
      const value = little ? buffer.readBigUInt64LE(at) : buffer.readBigUInt64BE(at);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${WHERE}:1: ${where} holds a number past this reader's bound at ${String(at)}`);
      return Number(value);
    },
    i64: (at: number): number => {
      const value = little ? buffer.readBigInt64LE(at) : buffer.readBigInt64BE(at);
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`${WHERE}:1: ${where} holds a number past this reader's bound at ${String(at)}`);
      return Number(value);
    },
  };
}

/** The NUL-terminated strings of one string table, by the byte offset each starts at (the offsets dynamic tags hold). */
function stringsOf(table: Buffer): Map<number, string> {
  const strings = new Map<number, string>();
  let from = 0;
  for (let at = 0; at <= table.length; at += 1) {
    if (at === table.length || table[at] === 0) {
      if (at > from) strings.set(from, table.subarray(from, at).toString('utf8'));
      from = at + 1;
    }
  }
  return strings;
}

/**
 * What one ELF file states about its interpreter and its libraries, read from its header, its program headers
 * (`PT_INTERP`, `PT_DYNAMIC`, `PT_LOAD`) and the string table its dynamic section names. A file that is no ELF is
 * refused by name; a static file answers no interpreter and no library.
 */
export function readElfDynamic(file: string): ElfDynamic {
  const bytes = new BytesAt(file);
  try {
    const ident = bytes.read(0, 16);
    if (ident.length < 16 || ident[0] !== 0x7f || ident[1] !== 0x45 || ident[2] !== 0x4c || ident[3] !== 0x46) {
      throw new Error(`${WHERE}:1: ${file} is no ELF file: its first bytes are ${JSON.stringify(ident.subarray(0, 4).toString('latin1'))}, and a runtime is read by its own ELF header`);
    }
    const elfClass = ident[4];
    const little = ident[5] === 1;
    if ((elfClass !== 1 && elfClass !== 2) || (ident[5] !== 1 && ident[5] !== 2)) {
      throw new Error(`${WHERE}:1: ${file} is an ELF file of class ${String(elfClass)} and data ${String(ident[5])}: this reader knows the 32-bit and 64-bit classes and both byte orders`);
    }
    const wide = elfClass === 2;
    const header = bytes.read(0, wide ? 64 : 52);
    const numbers = readerOf(header, little, file);
    const phoff = wide ? numbers.u64(0x20) : numbers.u32(0x1c);
    const phentsize = wide ? numbers.u16(0x36) : numbers.u16(0x2a);
    const phnum = wide ? numbers.u16(0x38) : numbers.u16(0x2c);
    const table = bytes.read(phoff, phentsize * phnum);
    const entries = readerOf(table, little, file);
    const segments: ProgramHeader[] = [];
    for (let index = 0; index < phnum; index += 1) {
      const at = index * phentsize;
      if (at + phentsize > table.length) break;
      const type = entries.u32(at);
      const offset = wide ? entries.u64(at + 8) : entries.u32(at + 4);
      const vaddr = wide ? entries.u64(at + 16) : entries.u32(at + 8);
      const filesz = wide ? entries.u64(at + 32) : entries.u32(at + 16);
      segments.push({ type, offset, vaddr, filesz });
    }
    // The interpreter: PT_INTERP's bytes, cut at their NUL.
    const interp = segments.find((one) => one.type === PT_INTERP);
    let interpreter: string | undefined;
    if (interp !== undefined) {
      const raw = bytes.read(interp.offset, Math.max(0, interp.filesz));
      const end = raw.indexOf(0);
      const text = (end < 0 ? raw : raw.subarray(0, end)).toString('utf8').trim();
      if (text !== '') interpreter = text;
    }
    const dynamic = segments.find((one) => one.type === PT_DYNAMIC);
    if (dynamic === undefined) return { ...(interpreter === undefined ? {} : { interpreter }), needed: [], runpath: [], rpath: [] };
    const raw = bytes.read(dynamic.offset, Math.max(0, dynamic.filesz));
    const dynReader = readerOf(raw, little, file);
    const size = wide ? 16 : 8;
    const wanted = new Set<number>();
    let strtab = -1;
    let strsz = -1;
    const entriesSeen: { tag: number; value: number }[] = [];
    for (let at = 0; at + size <= raw.length; at += size) {
      const tag = wide ? dynReader.i64(at) : dynReader.u32(at) >>> 0 === 0xffffffff ? -1 : dynReader.u32(at);
      if (tag === DT_NULL) break;
      const value = wide ? dynReader.u64(at + 8) : dynReader.u32(at + 4);
      entriesSeen.push({ tag, value });
      if (tag === DT_STRTAB) strtab = value;
      if (tag === DT_STRSZ) strsz = value;
      if (tag === DT_NEEDED || tag === DT_RUNPATH || tag === DT_RPATH) wanted.add(tag);
    }
    if (strtab < 0) return { ...(interpreter === undefined ? {} : { interpreter }), needed: [], runpath: [], rpath: [] };
    // A virtual address in this file: the PT_LOAD segment that holds it states the offset it stands at.
    const offsetOf = (vaddr: number): number | undefined => {
      for (const segment of segments) {
        if (segment.type === PT_LOAD && vaddr >= segment.vaddr && vaddr < segment.vaddr + segment.filesz) return segment.offset + (vaddr - segment.vaddr);
      }
      return undefined;
    };
    const fileOffset = offsetOf(strtab);
    if (fileOffset === undefined) return { ...(interpreter === undefined ? {} : { interpreter }), needed: [], runpath: [], rpath: [] };
    const strtabBytes = bytes.read(fileOffset, Math.max(0, strsz < 0 ? 0 : strsz));
    const strings = strtabBytes.length === 0 ? new Map<number, string>() : stringsOf(strtabBytes);
    const needed: string[] = [];
    const runpath: string[] = [];
    const rpath: string[] = [];
    for (const entry of entriesSeen) {
      if (!wanted.has(entry.tag)) continue;
      const text = strings.get(entry.value);
      if (text === undefined || text === '') continue;
      if (entry.tag === DT_NEEDED) needed.push(text);
      else for (const folder of text.split(':')) if (folder !== '') (entry.tag === DT_RUNPATH ? runpath : rpath).push(folder);
    }
    return { ...(interpreter === undefined ? {} : { interpreter }), needed, runpath, rpath: runpath.length > 0 ? [] : rpath };
  } finally {
    bytes.close();
  }
}

/** The dynamic-linker variables the loader expands in a search path. */
function expandPath(folder: string, object: string, platform: string): string {
  const origin = dirname(object);
  return folder
    .replaceAll('${ORIGIN}', origin)
    .replaceAll('$ORIGIN', origin)
    .replaceAll('${LIB}', platform.includes('64') ? 'lib64' : 'lib')
    .replaceAll('$LIB', platform.includes('64') ? 'lib64' : 'lib')
    .replaceAll('${PLATFORM}', platform)
    .replaceAll('$PLATFORM', platform);
}

/** The folders a loader searches for a library when the file states none that holds it. */
export function defaultLibraryFolders(platform: string = `${process.platform}-${process.arch}`): string[] {
  const folders = ['/lib', '/lib64', '/usr/lib', '/usr/lib64', '/lib32', '/usr/lib32'];
  if (platform.endsWith('x64')) folders.push('/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu');
  if (platform.endsWith('arm64')) folders.push('/lib/aarch64-linux-gnu', '/usr/lib/aarch64-linux-gnu');
  if (platform.endsWith('arm')) folders.push('/lib/arm-linux-gnueabihf', '/usr/lib/arm-linux-gnueabihf');
  return folders;
}

/** What one runtime needs bound beside its own file, and the environment a nix-ld shim reads. */
export interface RuntimeSandbox {
  /** The folders to bind read-only at their own paths, in code point order. */
  readonly mounts: readonly string[];
  /** The variables the host carries into the sandbox for this runtime (a nix-ld shim's two). */
  readonly environment: Readonly<Record<string, string>>;
  /** The interpreter the runtime names, resolved through its own symlinks, when it has one. */
  readonly interpreter?: string;
  /** Whether the interpreter is nix-ld's shim rather than a loader. */
  readonly nixLd: boolean;
  /** What this reader could not resolve, named with what was looked for. */
  readonly problems: readonly string[];
  /** The reason the runtime cannot run in the sandbox at all, when there is one. */
  readonly refusal?: string;
}

/** The host's environment as the sandbox reads it: the two variables a nix-ld shim needs. */
type HostEnv = Readonly<Record<string, string | undefined>>;

/** A file's real path, or undefined when it does not stand. */
function realOf(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

/** Every path the kernel visits, including links in parent folders and relative link targets. */
function linkChain(file: string): string[] {
  const paths: string[] = [];
  let current = resolve(file);
  try {
    // Validate the whole chain first: dangling links and cycles are errors, not partial binds.
    realpathSync(current);
    for (;;) {
      paths.push(current);
      const parts = current.split('/').filter((part) => part !== '');
      let prefix = '/';
      let linked = false;
      for (let at = 0; at < parts.length; at += 1) {
        prefix = join(prefix, parts[at]!);
        if (!lstatSync(prefix).isSymbolicLink()) continue;
        current = resolve(dirname(prefix), readlinkSync(prefix), ...parts.slice(at + 1));
        linked = true;
        break;
      }
      if (!linked) return paths;
    }
  } catch (error) {
    throw new Error(`${WHERE}:1: cannot resolve loader path ${JSON.stringify(resolve(file))} at ${JSON.stringify(current)}: ${(error as Error).message}`);
  }
}

/** A folder that stands and is a folder, or undefined. */
function folderOf(file: string): string | undefined {
  try {
    return statSync(file).isDirectory() ? resolve(file) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a name is a path the sandbox can bind: absolute, and not the root it cannot replace. */
function bindableFolder(folder: string): boolean {
  return isAbsolute(folder) && folder !== '/';
}

/** Whether the interpreter is nix-ld's shim: a loader stand-in whose real file is nix-ld's library. */
function isNixLdShim(interpreter: string, real: string | undefined): boolean {
  const named = basename(real ?? interpreter);
  return named.includes('nix-ld') || (real !== undefined && real.split('/').some((leg) => leg.startsWith('nix-ld')));
}

/**
 * The folders one runtime needs bound, and the environment a nix-ld shim reads: the interpreter `PT_INTERP` names
 * (its folder and the folder the real file stands in), every library `DT_NEEDED` names resolved through the file's
 * `DT_RUNPATH`/`DT_RPATH`, the host's `LD_LIBRARY_PATH`, and the loader's own default folders, each library's own
 * needs followed in turn; and, when the interpreter is nix-ld's shim, the host's `NIX_LD` and `NIX_LD_LIBRARY_PATH`
 * with what they point at. A library the reader cannot find is named as a problem, never silently left out.
 */
export function runtimeSandbox(runtime: string, env: HostEnv = process.env, options: { readonly platform?: string } = {}): RuntimeSandbox {
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const mounts = new Set<string>();
  const problems: string[] = [];
  const environment: Record<string, string> = {};
  const addFolder = (folder: string): void => {
    if (bindableFolder(folder)) mounts.add(folder);
  };
  const addPath = (file: string, directory = false): void => {
    try {
      for (const hop of linkChain(file)) addFolder(directory ? hop : dirname(hop));
    } catch (error) {
      const problem = (error as Error).message;
      problems.push(problem);
      refusal = refusal ?? problem;
    }
  };
  const addFile = (file: string): void => { addPath(file); };
  const hostPaths = (env['LD_LIBRARY_PATH'] ?? '').split(':').map((one) => one.trim()).filter((one) => one !== '');
  let dynamic: ElfDynamic;
  try {
    dynamic = readElfDynamic(runtime);
  } catch (error) {
    const problem = `${WHERE}:1: cannot read runtime ${JSON.stringify(resolve(runtime))}: ${(error as Error).message}`;
    return { mounts: [], environment: {}, nixLd: false, problems: [problem], refusal: problem };
  }
  const interpreter = dynamic.interpreter;
  let resolvedInterpreter: string | undefined;
  let refusal: string | undefined;
  if (interpreter !== undefined) {
    const real = realOf(interpreter);
    if (real === undefined) {
      const problem = `${WHERE}:1: the runtime ${JSON.stringify(runtime)} names the interpreter ${JSON.stringify(interpreter)}, and no such file stands on this machine: the sandbox could not start it`;
      problems.push(problem);
      refusal = problem;
    } else resolvedInterpreter = real;
    addFile(interpreter);
  }
  const nixLd = interpreter !== undefined && isNixLdShim(interpreter, resolvedInterpreter);
  // nix-ld's shim puts NIX_LD_LIBRARY_PATH on the loader's search path (it hands the loader that path as its
  // LD_LIBRARY_PATH), so the runtime's own names are resolved there too. The folder is read as it is given: its
  // entries are symlinks into a store path each, and the name the loader opens is the one in the folder.
  const nixLdFolders = nixLd ? (env['NIX_LD_LIBRARY_PATH'] ?? '').split(':').map((one) => one.trim()).filter((one) => one !== '') : [];
  const nixLdPath = nixLd ? (env['NIX_LD'] ?? '').trim() : '';
  // The loader the runtime runs under, by the real file behind its symlinks: the interpreter PT_INTERP names, and for
  // nix-ld's shim the loader NIX_LD names. The loader's own folder is where it finds the libraries it runs with (on
  // NixOS, the glibc store path's lib), so it belongs to the default search path — for the runtime's names and for the
  // loader's own alike.
  const resolvedLoader = nixLdPath === '' ? undefined : realOf(nixLdPath);
  const loaderFolders = [...new Set([
    ...(resolvedInterpreter === undefined ? [] : [dirname(resolvedInterpreter)]),
    ...(resolvedLoader === undefined ? [] : [dirname(resolvedLoader)]),
  ])];
  const defaults = [...defaultLibraryFolders(platform), ...loaderFolders];
  const searchPaths = [...hostPaths, ...nixLdFolders];
  // The folders a file is searched in, in the loader's order: a DT_RPATH that stands alone, then the host's
  // LD_LIBRARY_PATH and a nix-ld shim's NIX_LD_LIBRARY_PATH, then DT_RUNPATH (which replaces DT_RPATH when it stands),
  // then the loader's own folders and its own folder's default paths. A name that is a path of its own is read where it
  // stands.
  const foldersFor = (from: ElfDynamic, object: string): string[] => {
    const expand = (folder: string): string => expandPath(folder, object, platform);
    return [...from.rpath.map(expand), ...searchPaths, ...from.runpath.map(expand), ...defaults];
  };
  const seen = new Set<string>();
  const resolveLibrary = (name: string, folders: readonly string[]): string | undefined => {
    if (name.includes('/')) return realOf(name) !== undefined ? name : undefined;
    for (const folder of folders) {
      const candidate = join(folder, name);
      if (realOf(candidate) !== undefined) return candidate;
    }
    return undefined;
  };
  const follow = (from: ElfDynamic, object: string, depth: number): void => {
    if (depth > 8) return;
    const folders = foldersFor(from, object);
    for (const name of from.needed) {
      const key = `${object}\0${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const found = resolveLibrary(name, folders);
      if (found === undefined) {
        problems.push(`${WHERE}:1: the object ${JSON.stringify(object)} needs the library ${JSON.stringify(name)}, and no folder of its search path holds it (${folders.join(', ')})`);
        continue;
      }
      addFile(found);
      try {
        follow(readElfDynamic(found), found, depth + 1);
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
  };
  follow(dynamic, runtime, 0);
  if (resolvedInterpreter !== undefined) {
    try {
      follow(readElfDynamic(resolvedInterpreter), resolvedInterpreter, 0);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (nixLd) {
    if (nixLdPath !== '') {
      environment['NIX_LD'] = nixLdPath;
      // NIX_LD is a symlink to the loader: the folder of the name the shim opens, the folder of the file it names,
      // and the loader's own needs, resolved through the search path above (its own folder among them).
      addFile(nixLdPath);
      if (resolvedLoader !== undefined) {
        addFolder(dirname(resolvedLoader));
        try {
          follow(readElfDynamic(resolvedLoader), resolvedLoader, 0);
        } catch (error) {
          problems.push((error as Error).message);
        }
      }
    } else {
      const problem = `${WHERE}:1: the runtime ${JSON.stringify(runtime)} is run by nix-ld's shim, and this host's environment names no NIX_LD: the shim cannot find a loader inside the sandbox`;
      problems.push(problem);
      refusal = refusal ?? problem;
    }
    if (nixLdFolders.length > 0) {
      environment['NIX_LD_LIBRARY_PATH'] = nixLdFolders.join(':');
      for (const folder of nixLdFolders) {
        if (folderOf(folder) === undefined) {
          const problem = `${WHERE}:1: NIX_LD_LIBRARY_PATH names the folder ${JSON.stringify(resolve(folder))}, and it does not stand on this machine`;
          problems.push(problem);
          refusal = refusal ?? problem;
          continue;
        }
        // Include every farm entry, not only DT_NEEDED: a plugin may dlopen any of these names later.
        addPath(folder, true);
        try {
          for (const name of readdirSync(folder).sort(byCodePoint)) {
            const entry = join(folder, name);
            try {
              addPath(entry, statSync(entry).isDirectory());
            } catch (error) {
              const problem = `${WHERE}:1: cannot read NIX_LD_LIBRARY_PATH entry ${JSON.stringify(resolve(entry))}: ${(error as Error).message}`;
              problems.push(problem);
              refusal = refusal ?? problem;
            }
          }
        } catch (error) {
          const problem = `${WHERE}:1: cannot read NIX_LD_LIBRARY_PATH folder ${JSON.stringify(resolve(folder))}: ${(error as Error).message}`;
          problems.push(problem);
          refusal = refusal ?? problem;
        }
      }
    } else {
      const problem = `${WHERE}:1: the runtime ${JSON.stringify(runtime)} is run by nix-ld's shim, and this host's environment names no NIX_LD_LIBRARY_PATH: the libraries it loads cannot be found inside the sandbox`;
      problems.push(problem);
      refusal = refusal ?? problem;
    }
  }
  // The folders a distribution's loader stands in are kept whatever the runtime states, and so is the loader's own
  // folder: a plugin's own code may load a library the loader finds there, and binding them changes nothing on a
  // machine that holds none.
  for (const folder of defaults) if (folderOf(folder) !== undefined) addFolder(folder);
  return {
    mounts: [...mounts].sort(byCodePoint),
    environment,
    ...(resolvedInterpreter === undefined ? {} : { interpreter: resolvedInterpreter }),
    nixLd,
    problems,
    ...(refusal === undefined ? {} : { refusal }),
  };
}
