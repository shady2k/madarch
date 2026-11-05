/**
 * The names one file mentions, as the file pass publishes them and the
 * resolution stage reads them (decision 0033, items 5, 14 and 15).
 *
 * **What a mention is.** One place where a file's bytes write a name that may
 * name a symbol: a call's callee, an `extends` or an `implements` clause, or an
 * ordinary mention (`recordMention` of `resolution-extract.ts`, whose reader the
 * syntax stage runs on the tree it already made). That reader answers what the
 * bytes say, and nothing about what the name means: item 14 gives the file pass
 * the writing, and the meaning is the resolution stage's, resolved against the
 * graph by global name.
 *
 * **Why a node and not a fact.** The mention is the extractors' own reading of
 * a place (`code.*`, item 7) and the fill's fact schema has no kind for it: it
 * holds the *resolved* occurrence (`occurrence`, which names a symbol) and the
 * edges folded from mentions, never a mention as written. So the file pass
 * publishes it as the graph node `code.mention`, keyed by the digest of the
 * place and the name it writes, with one `code.mentions` edge from the file —
 * which is how a stage reads its file's mentions back: one bounded
 * neighbourhood of the file node.
 *
 * **The binding.** A mention of a name an import binds carries the import as
 * the file wrote it — the local name, the specifier, the form, and the file of
 * the pinned tree the specifier answers, with the key its node carries. That is
 * the same resolution the syntax stage already made for its `import` edges; it
 * is recorded per bound name here because a resolution stage that read no bytes
 * has no tree to resolve a specifier against (item 5: one file's mentions and
 * imports as written, and bounded graph queries).
 */
import { canonicalJsonDigest } from '../../model/canonical.js';
import { byCodePoint } from '../../model/order.js';
import { isRepositoryPath, type FactRange, type FactSource } from '../facts.js';
import type { ExtractedResolutionImport, ExtractedResolutionMention, MentionUse } from './resolution-extract.js';
import type { StaticGraphNode } from './static-context.js';
import type { StaticEdgeDraft, StaticNodeDraft } from './static-graph.js';

/** The node kind one mention is published as, and the relation that hangs it from its file. */
export const MENTION_NODE_KIND = 'code.mention';
export const MENTION_RELATION = 'code.mentions';

/** The schema version of the mention's node properties: one mention's place, name and binding as written. */
export const MENTION_SCHEMA_VERSION = 1;

/** The ways a mention is written, as the properties hold them, in code point order. */
const MENTION_ACCESS: readonly string[] = ['read-access', 'write-access'];

/** One import a mention is bound by, as the file wrote it and as the pinned tree answered it. */
export interface MentionBinding {
  /** The local name the import binds (`c` for `import { b as c }`). */
  readonly local: string;
  /** The specifier as written, without its quotes. */
  readonly specifier: string;
  /** What the bound name stands for in the target file. */
  readonly form: 'default' | 'named' | 'namespace';
  /** The name in the target file a `named` import stands for. */
  readonly name?: string;
  /** The file of the pinned tree the specifier answers. */
  readonly target: string;
  /** The key the target file's node carries: what a resolution asks the graph by. */
  readonly targetKey: string;
}

/**
 * The key one mention is published and asked by: the digest of what the mention
 * is (the repository, the file, the name, the use, the access and the byte span
 * the name stands at), and nothing of a run, a unit or a time.
 */
function mentionKeyOf(input: {
  readonly repository: string;
  readonly path: string;
  readonly name: string;
  readonly use: MentionUse;
  readonly access: string;
  readonly through?: string;
  readonly startByte: number;
  readonly endByte: number;
}): string {
  return `mention:${canonicalJsonDigest({
    repository: input.repository,
    file: input.path,
    name: input.name,
    use: input.use,
    access: input.access,
    through: input.through ?? null,
    start: input.startByte,
    end: input.endByte,
  })}`;
}

