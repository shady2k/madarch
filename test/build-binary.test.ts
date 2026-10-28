/** The release compiler must keep model validation and exact-byte fingerprints together (madarch-mwhd3). */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeQueryDigest } from '../src/extract/code/query.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
interface CatalogEntry { name: string; version: number; contentDigest?: string }

/** Keep the child's own exit status and complete diagnostic when compilation or startup fails. */
function run(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
  if (result.status !== 0) {
    throw new Error(`${command}:1: ${args.join(' ')} failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout.trim();
}

test('a compiled driver validates every model and preserves source and semantic fingerprints outside the checkout', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-model-binary-'));
  try {
    const entry = join(folder, 'entry.ts');
    // Import the actual driver so its normal extractor imports and fingerprint imports meet in one bundle.
    writeFileSync(entry, `import { EXTRACTOR_VERSIONS } from ${JSON.stringify(join(ROOT, 'src/extract/driver/extractors.ts'))};\nconsole.log(JSON.stringify(EXTRACTOR_VERSIONS));\n`);
    const source = JSON.parse(run(process.execPath, [entry], folder, 10_000)) as CatalogEntry[];
    const binary = join(folder, process.platform === 'win32' ? 'models.exe' : 'models');
    run(process.execPath, ['build', '--compile', entry, '--outfile', binary], folder, 60_000);
    const compiled = JSON.parse(run(binary, [], folder, 10_000)) as CatalogEntry[];
    expect(compiled).toEqual(source);

    // Discover the shipped assets, not a second list of model names that could miss a new registry.
    const models = join(ROOT, 'src/extract/library-models');
    const files = readdirSync(models).filter(name => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const rawDigests = files.map(name => {
      const bytes = readFileSync(join(models, name), 'utf8');
      const path = `library-models/${name}`;
      const digest = codeQueryDigest([{ path, source: bytes }]);
      // Whitespace is part of source identity, even when parsing yields the same model.
      expect(codeQueryDigest([{ path, source: `${bytes} ` }])).not.toBe(digest);
      expect(JSON.parse(`${bytes} `)).toEqual(JSON.parse(bytes));
      return digest;
    });
    const byteEntries = compiled.filter(item => item.name.endsWith('-model-source-bytes'));
    expect(byteEntries.map(item => item.contentDigest).sort()).toEqual(rawDigests.sort());
    const semanticEntries = compiled.filter(item => item.name.endsWith('-model-data'));
    expect(semanticEntries).toHaveLength(files.length);
    for (const item of [...byteEntries, ...semanticEntries]) {
      expect(item.version).toBe(1);
      expect(item.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 90_000);
