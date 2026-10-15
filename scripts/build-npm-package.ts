/**
 * Assembles the npm packages of one madarch release (madarch-lfhu): one
 * package per platform binary under the `@madarch` scope, and the `madarch`
 * package that wraps them — its `bin/madarch.js` refuses the platforms no
 * binary was built for, starts the binary the running platform names, and
 * forwards its exit. The packages stay wheels of the binary: they carry no
 * JavaScript from the project, and nothing in them reads a skill set.
 *
 *   bun scripts/build-npm-package.ts --version 0.1.0 --os linux|darwin|win32 --arch x64 [--packages-dir npm]
 *   bun scripts/build-npm-package.ts --version 0.1.0 --wrapper [--packages-dir npm]
 *
 * The result under `--packages-dir` is one npm-packable folder per run;
 * `npm pack` inside each folder makes the tarball the release carries.
 * Registry publishing needs the owner's npm token and is not part of the
 * build; the walk installs the packed tarballs directly.
 *
 * Exit 0 written, 2 when an argument or the input (the binary) is not
 * there, every refusal naming what is wrong.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: bun scripts/build-npm-package.ts --version <x.y.z> (--os <linux|darwin|win32> --arch <x64|arm64> | --wrapper) [--packages-dir <folder>] [--binary <the built artifact>]';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface NpmOptions {
  version: string;
  os: string;
  arch: string;
  wrapper: boolean;
  packagesDir: string;
  binary: string;
  localWalk: boolean;
  localPlatform: string;
}

function parseArgs(argv: readonly string[]): NpmOptions | number {
  const parsed: NpmOptions = { version: '', os: '', arch: '', wrapper: false, packagesDir: 'npm', binary: '', localWalk: false, localPlatform: '' };
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
    const dir = takes('packages-dir');
    if (dir !== undefined) {
      parsed.packagesDir = dir;
      if (arg === '--packages-dir') i++;
      continue;
    }
    if (arg === '--wrapper') {
      parsed.wrapper = true;
      continue;
    }
    if (arg === '--local-walk') {
      parsed.localWalk = true;
      continue;
    }
    const localPlatform = takes('local-platform');
    if (localPlatform !== undefined) {
      parsed.localPlatform = localPlatform;
      if (arg === '--local-platform') i++;
      continue;
    }
    const binary = takes('binary');
    if (binary !== undefined) {
      parsed.binary = binary;
      if (arg === '--binary') i++;
      continue;
    }
    console.error(`unknown option "${arg}"`);
    console.error(USAGE);
    return 2;
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(parsed.version)) {
    console.error(`--version ${JSON.stringify(parsed.version)} is no release version`);
    return 2;
  }
  if (!parsed.wrapper && (parsed.os === '' || parsed.arch === '')) {
    console.error('give either --wrapper or --os/--arch for its platform package');
    console.error(USAGE);
    return 2;
  }
  return parsed;
}

const PLATFORM_HINT = 'madarch publishes Linux and macOS x64/arm64 binaries and Windows x64 (https://github.com/shady2k/madarch/releases)';

/** The wrapper's one job: start the running platform's binary, forward its exit. */
const WRAPPER = [
  '#!/usr/bin/env node',
  '/**',
  " * The \\`madarch\\` bin of the release's npm package: one thin launcher over the",
  ' * platform package\'s compiled binary (@madarch/linux-x64 and friends; the',
  ' * npm registry installs the running platform\'s package). It adds nothing to',
  ' * the command: the same arguments go in, the same facts come out, the same',
  ' * exit code is returned, and a platform no binary was built for is refused',
  ' * with what to do instead.',
  ' */',
  'const { platform, arch } = process;',
  "const osName = { linux: 'linux', darwin: 'darwin', win32: 'win32' }[platform];",
  'if (osName === undefined) {',
  '  console.error(`madarch publishes no binary for ${platform}/${arch}:`);',
  '  console.error(' + JSON.stringify(PLATFORM_HINT) + ');',
  '  process.exit(2);',
  '}',
  "if (platform === 'win32' && arch === 'arm64') {",
  "  console.error('madarch does not support Windows arm64: LadybugDB 0.20.4 has no Windows arm64 package');",
  '  process.exit(2);',
  '}',
  "if (platform === 'linux') {",
  "  const { existsSync } = require('node:fs');",
  "  const { execFileSync } = require('node:child_process');",
  "  const { delimiter, join } = require('node:path');",
  "  const dirs = [...(process.env.LD_LIBRARY_PATH || '').split(delimiter), '/lib', '/usr/lib', '/lib64', '/usr/lib64', '/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib/aarch64-linux-gnu', '/usr/lib/aarch64-linux-gnu'];",
  "  let cache = ''; try { cache = execFileSync('ldconfig', ['-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}",
  "  const missing = ['libssl.so.3', 'libcrypto.so.3'].filter(name => !dirs.some(dir => dir && existsSync(join(dir, name))) && !cache.includes(name));",
  "  if (missing.length) { console.error(`madarch on Linux requires OpenSSL 3 runtime libraries (${missing.join(', ')}); install your distribution's OpenSSL 3 runtime package, then try again`); process.exit(2); }",
  '}',
  'const packageName = `@madarch/${osName}-${arch}`;',
  'let binaryPath;',
  'try {',
  '  binaryPath = require.resolve(packageName, { paths: [__dirname] });',
  '} catch {',
  '  console.error(`madarch ${packageName} is not installed (this npm install carries it as an optional dependency):`);',
  '  console.error(' + JSON.stringify(PLATFORM_HINT) + ');',
  '  process.exit(2);',
  '}',
  "const child = require('node:child_process').spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit' });",
  "child.on('exit', (code, signal) => {",
  '  if (signal !== null) process.exit(1);',
  '  process.exit(code ?? 1);',
  '});',
  '',
].join('\n');


