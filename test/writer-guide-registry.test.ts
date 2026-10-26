import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { registeredGuideOutput } from '../src/writer/guides/host-contract.js';
import { readKinds } from '../src/knowledge/kinds.js';

test('guide output paths come only from the product registry, including non-default locations', () => {
  const folder = mkdtempSync(join(tmpdir(), 'guide-registry-'));
  try {
    seedStarterSet(folder);
    const file = join(folder, 'madarch', 'kinds.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('file: docs/guides/administrator.md', 'file: docs/help/admin.md').replace('file: docs/guides/user.md', 'file: docs/manual/reader.md'));
    expect(registeredGuideOutput(folder, 'administrator-guide')).toEqual({ id: 'administrator-guide:main', path: 'docs/help/admin.md' });
    expect(registeredGuideOutput(folder, 'user-guide')).toEqual({ id: 'user-guide:main', path: 'docs/manual/reader.md' });
    const read = readKinds(folder); expect(read.present && read.manifest.findings).toEqual([]);
    writeFileSync(file, readFileSync(file, 'utf8').replace('file: docs/help/admin.md', 'file: ../escape.md'));
    expect(() => registeredGuideOutput(folder, 'administrator-guide')).toThrow('valid single-file Markdown guide declaration is required');
    expect(registeredGuideOutput(folder, 'user-guide').path).toBe('docs/manual/reader.md');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
