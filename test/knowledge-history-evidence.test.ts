import { describe, expect, test } from 'bun:test';
import type { GraphEntity, HistoryEvidence } from '../src/knowledge/graph-read.js';
import { projectHistory } from '../src/knowledge/history-evidence.js';
import { extractCode } from '../src/extract/code/index.js';

const entity = (kind: string, name: string, properties: Record<string, unknown> = {}): GraphEntity => ({ key: `${kind}:${name}`, kind, label: name, properties, scope: '1', nodeIds: [] });
const ref = (one: GraphEntity) => ({ id: one.key, kind: one.kind, label: one.label, href: `/k/e?id=${encodeURIComponent(one.key)}` });
function fixture(): HistoryEvidence {
  const commits = [
    entity('code.commit', 'root', { onFirstParent: true, merge: false, effectiveAt: '2026-01-01T00:00:00Z', committedAt: '2026-01-01T00:00:00Z', authoredAt: '2026-01-01T00:00:00Z' }),
    entity('code.commit', 'feature', { onFirstParent: false, merge: false, effectiveAt: '2026-01-03T00:00:00Z', committedAt: '2026-01-02T00:00:00Z', authoredAt: '2026-01-02T00:00:00Z' }),
    entity('code.commit', 'merge', { onFirstParent: true, merge: true, mergedBranch: 'feature/observability', effectiveAt: '2026-01-03T00:00:00Z', committedAt: '2026-01-03T00:00:00Z', authoredAt: '2026-01-03T00:00:00Z' }),
    entity('code.commit', 'move', { onFirstParent: true, merge: false, effectiveAt: '2026-01-03T00:00:00.000001Z', committedAt: '2026-01-02T00:00:00Z', authoredAt: '2026-01-04T00:00:00Z' }),
  ];
  const files = ['src/old.go', 'internal/domain/item.go', 'internal/domain/tax.go'].map((name) => entity('code.file', name));
  const author = entity('code.author', 'Test Author');
  const e = (relation: string, from: string, to: string, properties: Record<string, unknown> = {}) => ({ relation, from, to, properties });
  return { entities: [...commits, ...files, author], edges: [
    ...commits.map((commit) => e('code.authored', author.key, commit.key)),
    e('code.parent', commits[1]!.key, commits[0]!.key, { position: 1 }),
    e('code.parent', commits[2]!.key, commits[0]!.key, { position: 1 }),
    e('code.parent', commits[2]!.key, commits[1]!.key, { position: 2 }),
    e('code.parent', commits[3]!.key, commits[2]!.key, { position: 1 }),
    e('code.renamed-to', files[0]!.key, files[1]!.key, { similarity: 1 }),
    ...[0, 1, 3].flatMap((index) => [e('code.touched', commits[index]!.key, files[index === 0 ? 0 : 1]!.key), e('code.touched', commits[index]!.key, files[2]!.key)]),
    // A rename may touch both paths; it is still one change of one identity.
    e('code.touched', commits[3]!.key, files[0]!.key),
    // Even malformed historical input cannot inflate the non-merge population.
    e('code.touched', commits[2]!.key, files[1]!.key),
  ] };
}

