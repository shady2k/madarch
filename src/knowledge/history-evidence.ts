/** Repository-scoped history projections. Counts use complete indexed evidence before display limits. */
import { byCodePoint } from '../model/order.js';
import type { GraphEntity, HistoryEvidence } from './graph-read.js';
import type { HistoryNote, HistoryRow, HistorySection } from './model.js';

export interface HistoryProjection { sections: HistorySection[]; notes: HistoryNote[] }
type Ref = (entity: GraphEntity) => NonNullable<HistoryRow['entity']>;
const day = (value: unknown): string => typeof value === 'string' ? value.slice(0, 10) : '';
const instant = (value: unknown): string => typeof value === 'string' ? value.replace(/(?:\.(\d+))?Z$/, (_all, digits: string | undefined) => `.${(digits ?? '').padEnd(6, '0')}Z`) : '';

/** A projection never reads Git or guesses ownership, causality, or data absent from its evidence. */
export function projectHistory(evidence: HistoryEvidence, subject: GraphEntity | undefined, limit: number, ref: Ref): HistoryProjection {
  const entities = new Map(evidence.entities.map((entity) => [entity.key, entity]));
  const commits = evidence.entities.filter((entity) => entity.kind === 'code.commit');
  const nonMerge = new Set(commits.filter((commit) => commit.properties['merge'] !== true).map((commit) => commit.key));
  const edges = evidence.edges;
  const contained = new Map<string, string[]>();
  for (const edge of edges) if (edge.relation === 'code.contains') {
    const members = contained.get(edge.from) ?? []; members.push(edge.to); contained.set(edge.from, members);
  }
  // Membership is what the code graph declares, not a directory prefix. A
  // package owns its modules, while a module never acquires a nested module.
  const membership = (key: string): { files: Set<string>; complete: boolean } => {
    const files = new Set<string>(); const seen = new Set<string>(); const active = new Set<string>();
    const pending: { key: string; leaving: boolean }[] = [{ key, leaving: false }];
    let complete = true;
    while (pending.length > 0) {
      const next = pending.pop()!; const current = next.key;
      if (next.leaving) { active.delete(current); seen.add(current); continue; }
      if (active.has(current)) { complete = false; continue; }
      if (seen.has(current)) continue;
      active.add(current); pending.push({ key: current, leaving: true });
      const entity = entities.get(current);
      if (entity?.kind === 'code.file') { files.add(current); continue; }
      if (entity === undefined) { complete = false; continue; }
      const children = contained.get(current) ?? [];
      if (children.length === 0) complete = false;
      for (const child of children) {
        const kind = entities.get(child)?.kind;
        if (kind === undefined) { complete = false; continue; }
        if (kind === 'code.file'
          || (entity.kind === 'code.package' && kind === 'code.module')
          || (entity.kind === 'code.service' && (kind === 'code.package' || kind === 'code.module'))) pending.push({ key: child, leaving: false });
        else if (child === current || kind !== 'code.package') complete = false;
      }
    }
    return { files, complete };
  };
  const renamed = edges.filter((edge) => edge.relation === 'code.renamed-to');
  const identities = new Map<string, string>();
  const root = (key: string): string => {
    let next = key;
    const seen = new Set<string>();
    while (identities.has(next) && !seen.has(next)) { seen.add(next); next = identities.get(next)!; }
    return next;
  };
  for (const edge of renamed) { const left = root(edge.from); const right = root(edge.to); if (left !== right) identities.set(left, right); }
  const touched = new Map<string, Set<string>>();
  for (const edge of edges) if (edge.relation === 'code.touched' && nonMerge.has(edge.from)) {
    const key = root(edge.to);
    const held = touched.get(key) ?? new Set<string>(); held.add(edge.from); touched.set(key, held);
  }
  const authorOf = new Map(edges.filter((edge) => edge.relation === 'code.authored').map((edge) => [edge.to, edge.from]));
  const row = (entity: GraphEntity): HistoryRow => ({ text: entity.label, entity: ref(entity), figures: [] });
  const sections: HistorySection[] = [];
  const notes: HistoryNote[] = [];
  const section = (role: HistorySection['role'], rows: HistoryRow[]): void => {
    if (rows.length > 0) sections.push({ role, total: rows.length, rows: rows.slice(0, limit) });
  };
  const commitRows = (keys: ReadonlySet<string>): HistoryRow[] => commits.filter((commit) => keys.has(commit.key))
    .sort((a, b) => byCodePoint(instant(b.properties['effectiveAt']), instant(a.properties['effectiveAt'])) || byCodePoint(a.key, b.key))
    .map((commit) => ({ ...row(commit), when: day(commit.properties['effectiveAt']), ...(entities.get(authorOf.get(commit.key) ?? '') === undefined ? {} : { who: entities.get(authorOf.get(commit.key)!)!.label }) }));

  if (subject === undefined || subject.kind === 'code.repository') {
    const dates = commits.map((commit) => day(commit.properties['effectiveAt'])).filter(Boolean).sort(byCodePoint);
    sections.push({ role: 'summary', total: 1, rows: [{ text: '', figures: [
      { kind: 'reachable', value: String(commits.length) },
      { kind: 'firstParent', value: String(commits.filter((commit) => commit.properties['onFirstParent'] === true).length) },
      { kind: 'merges', value: String(commits.length - nonMerge.size) },
      { kind: 'nonMerge', value: String(nonMerge.size) },
      { kind: 'authors', value: String(new Set(authorOf.values()).size) },
      ...(dates.length === 0 ? [] : [{ kind: 'since' as const, value: dates[0]! }, { kind: 'until' as const, value: dates[dates.length - 1]! }]),
    ] }] });
    notes.push({ key: 'population' });
    section('hotspots', [...touched].sort(([a, ac], [b, bc]) => bc.size - ac.size || byCodePoint(a, b)).flatMap(([key, changes]) => {
      const file = entities.get(key); return file === undefined ? [] : [{ ...row(file), figures: [{ kind: 'commits' as const, value: String(changes.size) }] }];
    }));
    section('authors', evidence.entities.filter((entity) => entity.kind === 'code.author').map((author) => ({ ...row(author), figures: [{ kind: 'commits', value: String([...authorOf.values()].filter((key) => key === author.key).length) }] })));
    section('snapshots', evidence.entities.filter((entity) => entity.kind === 'code.snapshot').map(row));
    return { sections, notes };
  }

  if (subject.kind === 'code.author') {
    const changes = new Set([...authorOf].filter(([, author]) => author === subject.key).map(([commit]) => commit));
    section('commits', commitRows(changes));
    section('files', [...touched].map(([key, all]) => ({ key, count: [...all].filter((commit) => changes.has(commit)).length }))
      .filter((one) => one.count > 0).sort((a, b) => b.count - a.count || byCodePoint(a.key, b.key))
      .flatMap(({ key, count }) => { const file = entities.get(key); return file === undefined ? [] : [{ ...row(file), figures: [{ kind: 'commits' as const, value: String(count) }] }]; }));
    notes.push({ key: 'observedAuthorship' });
    return { sections, notes };
  }

  if (subject.kind === 'code.file') {
    const identity = root(subject.key);
    const own = touched.get(identity) ?? new Set<string>();
    section('commits', commitRows(own));
    const coupled: HistoryRow[] = [];
    for (const [key, changes] of touched) {
      if (key === identity) continue;
      const both = [...own].filter((commit) => changes.has(commit)).length;
      if (both < 2) continue;
      const other = entities.get(key); if (other === undefined) continue;
      coupled.push({ ...row(other), figures: [{ kind: 'both', value: String(both) }, { kind: 'onlyThis', value: String(own.size - both) }, { kind: 'onlyOther', value: String(changes.size - both) }] });
    }
    coupled.sort((a, b) => Number(b.figures[0]!.value) - Number(a.figures[0]!.value) || byCodePoint(a.entity!.id, b.entity!.id));
    section('coupling', coupled);
    if (coupled.length > 0) {
      notes.push({ key: 'cochangeNotCause' });
      const coupledIdentities = new Set(coupled.map((one) => one.entity!.id));
      const ownIdentity = new Set([identity]);
      const includes = (members: ReturnType<typeof membership>, identities: ReadonlySet<string>): boolean => [...members.files].some((file) => identities.has(root(file)));
      let imported = false; let unresolved = false;
      for (const edge of edges) if (edge.relation === 'code.imports') {
        const from = membership(edge.from); const to = membership(edge.to);
        const fromOwn = includes(from, ownIdentity); const toOwn = includes(to, ownIdentity);
        const fromCoupled = includes(from, coupledIdentities); const toCoupled = includes(to, coupledIdentities);
        if ((fromOwn && toCoupled) || (toOwn && fromCoupled)) imported = true;
        if ((!from.complete && (toOwn || toCoupled)) || (!to.complete && (fromOwn || fromCoupled))) unresolved = true;
      }
      if (!imported && !unresolved) notes.push({ key: 'noImport' });
      if (!imported && unresolved) notes.push({ key: 'importCoverage' });
    }
    section('renames', renamed.filter((edge) => root(edge.from) === identity).flatMap((edge) => {
      const from = entities.get(edge.from); const to = entities.get(edge.to);
      return from === undefined || to === undefined ? [] : [{ ...row(to), text: `${from.label} → ${to.label}`, figures: [{ kind: 'similarity' as const, value: String(edge.properties['similarity'] ?? '') }] }];
    }));
    if (renamed.some((edge) => root(edge.from) === identity && edge.properties['similarity'] === 1)) notes.push({ key: 'unchangedMove' });
    return { sections, notes };
  }

  if (subject.kind === 'code.module' || subject.kind === 'code.service' || subject.kind === 'code.package') {
    const changes = new Set<string>();
    const members = membership(subject.key);
    for (const file of members.files) for (const commit of touched.get(root(file)) ?? []) changes.add(commit);
    if (!members.complete) notes.push({ key: 'membershipCoverage' });
    section('commits', commitRows(changes));
    const counts = new Map<string, number>();
    for (const commit of changes) { const author = authorOf.get(commit); if (author !== undefined) counts.set(author, (counts.get(author) ?? 0) + 1); }
    section('authors', [...counts].sort(([a, ac], [b, bc]) => bc - ac || byCodePoint(a, b)).flatMap(([key, count]) => { const author = entities.get(key); return author === undefined ? [] : [{ ...row(author), figures: [{ kind: 'commits' as const, value: String(count) }] }]; }));
    notes.push({ key: 'observedAuthorship' });
    return { sections, notes };
  }

  if (subject.kind === 'code.commit') {
    const parents = edges.filter((edge) => edge.from === subject.key && edge.relation === 'code.parent').sort((a, b) => Number(a.properties['position']) - Number(b.properties['position']));
    section('parents', parents.flatMap((edge) => { const parent = entities.get(edge.to); return parent === undefined ? [] : [row(parent)]; }));
    sections.push({ role: 'summary', total: 1, rows: [{ text: '', figures: (['authoredAt', 'committedAt', 'effectiveAt'] as const).flatMap((kind) => typeof subject.properties[kind] === 'string' ? [{ kind, value: String(subject.properties[kind]) }] : []) }] });
    const first = entities.get(parents[0]?.to ?? '');
    if (first !== undefined && String(subject.properties['committedAt']) <= String(first.properties['committedAt'])) notes.push({ key: 'dateAnomaly', args: { parent: String(first.properties['committedAt']) } });
    if (subject.properties['merge'] === true) {
      if (typeof subject.properties['mergedBranch'] === 'string') notes.push({ key: 'mergeBranch', args: { branch: subject.properties['mergedBranch'], date: day(subject.properties['effectiveAt']) } });
      const ancestry = (key: string): Set<string> => {
        const result = new Set<string>(); const pending = [key];
        while (pending.length > 0) { const one = pending.pop()!; if (result.has(one)) continue; result.add(one); for (const edge of edges) if (edge.from === one && edge.relation === 'code.parent') pending.push(edge.to); }
        return result;
      };
      const main = ancestry(parents[0]?.to ?? '');
      const branch = new Set<string>();
      for (const parent of parents.slice(1)) for (const key of ancestry(parent.to)) if (!main.has(key)) branch.add(key);
      section('branches', commitRows(branch));
    }
  }
  return { sections, notes };
}