/** Where a mention's name stands: the range the graph holds, lines and columns, and the byte span a position is. */
function rangeOf(mention: ExtractedResolutionMention): FactRange {
  return {
    startLine: mention.span.startLine,
    startColumn: mention.span.startColumn,
    endLine: mention.span.endLine,
    endColumn: mention.span.endColumn,
    startByte: mention.span.startByte,
    endByte: mention.span.endByte,
  };
}

/** The properties one mention's node carries: everything the resolution stage reads, and no machine path. */
function propertiesOf(input: {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly source: FactSource;
  readonly mention: ExtractedResolutionMention;
  readonly key: string;
  readonly binding?: MentionBinding;
}): Record<string, unknown> {
  const { mention, binding } = input;
  const range = rangeOf(mention);
  return {
    factKind: 'mention',
    repository: input.repository,
    file: input.path,
    name: mention.name,
    use: mention.use,
    access: mention.access,
    ...(mention.through === undefined ? {} : { through: mention.through }),
    parameterBound: mention.parameterBound,
    range,
    ...(binding === undefined ? {} : {
      binding: {
        local: binding.local,
        specifier: binding.specifier,
        form: binding.form,
        ...(binding.name === undefined ? {} : { name: binding.name }),
        target: binding.target,
        targetKey: binding.targetKey,
      },
    }),
    recordKey: input.key,
    layer: 'extracted',
    status: 'proposed',
    provenance: {
      source: { system: input.source.system, version: input.source.version },
      repository: { id: input.repository, commit: input.commit },
      place: { file: input.path, range },
    },
  };
}

/** One mention's node, and the edge that hangs it from its file. */
export interface MentionDrafts {
  readonly node: StaticNodeDraft;
  readonly edge: StaticEdgeDraft;
}

/**
 * The graph items one mention makes: its `code.mention` node, labelled by the
 * name as written, and the `code.mentions` edge from the file's node to it. The
 * file's key is the one its node carries, so the edge joins the node the
 * snapshot stage published for that path.
 */
export function mentionDraftsOf(input: {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly source: FactSource;
  readonly mention: ExtractedResolutionMention;
  readonly binding?: MentionBinding;
  readonly fileKey: string;
}): MentionDrafts {
  const key = mentionKeyOf({
    repository: input.repository,
    path: input.path,
    name: input.mention.name,
    use: input.mention.use,
    access: input.mention.access,
    ...(input.mention.through === undefined ? {} : { through: input.mention.through }),
    startByte: input.mention.span.startByte,
    endByte: input.mention.span.endByte,
  });
  return {
    node: { key, kind: MENTION_NODE_KIND, label: input.mention.name, properties: propertiesOf({ ...input, key }) },
    edge: {
      relation: MENTION_RELATION,
      from: { key: input.fileKey },
      to: { key },
      properties: { factKind: 'mention', repository: input.repository, file: input.path },
    },
  };
}

/** The binding one mention stands on, read from the imports the file wrote and the files the pinned tree holds. */
export function bindingOfMention(
  mention: ExtractedResolutionMention,
  imports: readonly ExtractedResolutionImport[],
  targetOf: (specifier: string) => { readonly path: string; readonly key: string } | undefined,
): MentionBinding | undefined {
  const local = mention.through ?? mention.name;
  const held = imports.filter((entry) => entry.local === local);
  if (held.length === 0) return undefined;
  // One local name is bound once per file in every language this stage reads; two
  // bindings of one name are a file whose meaning this reader cannot state, and the
  // mention then names nothing rather than one of them by order.
  if (held.length > 1) {
    throw new Error(`the file ${JSON.stringify(mention.name)} binds the local name ${JSON.stringify(local)} ${String(held.length)} times, and one name a file binds once is what a mention stands on: the mention at line ${String(mention.span.startLine)} (src/fill/stages/mention-graph.ts)`);
  }
  const entry = held[0]!;
  const target = targetOf(entry.specifier);
  // A specifier that names no file of this repository binds no file: a package's
  // symbol is not in the graph, and a relative specifier that answers nothing is the
  // file's coverage gap (the syntax stage names it) rather than a mention this reader
  // could tie to a node.
  if (target === undefined) return undefined;
  return {
    local: entry.local,
    specifier: entry.specifier,
    form: entry.imported.form,
    ...(entry.imported.form === 'named' ? { name: entry.imported.name } : {}),
    target: target.path,
    targetKey: target.key,
  };
}

