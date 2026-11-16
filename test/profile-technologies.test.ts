import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import { createTestDatabaseOwner } from './test-database.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { fillProductProfile } from '../src/graph/product-profile.js';
import { createGitSnapshotSource } from '../src/plugin/repository-snapshot.js';
import { readKindAssertions } from '../src/graph/records.js';

const technologyMap = {
  languages: {extensions: {'.ts': 'TypeScript', '.py': 'Python', '.zz': 'Zulu'}, filenames: {}},
  frameworks: {extensions: {'.vue': 'Vue'}, filenames: {'next.config.ts': 'Next.js', 'config.ts': 'Not an exact filename'}},
};
function fixture(maps: unknown = technologyMap, withMarkers = true): string {
  return stringify({kinds: {profile: {
    source: 'graph',
    ...(withMarkers ? {'profile-markers': {mobile: ['**/Info.plist']}} : {}),
    'profile-technologies': maps,
    'key-edges': [{role: 'scope', edge: 'profile-scope', side: 'from'}],
    fields: ['languages', 'frameworks', 'mobile'].map(name => ({name, type: 'json', schema: {$schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', items: {type: 'string'}}, nullable: true, producers: ['profile-markers']})),
  }}, edges: [{name: 'profile-scope', from: ['profile'], to: ['system.product'], cardinality: {from: {min: 1, max: 1}, to: {min: 0, max: null}}, 'on-parent-delete': 'cascade', labels: {en: {out: 'describes', in: 'described by'}, ru: {out: 'describes', in: 'described by'}}}]});
}
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'profile-technologies-'));
  mkdirSync(join(path, 'madarch'));
  return path;
}

for (const withMarkers of [false, true]) test(`profile technologies normalize names with markers ${withMarkers}`, async () => {
  const root = folder();
  writeFolderManifest(root, fixture(technologyMap, withMarkers));
  mkdirSync(join(root, 'src'));
  for (const name of ['main.ts', 'other.ts', 'worker.py', 'app.vue', 'next.config.ts', 'not-next.config.ts', 'Info.plist', 'README.md', 'z.zz']) {
    writeFileSync(join(root, 'src', name), name === 'README.md' ? 'React Django Angular' : 'fixture');
  }
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'fixture']);
  const validated = validateProductManifests(root);
  if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
  const manifest = validated.value.manifest;
  const contract = withManifestContract(graphContractOf(manifest));
  const owner = await createTestDatabaseOwner({graphContract: contract});
  try {
    await publishValidatedManifests(owner, validated.value, contract);
    await fillProductProfile(owner, contract, manifest, createGitSnapshotSource([{id: 'fixture', root, form: 'code', commit: 'HEAD'}]));
    const profiles = await owner.run(tx => readKindAssertions(tx, 'vertex', 'profile', ['languages', 'frameworks', 'mobile'], {contract}));
    expect(profiles[0]?.values).toMatchObject({languages: ['Python', 'TypeScript', 'Zulu'], frameworks: ['Next.js', 'Vue'], mobile: withMarkers ? ['src/Info.plist'] : []});
  } finally { await owner.close(); rmSync(root, {recursive: true, force: true}); }
}, 30000);

for (const maps of [
  {languages: {extensions: {'*.ts': 'TypeScript'}, filenames: {}}},
  {languages: {extensions: {'.ts': ''}, filenames: {}}},
  {languages: {extensions: {}, filenames: {'src/config': 'Tool'}}},
  {languages: {extensions: {'.ts': 'TypeScript'}, filenames: {}, guessed: true}},
  {languages: {extensions: {}, filenames: {}}},
  {unknown: {extensions: {'.ts': 'TypeScript'}, filenames: {}}},
  {mobile: {extensions: {'.plist': 'Mobile'}, filenames: {}}},
]) test(`invalid technology map is refused with source position: ${JSON.stringify(maps)}`, () => {
  const root = folder();
  try {
    writeFolderManifest(root, fixture(maps));
    const result = validateProductManifests(root);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('profile-technologies');
    expect(JSON.stringify(result)).toContain(root);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
