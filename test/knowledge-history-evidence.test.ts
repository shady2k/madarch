import { describe, expect, test } from 'bun:test';
import type { GraphEntity, HistoryEvidence } from '../src/knowledge/graph-read.js';
import { projectHistory } from '../src/knowledge/history-evidence.js';

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
    const projection = projectHistory(fixture(), entity('code.module', 'internal/domain'), 50, ref);
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
});