/** One mention read back from the graph, as the resolution stage reasons over it. */
export interface MentionRow {
  /** The key the node carries: the mention's identity, recorded on the edges it causes. */
  readonly key: string;
  readonly name: string;
  readonly use: MentionUse;
  readonly access: string;
  readonly through?: string;
  readonly parameterBound: boolean;
  readonly range: FactRange;
  readonly binding?: MentionBinding;
}

/** The mention uses a node may name, as the extractor writes them. */
const MENTION_USES: readonly MentionUse[] = ['call', 'extends', 'implements', 'mention'];

/** A non-empty text at a path, or the refusal naming the node, the field and the read. */
function textAt(value: unknown, field: string, nodeId: string, read: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`the read ${read} answered the mention node ${nodeId}, and its ${field} is ${JSON.stringify(value)}: a mention is a non-empty text there (src/fill/stages/mention-graph.ts)`);
  }
  return value;
}

/** The range a mention's node names, refused where it is no range. */
function rangeIn(value: unknown, nodeId: string, read: string): FactRange {
  const held = value === null || typeof value !== 'object' || Array.isArray(value) ? undefined : value as Record<string, unknown>;
  if (held === undefined) {
    throw new Error(`the read ${read} answered the mention node ${nodeId}, and its range is ${JSON.stringify(value)}: a mention stands at a range of whole lines and columns (src/fill/stages/mention-graph.ts)`);
  }
  for (const field of ['startLine', 'startColumn', 'endLine', 'endColumn'] as const) {
    const number = held[field];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 0) {
      throw new Error(`the read ${read} answered the mention node ${nodeId}, and its range.${field} is ${JSON.stringify(number)}: a range is whole numbers from 0 (src/fill/stages/mention-graph.ts)`);
    }
  }
  const startByte = held['startByte'];
  const endByte = held['endByte'];
  if (typeof startByte !== 'number' || !Number.isInteger(startByte) || startByte < 0 || typeof endByte !== 'number' || !Number.isInteger(endByte) || endByte <= startByte) {
    throw new Error(`the read ${read} answered the mention node ${nodeId}, and its byte span [${String(startByte)}, ${String(endByte)}) is no span: 0 <= start < end (src/fill/stages/mention-graph.ts)`);
  }
  return {
    startLine: held['startLine'] as number,
    startColumn: held['startColumn'] as number,
    endLine: held['endLine'] as number,
    endColumn: held['endColumn'] as number,
    startByte,
    endByte,
  };
}

/** The binding a mention's node carries, refused where it names no file of the graph. */
function bindingIn(value: unknown, nodeId: string, read: string): MentionBinding | undefined {
  if (value === undefined) return undefined;
  const held = value === null || typeof value !== 'object' || Array.isArray(value) ? undefined : value as Record<string, unknown>;
  if (held === undefined) {
    throw new Error(`the read ${read} answered the mention node ${nodeId}, and its binding is ${JSON.stringify(value)}: a binding is an object naming the import a name stands on (src/fill/stages/mention-graph.ts)`);
  }
  const local = textAt(held['local'], 'binding.local', nodeId, read);
  const specifier = textAt(held['specifier'], 'binding.specifier', nodeId, read);
  const form = held['form'];
  if (form !== 'default' && form !== 'named' && form !== 'namespace') {
    throw new Error(`the read ${read} answered the mention node ${nodeId}, and its binding.form is ${JSON.stringify(form)}: an import binds a default name, a named one or a namespace (src/fill/stages/mention-graph.ts)`);
  }
  const name = form === 'named' ? textAt(held['name'], 'binding.name', nodeId, read) : undefined;
  const target = textAt(held['target'], 'binding.target', nodeId, read);
  if (!isRepositoryPath(target)) {
    throw new Error(`the read ${read} answered the mention node ${nodeId}, and its binding.target ${JSON.stringify(target)} is no repository path (src/fill/stages/mention-graph.ts)`);
  }
  const targetKey = textAt(held['targetKey'], 'binding.targetKey', nodeId, read);
  return { local, specifier, form, ...(name === undefined ? {} : { name }), target, targetKey };
}

