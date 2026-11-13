/** Repository-scoped history projections. Counts use complete indexed evidence before display limits. */
import { byCodePoint } from '../model/order.js';
import type { GraphEntity, HistoryEvidence } from './graph-read.js';
import type { HistoryShape } from '../product/manifest/kinds.js';
import { GIT_FIELDS, GIT_WIKI } from '../fill/stages/git-contract.js';
import type { HistoryFigure, HistoryNote, HistoryRow, HistorySection } from './model.js';

export interface HistoryProjection { sections: HistorySection[]; notes: HistoryNote[] }
type Ref = (entity: GraphEntity) => NonNullable<HistoryRow['entity']>;
const day = (value: unknown): string => typeof value === 'string' ? value.slice(0, 10) : '';
const instant = (value: unknown): string => typeof value === 'string' ? value.replace(/(?:\.(\d+))?Z$/, (_all, digits: string | undefined) => `.${(digits ?? '').padEnd(6, '0')}Z`) : '';

/**
 * One product-wide projection across repositories (madarch-ztyq.7 review): the limit bounds the whole story, not
 * each repository. Entities and edges are deduplicated by their graph identity, so a shared author or commit that
 * several repository reads return is counted once.
 */
export function projectHistoryAcross(evidences: readonly HistoryEvidence[], limit: number, ref: Ref): HistoryProjection {
  const entities = new Map<string, GraphEntity>();
  const edges = new Map<string, HistoryEvidence['edges'][number]>();
  for (const evidence of evidences) {
    for (const entity of evidence.entities) if (!entities.has(entity.key)) entities.set(entity.key, entity);
    for (const edge of evidence.edges) {
      const identity = `${edge.from}\u0000${edge.to}\u0000${edge.relation}\u0000${JSON.stringify(edge.properties)}`;
      if (!edges.has(identity)) edges.set(identity, edge);
    }
  }
  return projectHistory({ entities: [...entities.values()], edges: [...edges.values()] }, undefined, 'repositories', limit, ref);
}

/**
 * A projection never reads Git or guesses ownership, causality, or data absent from its evidence. `shape` is the story
 * the entity's kind declares (`history:` of its declaration): the entity's kind chooses no branch here, and the kinds
 * the evidence holds — commits, files, authors, snapshots — are the history extractor's own vocabulary (decision 0033,
 * item 7), read as facts.
 */
