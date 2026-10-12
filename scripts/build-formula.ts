/**
 * Fills the Homebrew formula of one madarch release with the SHA256 sums
 * the release's binaries carry (madarch-lfhu): the formula's placeholders
 * become the sha256 of the four artifacts read from the release's
 * checksum file, so brew verifies what it lays from the same source the
 * master copies carry.
 *
 *   bun scripts/build-formula.ts --version 0.1.0 --sums-file SHA256SUMS.txt [--out brew]
 *
 * The result under `--out` is `Formula/madarch.rb` with the sums filled;
 * the release workflow attaches it, and the tap that carries it needs no
 * editing.
 *
 * Exit 0 written, 2 when the checksum file or a line is missing, every
 * refusal naming what is wrong.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: bun scripts/build-formula.ts --version <x.y.z> --sums-file <SHA256SUMS.txt> [--out brew]';

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'Formula', 'madarch.rb');
const SLOTS: ReadonlyArray<readonly [string, string]> = [
  ['RELEASE_SHA256_LINUX_X64', 'madarch-linux-x64'],
  ['RELEASE_SHA256_LINUX_ARM64', 'madarch-linux-arm64'],
  ['RELEASE_SHA256_DARWIN_X64', 'madarch-darwin-x64'],
  ['RELEASE_SHA256_DARWIN_ARM64', 'madarch-darwin-arm64'],
];

function sumsLine(sums: string, name: string): string | undefined {
  for (const line of sums.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length === 2 && fields[1] === name && /^[0-9a-f]{64}$/.test(fields[0] ?? '')) return fields[0];
  }
  return undefined;
}

function main(argv: readonly string[]): number {
  let version = '';
  let sumsPath = '';
  let out = 'brew';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const takes = (name: string): string | undefined => {
      if (arg === `--${name}`) return argv[i + 1] ?? '';
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      return undefined;
    };
    const lever = takes('version');
    if (lever !== undefined) { version = lever; if (arg === '--version') i++; continue; }
    const sums = takes('sums-file');
    if (sums !== undefined) { sumsPath = sums; if (arg === '--sums-file') i++; continue; }
    const outDir = takes('out');
    if (outDir !== undefined) { out = outDir; if (arg === '--out') i++; continue; }
    console.error(`unknown option "${arg}"`);
    console.error(USAGE);
    return 2;
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    console.error(`--version ${JSON.stringify(version)} is no release version`);
    return 2;
  }
  if (sumsPath === '' || !existsSync(sumsPath)) {
    console.error(`--sums-file ${JSON.stringify(sumsPath)} names no checksum file of the release`);
    return 2;
  }
  const sums = readFileSync(sumsPath, 'utf8');
  let text = readFileSync(TEMPLATE, 'utf8');
  text = text.replace('version "0.1.0"', `version "${version}"`);
  for (const [slot, artifact] of SLOTS) {
    const sha = sumsLine(sums, artifact);
    if (sha === undefined) {
      console.error(`the checksum file carries no line for ${artifact}`);
      return 2;
    }
    text = text.replace(slot, sha);
  }
  mkdirSync(resolve(out, 'Formula'), { recursive: true });
  const file = resolve(out, 'Formula', 'madarch.rb');
  writeFileSync(file, text);
  console.log(`wrote ${file}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