function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  if (typeof options === 'number') return options;
  const out = resolve(options.packagesDir);
  const platforms = [
    'linux-x64',
    'linux-arm64',
    'darwin-arm64',
    'darwin-x64',
    'win32-x64',
  ];
  if (options.wrapper) {
    const wrapperDir = join(out, 'madarch');
    rmSync(wrapperDir, { recursive: true, force: true });
    mkdirSync(join(wrapperDir, 'bin'), { recursive: true });
    writeFileSync(join(wrapperDir, 'bin', 'madarch.js'), WRAPPER);
    const selectedPlatforms = options.localWalk && options.localPlatform !== '' ? platforms.filter((one) => one === options.localPlatform) : platforms;
    const optionalDependencies = Object.fromEntries(selectedPlatforms.map((one) => [`@madarch/${one}`, options.localWalk ? `file:../@madarch-${one}` : options.version]));
    writeFileSync(join(wrapperDir, 'package.json'), JSON.stringify({
      name: 'madarch',
      version: options.version,
      description: 'The madarch command as one release binary: create, rename, clone, serve and upgrade products, wiki included.',
      license: 'MIT',
      bin: { madarch: 'bin/madarch.js' },
      files: ['bin'],
      engines: { node: '>=18' },
      optionalDependencies,
    }, null, 2) + '\n');
    console.log(`wrote ${join(wrapperDir)}`);
    return 0;
  }
  if (options.os === 'win32' && options.arch === 'arm64') {
    console.error('Windows arm64 is not supported: LadybugDB 0.20.4 has no Windows arm64 package');
    return 2;
  }
  if (!['linux', 'darwin', 'win32'].includes(options.os) || !['x64', 'arm64'].includes(options.arch)) {
    console.error(`no platform package is built for ${options.os}/${options.arch}`);
    return 2;
  }
  const name = `${options.os}-${options.arch}`;
  const short = options.os === 'darwin' ? 'macOS' : options.os === 'win32' ? 'Windows' : 'Linux';
  const artifactName = `madarch-${options.os === 'win32' ? 'windows' : options.os}-${options.arch}${options.os === 'win32' ? '.exe' : ''}`;
  const artifact = resolve(options.binary || join(REPO_ROOT, 'dist', artifactName));
  if (!existsSync(artifact)) {
    console.error(`the binary ${artifact} is not there: build it first ("bun scripts/build-binary.ts --version ${options.version} --os ${options.os === 'win32' ? 'windows' : options.os} --arch ${options.arch}")`);
    return 2;
  }
  const dir = join(out, `@madarch-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const binaryFile = `madarch${options.os === 'win32' ? '.exe' : ''}`;
  const packageBinary = join(dir, 'bin', binaryFile);
  cpSync(artifact, packageBinary);
  if (options.os !== 'win32') chmodSync(packageBinary, 0o755);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@madarch/${name}`,
    version: options.version,
    description: `The madarch release binary for ${short} on ${options.arch}.`,
    license: 'MIT',
    main: `bin/${binaryFile}`,
    files: ['bin'],
    os: [options.os],
    cpu: [options.arch],
  }, null, 2) + '\n');
  console.log(`wrote ${join(dir)}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