describe('complete indexed history projections', () => {
  test('summary populations include branch work and exclude merge diffs; ranking precedes its display cut', () => {
    const projection = projectHistory(fixture(), undefined, 1, ref);
    const figures = projection.sections.find((section) => section.role === 'summary')!.rows[0]!.figures;
    expect(Object.fromEntries(figures.map((figure) => [figure.kind, figure.value]))).toMatchObject({ reachable: '4', firstParent: '3', merges: '1', nonMerge: '3', authors: '1', since: '2026-01-01', until: '2026-01-03' });
    const hotspots = projection.sections.find((section) => section.role === 'hotspots')!;
    expect(hotspots.total).toBe(2);
    expect(hotspots.rows).toHaveLength(1);
    expect(hotspots.rows[0]!.figures).toEqual([{ kind: 'commits', value: '3' }]);
  });
  test('a move joins old and new history without double-counting, and coupling shows both single-file counts', () => {
    const evidence = fixture();
    const file = evidence.entities.find((one) => one.label === 'src/old.go')!;
    const projection = projectHistory(evidence, file, 50, ref);
    expect(projection.sections.find((section) => section.role === 'commits')!.total).toBe(3);
    expect(projection.sections.find((section) => section.role === 'coupling')!.rows[0]!.figures).toEqual([{ kind: 'both', value: '3' }, { kind: 'onlyThis', value: '0' }, { kind: 'onlyOther', value: '0' }]);
    expect(projection.sections.find((section) => section.role === 'renames')!.rows[0]!.text).toBe('src/old.go → internal/domain/item.go');
    expect(projection.notes.map((note) => note.key)).toEqual(['cochangeNotCause', 'noImport', 'unchangedMove']);
  });
  test('module contributions aggregate complete identities and count each commit once, without asserting ownership', () => {
    const evidence = fixture();
    const module = entity('code.module', 'internal/domain');
    evidence.entities.push(module);
    evidence.edges.push(...evidence.entities.filter((one) => one.kind === 'code.file' && one.label !== 'src/old.go').map((one) => ({ relation: 'code.contains', from: module.key, to: one.key, properties: {} })));
    const projection = projectHistory(evidence, module, 50, ref);
    expect(projection.sections.find((section) => section.role === 'commits')!.total).toBe(3);
    expect(projection.sections.find((section) => section.role === 'authors')!.rows[0]!.figures).toEqual([{ kind: 'commits', value: '3' }]);
    expect(projection.notes).toContainEqual({ key: 'observedAuthorship' });
  });
  test('merge explains its branch, two ordered parents and only the introduced branch work', () => {
    const evidence = fixture();
    const projection = projectHistory(evidence, evidence.entities.find((one) => one.label === 'merge')!, 50, ref);
    expect(projection.sections.find((section) => section.role === 'parents')!.rows.map((row) => row.text)).toEqual(['root', 'feature']);
    expect(projection.sections.find((section) => section.role === 'branches')!.rows.map((row) => row.text)).toEqual(['feature']);
    expect(projection.notes).toContainEqual({ key: 'mergeBranch', args: { branch: 'feature/observability', date: '2026-01-03' } });
  });
  test('an anomalous raw date keeps author, committer and effective time and names its parent date', () => {
    const evidence = fixture();
    const projection = projectHistory(evidence, evidence.entities.find((one) => one.label === 'move')!, 50, ref);
    expect(projection.sections.find((section) => section.role === 'summary')!.rows[0]!.figures.map((figure) => figure.kind)).toEqual(['authoredAt', 'committedAt', 'effectiveAt']);
    expect(projection.notes).toContainEqual({ key: 'dateAnomaly', args: { parent: '2026-01-03T00:00:00Z' } });
  });
  test('coupling never calls an indexed import absent when either direction exists', () => {
    const evidence = fixture();
    evidence.edges.push({ relation: 'code.imports', from: 'code.file:internal/domain/tax.go', to: 'code.file:internal/domain/item.go', properties: {} });
    const projection = projectHistory(evidence, evidence.entities.find((one) => one.label === 'src/old.go')!, 50, ref);
    expect(projection.notes.map((note) => note.key)).not.toContain('noImport');
  });
  test('root package follows its contained module and excludes nested package or neighboring module histories', () => {
    const evidence = fixture();
    const rootPackage = entity('code.package', '.');
    const rootModule = entity('code.module', '.');
    const neighbor = entity('code.module', 'elsewhere');
    const nested = entity('code.package', 'nested');
    const nestedModule = entity('code.module', 'nested');
    const disconnected = entity('code.file', 'index.ts');
    const excludedCommit = entity('code.commit', 'excluded-boundaries', { merge: false });
    evidence.entities.push(rootPackage, rootModule, neighbor, nested, nestedModule, disconnected, excludedCommit);
    const files = evidence.entities.filter((one) => one.kind === 'code.file');
    evidence.edges.push({ relation: 'code.touched', from: excludedCommit.key, to: disconnected.key, properties: {} });
    const edge = (from: string, to: string) => ({ relation: 'code.contains', from, to, properties: {} });
    evidence.edges.push(edge(rootPackage.key, rootModule.key), edge(rootModule.key, files[0]!.key),
      edge(rootPackage.key, nested.key), edge(nested.key, nestedModule.key), edge(nestedModule.key, disconnected.key),
      edge(rootModule.key, neighbor.key), edge(neighbor.key, disconnected.key),
      edge(rootModule.key, rootModule.key), edge(rootPackage.key, 'missing-container'));
    // The contained renamed file has three commits. The identical prefix of
    // an uncontained file, and graph neighbors behind boundaries, add nothing.
    const packageHistory = projectHistory(evidence, rootPackage, 50, ref);
    const moduleHistory = projectHistory(evidence, rootModule, 50, ref);
    expect(packageHistory.sections.find((one) => one.role === 'commits')!.total).toBe(3);
    expect(moduleHistory.sections.find((one) => one.role === 'commits')!.total).toBe(3);
    const uncontained = entity('code.package', 'internal'); evidence.entities.push(uncontained);
    expect(projectHistory(evidence, uncontained, 50, ref).sections).toEqual([]);
    expect(projectHistory(evidence, uncontained, 50, ref).notes).toContainEqual({ key: 'membershipCoverage' });
  });
  test('Go file-to-module imports reach the target file through declared containment in either direction', () => {
    for (const reverse of [false, true]) {
      const evidence = fixture();
      const module = entity('code.module', 'unrelated-directory-name'); evidence.entities.push(module);
      const moved = evidence.entities.find((one) => one.label === 'internal/domain/item.go')!;
      const other = evidence.entities.find((one) => one.label === 'internal/domain/tax.go')!;
      const source = reverse ? other : moved; const target = reverse ? moved : other;
      evidence.edges.push({ relation: 'code.contains', from: module.key, to: target.key, properties: {} },
        { relation: 'code.imports', from: source.key, to: module.key, properties: {} });
      const notes = projectHistory(evidence, moved, 50, ref).notes.map((one) => one.key);
      expect(notes).toContain('cochangeNotCause');
      expect(notes).not.toContain('noImport');
    }
  });
  test('an import into an unrelated module does not invent a dependency to a coupled file', () => {
    const evidence = fixture(); const module = entity('code.module', 'remote'); const unrelated = entity('code.file', 'remote/new.go');
    evidence.entities.push(module, unrelated);
    const source = evidence.entities.find((one) => one.label === 'internal/domain/item.go')!;
    evidence.edges.push({ relation: 'code.contains', from: module.key, to: unrelated.key, properties: {} },
      { relation: 'code.imports', from: source.key, to: module.key, properties: {} });
    expect(projectHistory(evidence, source, 50, ref).notes.map((one) => one.key)).toContain('noImport');
  });

  test('unresolved imported container membership is not proof that a coupled import is absent', () => {
    for (const present of [false, true]) {
      const evidence = fixture(); const module = entity('code.module', 'opaque');
      const source = evidence.entities.find((one) => one.label === 'src/old.go')!;
      if (present) evidence.entities.push(module);
      evidence.edges.push({ relation: 'code.imports', from: source.key, to: module.key, properties: {} });
      if (present) evidence.edges.push({ relation: 'code.contains', from: module.key, to: module.key, properties: {} });
      expect(projectHistory(evidence, source, 50, ref).notes.map((one) => one.key)).not.toContain('noImport');
      expect(projectHistory(evidence, source, 50, ref).notes).toContainEqual({ key: 'importCoverage' });
    }
  });

  test('actual code extraction root-package containment and Go module imports survive history projection', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'neutral-library' }),
      'index.ts': 'export const enabled = true;\n',
      'go.mod': 'module example.org/neutral\n\ngo 1.22\n',
      'a/main.go': 'package a\nimport "example.org/neutral/b"\nfunc Run() int { return b.Value() }\n',
      'b/lib.go': 'package b\nfunc Value() int { return 1 }\n',
    };
    const encoder = new TextEncoder();
    const extracted = await extractCode({ paths: Object.keys(files).sort(), read: (path) => encoder.encode(files[path as keyof typeof files]) });
    expect(extracted.gaps).toEqual([]);
    const evidence: HistoryEvidence = {
      entities: extracted.nodes.map((one) => ({ key: one.key, kind: one.kind, label: one.label, properties: { ...one.properties }, scope: '1', nodeIds: [], ...(one.span === undefined ? {} : { span: one.span }) })),
      edges: extracted.edges.map((one) => ({ relation: one.type, from: one.from, to: one.to, properties: { ...one.properties } })),
    };
    const rootPackage = evidence.entities.find((one) => one.kind === 'code.package' && one.key.endsWith(':.'))!;
    expect(rootPackage).toBeDefined();
    const source = evidence.entities.find((one) => one.kind === 'code.file' && one.span?.path === 'a/main.go')!;
    const target = evidence.entities.find((one) => one.kind === 'code.file' && one.span?.path === 'b/lib.go')!;
    const rootFile = evidence.entities.find((one) => one.kind === 'code.file' && one.span?.path === 'index.ts')!;
    const imported = evidence.edges.find((one) => one.relation === 'code.imports' && one.from === source.key)!;
    expect(evidence.entities.find((one) => one.key === imported.to)!.kind).toBe('code.module');
    expect(evidence.edges).toContainEqual({ relation: 'code.contains', from: imported.to, to: target.key, properties: {} });
    for (const name of ['first', 'second']) {
      const commit = entity('code.commit', name, { merge: false }); evidence.entities.push(commit);
      for (const file of [source, target, rootFile]) evidence.edges.push({ relation: 'code.touched', from: commit.key, to: file.key, properties: {} });
    }
    expect(projectHistory(evidence, source, 50, ref).notes.map((one) => one.key)).not.toContain('noImport');
    expect(projectHistory(evidence, rootPackage, 50, ref).sections.find((one) => one.role === 'commits')!.total).toBe(2);
  }, 20_000);

  test('a package follows all owned modules and a valid shared-file DAG is not incomplete', () => {
    const evidence = fixture(); const owner = entity('code.package', '.');
    const modules = [entity('code.module', '.'), entity('code.module', 'separate')];
    const file = evidence.entities.find((one) => one.label === 'src/old.go')!;
    const separateFile = entity('code.file', 'other-entry.ts'); const separateCommit = entity('code.commit', 'other-module-change', { merge: false });
    evidence.entities.push(owner, ...modules, separateFile, separateCommit);
    for (const module of modules) evidence.edges.push({ relation: 'code.contains', from: owner.key, to: module.key, properties: {} },
      { relation: 'code.contains', from: module.key, to: file.key, properties: {} });
    evidence.edges.push({ relation: 'code.contains', from: modules[1]!.key, to: separateFile.key, properties: {} },
      { relation: 'code.touched', from: separateCommit.key, to: separateFile.key, properties: {} });
    const result = projectHistory(evidence, owner, 50, ref);
    expect(result.sections.find((one) => one.role === 'commits')!.total).toBe(4);
    expect(result.notes).not.toContainEqual({ key: 'membershipCoverage' });
  });

});
