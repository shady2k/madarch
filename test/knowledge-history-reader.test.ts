/** Production reader regression: real indexed containment reaches history projection. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import { createGraphStore } from '../src/graph/index.js';
import { GraphReader, type GraphEntity } from '../src/knowledge/graph-read.js';
import { projectHistory } from '../src/knowledge/history-evidence.js';
import { gitEnv } from './git-env.js';

test('real indexed root-package contributions and Go module imports survive the production history reader', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'madarch-history-reader-'));
  const repository = join(workspace, 'repository');
  mkdirSync(repository);
  const owner = createPGliteDatabaseOwner({ btreeGist: true });
  const commits: string[] = [];
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repository, encoding: 'utf8', env: gitEnv() }).trim();
  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(repository, file)), { recursive: true });
    writeFileSync(join(repository, file), text);
  };
  try {
    git('init', '-q', '-b', 'main');
    write('package.json', JSON.stringify({ name: 'neutral-library' }));
    write('go.mod', 'module example.org/neutral\n\ngo 1.22\n');
    for (const version of [1, 2]) {
      write('index.ts', `export const revision = ${version};\n`);
      write('a/main.go', `package a\nimport "example.org/neutral/b"\nfunc Run() int { return b.Value() + ${version} }\n`);
      write('b/lib.go', `package b\nfunc Value() int { return ${version} }\n`);
      git('add', '-A');
      execFileSync('git', ['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', `Change ${version}`], {
        cwd: repository, env: gitEnv({ GIT_AUTHOR_DATE: `2026-01-0${version}T12:00:00Z`, GIT_COMMITTER_DATE: `2026-01-0${version}T12:00:00Z` }),
      });
      commits.push(git('rev-parse', 'HEAD'));
    }
    await owner.ready;
    const store = createGraphStore(owner);
    await store.createSchema();
    const filled = await fillGraph({ owner, store, repository, extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots: {} });
    // The same keys and commits indexed under another real repository scope must not leak or inflate totals.
    const otherRepository = join(workspace, 'other-repository');
    cpSync(repository, otherRepository, { recursive: true });
    const otherFilled = await fillGraph({ owner, store, repository: otherRepository, extractors: TREE_EXTRACTORS, owners: OWNERS, history: HISTORY_EXTRACTOR, snapshots: {} });
    expect(otherFilled.repositoryNode).not.toBe(filled.repositoryNode);
    const reader = new GraphReader(owner, () => '2026-01-03T00:00:00Z');
    expect((await reader.historyEvidence(otherFilled.repositoryNode)).entities.length).toBeGreaterThan(0);
    const evidence = await reader.at('2026-01-03T00:00:00Z', filled.repositoryNode).historyEvidence(filled.repositoryNode);
    expect(evidence.entities.every((one) => one.scope === filled.repositoryNode)).toBe(true);
    expect(await reader.at('2026-01-03T00:00:00Z', filled.repositoryNode).historyEvidence(otherFilled.repositoryNode)).toEqual({ entities: [], edges: [] });
    const rootPackage = evidence.entities.find((one) => one.kind === 'code.package' && one.key.endsWith(':.'));
    const source = evidence.entities.find((one) => one.kind === 'code.file' && one.properties['path'] === 'a/main.go');
    const target = evidence.entities.find((one) => one.kind === 'code.file' && one.properties['path'] === 'b/lib.go');
    expect(rootPackage).toBeDefined(); expect(source).toBeDefined(); expect(target).toBeDefined();
    if (!rootPackage || !source || !target) throw new Error(`Indexed fixture omitted root package or Go files in ${repository}`);
    const membership = evidence.edges.filter((one) => one.relation === 'code.contains' && one.from === rootPackage.key);
    expect(membership.length).toBeGreaterThan(0);
    const imported = evidence.edges.find((one) => one.relation === 'code.imports' && one.from === source.key);
    expect(imported).toBeDefined();
    if (!imported) throw new Error(`Indexed fixture omitted the Go import from ${source.key} in ${repository}`);
    const module = evidence.entities.find((one) => one.key === imported.to);
    expect(module?.kind).toBe('code.module');
    if (!module) throw new Error(`Indexed fixture omitted imported module ${imported.to} in ${repository}`);
    const containment = evidence.edges.filter((one) => one.relation === 'code.contains' && one.from === imported.to && one.to === target.key);
    expect(containment).toHaveLength(1);
    expect(containment[0]).toEqual({
      relation: 'code.contains', from: imported.to, to: target.key,
      properties: {
        sourceProducer: 'code.extract.code',
        origins: [{ properties: {}, sourceSpan: null, sourceProducer: 'code.extract.code', originalDiscriminator: '' }],
      },
    });
    const reference = (one: GraphEntity) => ({ id: one.key, kind: one.kind, label: one.label, href: `/k/e?id=${encodeURIComponent(one.key)}` });
    for (const container of [rootPackage, module]) {
      const history = projectHistory(evidence, container, 50, reference);
      const contribution = history.sections.find((one) => one.role === 'commits');
      expect(contribution?.total).toBe(2);
      expect(contribution?.rows.map((one) => one.entity?.id).sort()).toEqual(commits.map((hash) => `code.commit:${hash}`).sort());
      expect(history.sections.find((one) => one.role === 'authors')?.rows[0]?.figures).toEqual([{ kind: 'commits', value: '2' }]);
      expect(history.notes.map((one) => one.key)).not.toContain('membershipCoverage');
    }
    const sourceHistory = projectHistory(evidence, source, 50, reference);
    expect(sourceHistory.sections.find((one) => one.role === 'commits')?.total).toBe(2);
    const coupling = sourceHistory.sections.find((one) => one.role === 'coupling')?.rows.find((one) => one.entity?.id === target.key);
    expect(coupling?.figures).toEqual([{ kind: 'both', value: '2' }, { kind: 'onlyThis', value: '0' }, { kind: 'onlyOther', value: '0' }]);
    expect(sourceHistory.notes.map((one) => one.key)).toContain('cochangeNotCause');
    expect(sourceHistory.notes.map((one) => one.key)).not.toContain('noImport');
    expect(sourceHistory.notes.map((one) => one.key)).not.toContain('importCoverage');
    // Only the tip tree was indexed: the real first commit exists, but its containment is unread.
    const beforeTip = await reader.at('2026-01-01T18:00:00Z', filled.repositoryNode).historyEvidence(filled.repositoryNode);
    expect(beforeTip.entities.some((one) => one.key === rootPackage.key)).toBe(false);
    expect(beforeTip.edges.filter((one) => one.relation === 'code.contains' || one.relation === 'code.imports')).toEqual([]);
  } finally {
    try { await owner.close(); } finally { rmSync(workspace, { recursive: true, force: true }); }
  }
}, 60_000);