/**
 * One mention read back from the graph: the node kind, the name, the use and
 * the access the extractor wrote, the place it stands at and, where the file
 * imports the name, the import it is bound by. Every way a node can be wrong is
 * refused by name — the node, the field and the read it came from — so a
 * resolution never reasons over half a mention.
 */
function mentionRowOf(node: StaticGraphNode, read: string): MentionRow {
  if (node.kind !== MENTION_NODE_KIND) {
    throw new Error(`the read ${read} answered a ${JSON.stringify(node.kind)} node (${node.id}) where it was asked for the file's mentions: a mention is a ${JSON.stringify(MENTION_NODE_KIND)} node (src/fill/stages/mention-graph.ts)`);
  }
  const held = node.properties;
  const key = textAt(held['recordKey'], 'recordKey', node.id, read);
  if (key !== node.properties['recordKey']) {
    throw new Error(`the read ${read} answered the mention node ${node.id} with the key ${JSON.stringify(key)} (src/fill/stages/mention-graph.ts)`);
  }
  const name = textAt(held['name'], 'name', node.id, read);
  const use = held['use'];
  if (typeof use !== 'string' || !(MENTION_USES as readonly string[]).includes(use)) {
    throw new Error(`the read ${read} answered the mention node ${node.id}, and its use is ${JSON.stringify(use)}: a mention is a ${MENTION_USES.join(', ')} (src/fill/stages/mention-graph.ts)`);
  }
  const access = held['access'];
  if (typeof access !== 'string' || !MENTION_ACCESS.includes(access)) {
    throw new Error(`the read ${read} answered the mention node ${node.id}, and its access is ${JSON.stringify(access)}: a mention reads or writes the name, ${MENTION_ACCESS.join(' or ')} (src/fill/stages/mention-graph.ts)`);
  }
  const through = held['through'];
  if (through !== undefined && (typeof through !== 'string' || through.trim() === '')) {
    throw new Error(`the read ${read} answered the mention node ${node.id}, and its through is ${JSON.stringify(through)}: a name reached through a namespace names it (src/fill/stages/mention-graph.ts)`);
  }
  const parameterBound = held['parameterBound'];
  if (typeof parameterBound !== 'boolean') {
    throw new Error(`the read ${read} answered the mention node ${node.id}, and its parameterBound is ${JSON.stringify(parameterBound)}: whether a parameter binds the name is a true or a false (src/fill/stages/mention-graph.ts)`);
  }
  const binding = bindingIn(held['binding'], node.id, read);
  return {
    key,
    name,
    use: use as MentionUse,
    access,
    ...(through === undefined ? {} : { through }),
    parameterBound,
    range: rangeIn(held['range'], node.id, read),
    ...(binding === undefined ? {} : { binding }),
  };
}

/** The mentions of one page, in code point order of their keys: what a page of the file's neighbourhood answered. */
export function mentionRowsIn(nodes: readonly StaticGraphNode[], read: string): readonly MentionRow[] {
  return nodes.map((node) => mentionRowOf(node, read)).sort((left, right) => byCodePoint(left.key, right.key));
}