export function projectHistory(evidence: HistoryEvidence, subject: GraphEntity | undefined, shape: HistoryShape, limit: number, ref: Ref): HistoryProjection {
  const entities = new Map(evidence.entities.map((entity) => [entity.key, entity]));
  const commits = evidence.entities.filter((entity) => entity.kind === GIT_WIKI.commit);
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
      if (entity?.kind === GIT_WIKI.file) { files.add(current); continue; }
      if (entity === undefined) { complete = false; continue; }
      const children = contained.get(current) ?? [];
      if (children.length === 0) complete = false;
      for (const child of children) {
        const kind = entities.get(child)?.kind;
        if (kind === undefined) { complete = false; continue; }
        if (kind === GIT_WIKI.file
          || (entity.kind === 'code.package' && kind === 'code.module')
          || (entity.kind === 'code.service' && (kind === 'code.package' || kind === 'code.module'))) pending.push({ key: child, leaving: false });
        else if (child === current || kind !== 'code.package') complete = false;
      }
    }
    return { files, complete };
  };
  const renamed = edges.filter((edge) => edge.relation === GIT_WIKI.renamedFrom);
  const identities = new Map<string, string>();
  const root = (key: string): string => {
    let next = key;
    const seen = new Set<string>();
    while (identities.has(next) && !seen.has(next)) { seen.add(next); next = identities.get(next)!; }
    return next;
  };
  for (const edge of renamed) { const left = root(edge.from); const right = root(edge.to); if (left !== right) identities.set(left, right); }
  const touched = new Map<string, Set<string>>();
  for (const edge of edges) if (edge.relation === GIT_WIKI.touched && nonMerge.has(edge.from)) {
    const key = root(edge.to);
    const held = touched.get(key) ?? new Set<string>(); held.add(edge.from); touched.set(key, held);
  }
  const authorOf = new Map(edges.filter((edge) => edge.relation === GIT_WIKI.authored).map((edge) => [edge.to, edge.from]));
  /** The touched edge of one commit and one file identity: what the commit did to the file. */
  const touchedEdge = new Map<string, { properties: Record<string, unknown>; to: string }>();
  for (const edge of edges) if (edge.relation === GIT_WIKI.touched) touchedEdge.set(`${edge.from}\u0000${root(edge.to)}`, { properties: edge.properties, to: edge.to });
  /** The old file one rename edge names, by its new file and the commit that renamed it. */
  const renamedFrom = new Map<string, string>();
  for (const edge of renamed) {
    const discriminator = edge.properties['discriminator'];
    if (typeof discriminator === 'string' && discriminator !== '') renamedFrom.set(`${edge.from}\u0000${discriminator}`, edge.to);
  }
  /** What one commit changed in all: the files it touched and the lines it added and removed. */
  const churnByCommit = new Map<string, { files: number; added: number; removed: number }>();
  for (const edge of edges) if (edge.relation === GIT_WIKI.touched) {
    const held = churnByCommit.get(edge.from) ?? { files: 0, added: 0, removed: 0 };
    held.files += 1;
    const added = edge.properties[GIT_FIELDS.added];
    const removed = edge.properties[GIT_FIELDS.removed];
    held.added += typeof added === 'number' ? added : 0;
    held.removed += typeof removed === 'number' ? removed : 0;
    churnByCommit.set(edge.from, held);
  }
  const figuresOf = (properties: Record<string, unknown> | undefined, oldPath: string | undefined): HistoryFigure[] => {
    if (properties === undefined) return [];
    const figures: HistoryFigure[] = [];
    const change = properties[GIT_FIELDS.change];
    const added = properties[GIT_FIELDS.added];
    const removed = properties[GIT_FIELDS.removed];
    if (typeof change === 'string') figures.push({ kind: 'change', value: change });
    if (typeof added === 'number') figures.push({ kind: 'added', value: String(added) });
    if (typeof removed === 'number') figures.push({ kind: 'removed', value: String(removed) });
    if (oldPath !== undefined) figures.push({ kind: 'renamed', value: oldPath });
    return figures;
  };
  const row = (entity: GraphEntity): HistoryRow => ({ text: entity.label, entity: ref(entity), figures: [] });
  const sections: HistorySection[] = [];
  const notes: HistoryNote[] = [];
  const section = (role: HistorySection['role'], rows: HistoryRow[], total = rows.length): void => {
    if (rows.length > 0) sections.push({ role, total, rows: rows.slice(0, limit) });
  };
  const commitRows = (keys: ReadonlySet<string>, identity?: string): HistoryRow[] => commits.filter((commit) => keys.has(commit.key))
    .sort((a, b) => byCodePoint(instant(b.properties[GIT_FIELDS.effectiveAt]), instant(a.properties[GIT_FIELDS.effectiveAt])) || byCodePoint(a.key, b.key))
    .map((commit) => {
      const edge = identity === undefined ? undefined : touchedEdge.get(`${commit.key}\u0000${identity}`);
      const hash = typeof commit.properties[GIT_FIELDS.hash] === 'string' ? commit.properties[GIT_FIELDS.hash] : commit.key.slice(GIT_WIKI.commit.length + 1);
      const old = edge === undefined ? undefined : renamedFrom.get(`${edge.to}\u0000${hash}`);
      const author = entities.get(authorOf.get(commit.key) ?? '');
      return {
        ...row(commit),
        when: day(commit.properties[GIT_FIELDS.effectiveAt]),
        ...(author === undefined ? {} : { who: String(author.properties[GIT_FIELDS.name] ?? author.label) }),
        figures: figuresOf(edge?.properties, old === undefined ? undefined : entities.get(old)?.label),
      };
    });

  if (shape === 'repositories') {
    const dates = commits.map((commit) => day(commit.properties[GIT_FIELDS.effectiveAt])).filter(Boolean).sort(byCodePoint);
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

  // Every other story is told of one entity: the caller read the shape from that entity's kind.
  if (subject === undefined) throw new Error(`src/knowledge/history-evidence.ts: the history story "${shape}" was asked for without the entity it tells about`);

  if (shape === 'author') {
    const changes = new Set([...authorOf].filter(([, author]) => author === subject.key).map(([commit]) => commit));
    section('commits', commitRows(changes));
    section('files', [...touched].map(([key, all]) => ({ key, count: [...all].filter((commit) => changes.has(commit)).length }))
      .filter((one) => one.count > 0).sort((a, b) => b.count - a.count || byCodePoint(a.key, b.key))
      .flatMap(({ key, count }) => { const file = entities.get(key); return file === undefined ? [] : [{ ...row(file), figures: [{ kind: 'commits' as const, value: String(count) }] }]; }));
    notes.push({ key: 'observedAuthorship' });
    return { sections, notes };
  }

  if (shape === 'path') {
    const identity = root(subject.key);
    const own = touched.get(identity) ?? new Set<string>();
    section('commits', commitRows(own, identity));
    const coupled: HistoryRow[] = [];
    for (const [key, changes] of touched) {
      if (key === identity) continue;
      const both = [...own].filter((commit) => changes.has(commit)).length;
      if (both < 2) continue;
      const other = entities.get(key); if (other === undefined) continue;
      coupled.push({ ...row(other), figures: [{ kind: 'both', value: String(both) }, { kind: 'onlyThis', value: String(own.size - both) }, { kind: 'onlyOther', value: String(changes.size - both) }] });
    }
    coupled.sort((a, b) => Number(b.figures[0]!.value) - Number(a.figures[0]!.value) || byCodePoint(a.entity!.id, b.entity!.id));
    section('coupling', coupled, evidence.couplingTotal ?? coupled.length);
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

  if (shape === 'membership') {
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

  if (shape === 'commit') {
    const parents = edges.filter((edge) => edge.from === subject.key && edge.relation === GIT_WIKI.parent).sort((a, b) => Number(a.properties[GIT_FIELDS.position]) - Number(b.properties[GIT_FIELDS.position]));
    section('parents', parents.flatMap((edge) => {
      const parent = entities.get(edge.to);
      if (parent === undefined) return [];
      const churn = churnByCommit.get(parent.key);
      const author = entities.get(authorOf.get(parent.key) ?? '');
      return [{
        ...row(parent),
        when: day(parent.properties[GIT_FIELDS.effectiveAt]),
        ...(author === undefined ? {} : { who: String(author.properties[GIT_FIELDS.name] ?? author.label) }),
        figures: churn === undefined ? [] : [
          { kind: 'files' as const, value: String(churn.files) },
          ...(churn.added === 0 ? [] : [{ kind: 'added' as const, value: String(churn.added) }]),
          ...(churn.removed === 0 ? [] : [{ kind: 'removed' as const, value: String(churn.removed) }]),
        ],
      }];
    }));
    sections.push({ role: 'summary', total: 1, rows: [{ text: '', figures: (['authoredAt', 'committedAt', 'effectiveAt'] as const).flatMap((kind) => typeof subject.properties[kind] === 'string' ? [{ kind, value: String(subject.properties[kind]) }] : []) }] });
    const first = entities.get(parents[0]?.to ?? '');
    if (first !== undefined && String(subject.properties[GIT_FIELDS.committedAt]) <= String(first.properties[GIT_FIELDS.committedAt])) notes.push({ key: 'dateAnomaly', args: { parent: String(first.properties[GIT_FIELDS.committedAt]) } });
    if (subject.properties['merge'] === true) {
      if (typeof subject.properties['mergedBranch'] === 'string') notes.push({ key: 'mergeBranch', args: { branch: subject.properties['mergedBranch'], date: day(subject.properties[GIT_FIELDS.effectiveAt]) } });
      const ancestry = (key: string): Set<string> => {
        const result = new Set<string>(); const pending = [key];
        while (pending.length > 0) { const one = pending.pop()!; if (result.has(one)) continue; result.add(one); for (const edge of edges) if (edge.from === one && edge.relation === GIT_WIKI.parent) pending.push(edge.to); }
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
