/**
 * The host/plugin protocol (decision 0035, item 7): JSON-RPC 2.0 in newline
 * delimited JSON over the plugin's standard input and output. This module is
 * the one source of the message shapes; `schema/plugin-protocol.schema.json`
 * is rendered from it (`Type.Union` below) and test/plugin-protocol.test.ts
 * refuses a file that went stale.
 *
 * A plugin introduces itself with its contract (the kinds, key fields and
 * attributes it produces), its version, the rights it needs and its limits.
 * The host hands it units; for a unit it answers with vertices, edges —
 * addressed by kind and key values, never by node ids — one list of field values
 * per entity with the evidence it stands on (every value is an opinion, and no
 * field is authoritative), removals of what the unit's input no longer holds,
 * and the unit's end, complete or partial with the cause. Progress, heartbeats
 * and errors travel the same channel.
 *
 * Version 2 (2026-11-10) removed the `claim: authoritative | claimed` marker: a
 * declared field is a field, and a result states its value like any other opinion.
 *
 * Nothing in a message names a madarch kind: the catalogue is the product's
 * data, so every kind here is a string the plugin declared.
 */
import { Type, type Static } from 'typebox';

/** The protocol's version: the introduction names it, and a host refuses any other. */
export const PROTOCOL_VERSION = 'madarch.plugins/2';

/** The version of the documents themselves (the schema's `$id` carries it too). */
export const PROTOCOL_CONTRACT = 2;

/** The JSON schema's one address, whatever host renders it. */
export const PROTOCOL_SCHEMA_ID = `https://github.com/shady2k/madarch/schema/v${String(PROTOCOL_CONTRACT)}/plugin-protocol.schema.json`;

/** A JSON-RPC id: the host numbers its requests, and a plugin may answer with a string of its own. */
const RpcId = Type.Union([Type.String({ minLength: 1 }), Type.Integer()]);

/** A key's values: an entity is named by its kind and these, never by a node id the host hands out. */
export const PluginKeyValues = Type.Cyclic({
  Key: Type.Record(Type.String({ minLength: 1 }), Type.Union([Type.String(), Type.Number(), Type.Ref('Entity')])),
  Entity: Type.Object({ kind: Type.String({ minLength: 1 }), key: Type.Ref('Key') }, { additionalProperties: false }),
}, 'Key', { description: 'Natural key values, including referenced entities by kind and key.' });

/** A reference inside a key: the kind and the key values of the entity it names. */
export const PluginEntityRef = Type.Object(
  { kind: Type.String({ minLength: 1 }), key: PluginKeyValues },
  { additionalProperties: false, description: 'One entity named by its kind and key values.' },
);

/** Where a value came from: a repository, a commit or content digest, a path and the lines it was read at. */
export const PluginEvidence = Type.Object(
  {
    repository: Type.Optional(Type.String({ minLength: 1, description: 'The repository the value was read in, by its name in the product.' })),
    commitOrDigest: Type.Optional(Type.String({ minLength: 1, description: 'The commit or the content digest the value was read at.' })),
    path: Type.Optional(Type.String({ minLength: 1, description: 'The path inside that repository, when the value has one.' })),
    lineStart: Type.Optional(Type.Integer({ minimum: 1, description: 'The first line the value was read at, counted from 1.' })),
    lineEnd: Type.Optional(Type.Integer({ minimum: 1, description: 'The last line the value was read at, counted from 1.' })),
  },
  { additionalProperties: false, description: 'What one value stands on: where it was read, and at which lines.' },
);

/** The values of one edge kind that carries them. */
export const PluginEdgeAttributes = Type.Record(Type.String({ minLength: 1 }), Type.Unknown());

/** One vertex a unit produced. */
export const PluginVertexResult = Type.Object(
  {
    kind: Type.String({ minLength: 1, description: 'The vertex kind, one the plugin\'s contract declares.' }),
    key: PluginKeyValues,
    values: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Unknown(), { description: 'The field values this producer states, by field name: every value is an opinion.' })),
    evidence: Type.Optional(PluginEvidence),
  },
  { additionalProperties: false, description: 'One vertex a unit produced: its kind, its key and the field values of one opinion with its evidence.' },
);

/** One edge a unit produced. */
export const PluginEdgeResult = Type.Object(
  {
    kind: Type.String({ minLength: 1, description: 'The edge kind, one the plugin\'s contract declares.' }),
    from: PluginEntityRef,
    to: PluginEntityRef,
    discriminator: Type.Optional(Type.String({ description: 'What tells repeats between the same ends apart; an empty string where the kind does not repeat.' })),
    values: Type.Optional(PluginEdgeAttributes),
    evidence: Type.Optional(PluginEvidence),
  },
  { additionalProperties: false, description: 'One edge a unit produced: its kind, its ends by kind and key, and the values of one opinion with what they stand on.' },
);

/** One thing the unit's input no longer holds: the plugin's earlier output that the host may remove. */
export const PluginRemoval = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    key: PluginKeyValues,
  },
  { additionalProperties: false, description: 'An entity the plugin produced before that the unit\'s input no longer holds.' },
);

/** How a unit ended: complete, or partial with the cause. */
export const PluginUnitEnd = Type.Union(
  [
    Type.Object({ state: Type.Literal('complete') }, { additionalProperties: false, description: 'The unit read everything its input holds.' }),
    Type.Object({ state: Type.Literal('partial'), cause: Type.String({ minLength: 1 }) }, { additionalProperties: false, description: 'The unit stopped short; the cause says why, and the host publishes no removals for it.' }),
  ],
  { description: 'How a unit ended: complete, or partial with the cause.' },
);

/** The answer to one unit: what the plugin found, and how far it got. */
export const PluginUnitResult = Type.Object(
  {
    unitId: Type.String({ minLength: 1 }),
    vertices: Type.Optional(Type.Array(PluginVertexResult)),
    edges: Type.Optional(Type.Array(PluginEdgeResult)),
    removals: Type.Optional(Type.Array(PluginRemoval)),
    end: PluginUnitEnd,
  },
  { additionalProperties: false, description: 'One unit\'s answer: vertices, edges, removals and its end.' },
);

/**
 * One field of a declared kind (decision 0035, item 18): its type, what it
 * means, an example and whether the plugin cannot run without it. The manifest
 * binds a kind's field to one of these (`<plugin>@<major>.<field>`), and the
 * table is built from the pair, so the declaration is the contract half the
 * manifest check holds the product to.
 */
export const PluginFieldDeclaration = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    type: Type.Union(
      [Type.Literal('text'), Type.Literal('integer'), Type.Literal('bigint'), Type.Literal('boolean'), Type.Literal('timestamp'), Type.Literal('json')],
      { description: 'The PostgreSQL type the field is stored as: the manifest binds a field whose type must be this one.' },
    ),
    meaning: Type.String({ minLength: 1, description: 'What the field is, in plain words, for the person binding it in the manifest.' }),
    example: Type.Unknown({ description: 'One value the field holds, as an example.' }),
    reference: Type.Optional(Type.String({ minLength: 1, description: 'The kind a natural-key reference names.' })),
    required: Type.Boolean({ description: 'Whether the plugin cannot run without it: a kind\'s natural key and every field its reading needs.' }),
    evidence: Type.Optional(Type.Boolean({ description: 'Whether an opinion of this field must carry evidence (madarch-stm0.7.1): the host\'s unevidenced read reports an opinion of this field that states none, and a field that declares nothing is not reported.' })),
  },
  { additionalProperties: false, description: 'One field of a declared kind: its type, its meaning, an example, whether it is required and whether its opinions must carry evidence. Every value a producer states of it is an opinion.' },
);

/** One vertex kind the plugin declares it produces. */
export const PluginVertexKindDeclaration = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    // A kind with no natural key stands by a random identity: its declaration names no key field, and a result names an empty key.
    key: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: 'The key fields, in the contract\'s order; none for a kind with no natural key.' })),
    fields: Type.Optional(Type.Array(PluginFieldDeclaration, { description: 'The fields it writes beside the key.' })),
  },
  { additionalProperties: false, description: 'One vertex kind the plugin produces: its name, its key fields and its fields.' },
);

/** One edge kind the plugin declares it produces. */
export const PluginEdgeKindDeclaration = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    from: Type.String({ minLength: 1, description: 'The vertex kind its ends start at.' }),
    to: Type.String({ minLength: 1, description: 'The vertex kind its ends go to.' }),
    fields: Type.Optional(Type.Array(PluginFieldDeclaration)),
  },
  { additionalProperties: false, description: 'One edge kind the plugin produces: its name, the kinds of its ends and its fields.' },
);

/** Everything a plugin declares it produces. */
export const PluginContractDeclaration = Type.Object(
  {
    vertices: Type.Array(PluginVertexKindDeclaration, { description: 'The vertex kinds it produces; a kind it does not declare is refused in a result.' }),
    edges: Type.Array(PluginEdgeKindDeclaration),
  },
  { additionalProperties: false, description: 'The outputs a plugin declares: every kind, field and edge kind a result may name.' },
);

/** One graph read a plugin may declare: its name. */
export const PluginGraphRead = Type.Union(
  [Type.Literal('files'), Type.Literal('value'), Type.Literal('unresolved'), Type.Literal('removedEnds'), Type.Literal('unevidenced')],
  { description: 'One graph read the host answers: files and value are the unit reads, unresolved and removedEnds the writer\'s consistency records, and unevidenced the opinions whose field requires evidence.' },
);

/**
 * The rights a plugin asks for (decision 0035, item 9): the network profile, whether it reads the graph through the
 * host's queries, and whether it may see the repository snapshot at all. A right it does not declare is one the host
 * grants it nothing for: only the files producer — the reader of the source filesystem and git — declares the
 * repository, and the glossary reads the file vertices and their content from the graph, never a folder.
 *
 * `graphReads` names the queries the graph right covers; absent, a plugin that declares `graph: true` reads `files`
 * and `value`, the two reads a unit plugin has always had. A read it does not name is refused by name, so the
 * consistency reads the writer keeps are a capability a plugin has to declare.
 */
export const PluginRights = Type.Object(
  {
    network: Type.Union([Type.Literal('none')], { description: 'The network profile. "none" is the only one this build runs: the network namespace is unshared and socket creation refused.' }),
    graph: Type.Optional(Type.Boolean({ description: 'Whether the plugin reads the graph through the host\'s read-only queries (`graph.files`, `graph.value`, and the reads `graphReads` names); absent, it may not.' })),
    graphReads: Type.Optional(Type.Array(PluginGraphRead, { description: 'The graph reads the right covers: files, value, unresolved, removedEnds and unevidenced; absent, files and value.' })),
    filesystem: Type.Optional(Type.Boolean({ description: 'Whether the plugin sees the repository snapshot read-only at /repo; absent, it sees no repository at all.' })),
  },
  { additionalProperties: false, description: 'The rights a plugin declares it needs: its network profile, graph reads and the repository snapshot.' },
);

/**
 * The graph reads a contract's rights grant: the names it declared, or `files` and `value` for a plugin that declared
 * `graph: true` without naming reads. A plugin that declared no graph right grants none.
 */
export function graphReadsOf(rights: PluginRights | undefined): readonly PluginGraphRead[] {
  if (rights?.graph !== true) return [];
  return rights.graphReads === undefined ? ['files', 'value'] : [...new Set(rights.graphReads)];
}

/**
 * The contract a plugin keeps in its own folder (`contract.json`), the same
 * outputs its introduction sends (decision 0035, items 3, 17 and 18): the
 * manifest check reads this file without running the plugin, so a binding to a
 * field the plugin does not declare, a type that differs or a required field the
 * manifest leaves out is refused before a fill starts. The introduction and this
 * file are one declaration, and a test holds them equal.
 */
export const PluginContractFile = Type.Object(
  {
    id: Type.String({ minLength: 1, pattern: '^[a-z][a-z0-9-]*$', description: 'The plugin\'s id, the same one the manifest declares.' }),
    version: Type.String({ minLength: 1, description: 'The plugin\'s semantic version, the one the lock records.' }),
    outputs: PluginContractDeclaration,
    rights: Type.Optional(PluginRights),
    reads: Type.Optional(Type.Union([Type.Literal('unit'), Type.Literal('whole-graph')], { description: 'What the plugin reads: one unit at a time ("unit", the default), or the whole graph once after every other plugin turn ("whole-graph"). The introduction repeats it.' })),
  },
  { additionalProperties: false, description: 'A plugin folder\'s contract: its id, its version, the outputs its introduction declares and what it reads.' },
);

/** What the plugin declares about its own work. */
export const PluginLimits = Type.Object(
  {
    maxParallelUnits: Type.Optional(Type.Integer({ minimum: 1, maximum: 64, description: 'How many units it takes at once; absent, one.' })),
    maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, description: 'The most one unit\'s answer may weigh; absent, the host\'s own bound.' })),
  },
  { additionalProperties: false, description: 'What a plugin declares about its work: how many units at once, and how much one unit may answer.' },
);

/** The plugin's introduction: who it is, what it speaks, what it produces and what it needs. */
export const PluginIntroduce = Type.Object(
  {
    protocol: Type.Literal(PROTOCOL_VERSION, { description: 'The protocol version this plugin speaks.' }),
    name: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    rights: PluginRights,
    limits: Type.Optional(PluginLimits),
    outputs: PluginContractDeclaration,
    reads: Type.Optional(Type.Union([Type.Literal('unit'), Type.Literal('whole-graph')], { description: 'What the plugin reads: one unit at a time ("unit", the default), or the whole graph once after every other plugin turn ("whole-graph"). A whole-graph plugin is planned once, last, and planned again when anything it read moved.' })),
  },
  { additionalProperties: false, description: 'The plugin\'s introduction: its contract, version, rights, limits and what it reads.' },
);

/** One read-only query of the graph: the file vertices whose path matches a pattern (decision 0035, item 15). */
export const PluginGraphFilesRequest = Type.Object(
  {
    pattern: Type.String({ minLength: 1, description: 'The repository path pattern the file vertices match (`**/glossary*.md`: `*` within a folder, `**` across folders).' }),
  },
  { additionalProperties: false, description: 'A query for the file vertices whose path matches a pattern.' },
);

/** One field of one vertex, read through the host: a file\'s content by its blob, as the files producer stored it. */
export const PluginGraphValueRequest = Type.Object(
  {
    kind: Type.String({ minLength: 1, description: 'The vertex kind, as the wiki names it (`code.file`).' }),
    key: PluginKeyValues,
    field: Type.String({ minLength: 1, description: 'The field the vertex holds (`content`).' }),
  },
  { additionalProperties: false, description: 'A query for one field of one vertex.' },
);

/** One entity the host names in an answer: its kind, its key values and a label a person can read. */
export const PluginGraphAddress = Type.Object(
  {
    kind: Type.String({ minLength: 1, description: 'The entity\'s kind, the graph\'s own name (`code.file`).' }),
    key: PluginKeyValues,
    label: Type.String({ description: 'The entity as a person reads it: its key values joined, or its kind when it has no key.' }),
  },
  { additionalProperties: false, description: 'One entity in a graph answer: its kind, its key and a readable label.' },
);

/** One edge an unresolved reference or a removed end names, with the end that stands. */
export const PluginGraphEdgeAddress = Type.Object(
  {
    kind: Type.String({ minLength: 1 }),
    from: Type.Optional(PluginGraphAddress),
    to: Type.Optional(PluginGraphAddress),
    discriminator: Type.Optional(Type.String()),
  },
  { additionalProperties: false, description: 'An edge by its kind and the ends that stand, when they do.' },
);

/**
 * One reference the writer recorded and no vertex holds (the `unresolved_reference` table): a key reference (a
 * vertex's key field names a missing entity) or an edge end (an edge names a missing entity). The referrer is the
 * vertex whose key holds the reference, or the other end of an edge; `edge` is present only for an edge end.
 */
export const PluginGraphUnresolvedReference = Type.Object(
  {
    id: Type.String({ minLength: 1, description: 'The row\'s own id: two dangling edges of one kind and one target are told apart by it.' }),
    referrer: Type.Optional(PluginGraphAddress),
    edge: Type.Optional(PluginGraphEdgeAddress),
    field: Type.String({ minLength: 1, description: 'The key field or the edge end (`from` or `to`) that names the missing entity.' }),
    target: PluginGraphAddress,
    producer: Type.String({ minLength: 1, description: 'The producer and version that named the reference.' }),
    against: Type.Optional(PluginGraphAddress),
  },
  { additionalProperties: false, description: 'A reference the writer recorded and no vertex holds.' },
);

/** One edge whose end is removed: it stands in the graph, and the vertex it names does not. */
export const PluginGraphRemovedEnd = Type.Object(
  {
    edge: PluginGraphEdgeAddress,
    from: PluginGraphAddress,
    to: PluginGraphAddress,
    removed: Type.Array(Type.Union([Type.Literal('from'), Type.Literal('to')]), { description: 'The ends that are removed.' }),
  },
  { additionalProperties: false, description: 'An edge whose end is removed.' },
);

/** One open opinion that states a field whose contract requires evidence, and rests on none. */
export const PluginGraphUnevidencedOpinion = Type.Object(
  {
    entity: PluginGraphAddress,
    field: Type.String({ minLength: 1 }),
    producer: Type.String({ minLength: 1 }),
    opinion: Type.String({ description: 'The opinion\'s own id, one sequence for the whole graph.' }),
  },
  { additionalProperties: false, description: 'One unevidenced opinion of a field whose contract requires evidence.' },
);

/** The unit the host hands a plugin: what to read, named by kind and key. */
export const PluginUnitRequest = Type.Object(
  {
    unitId: Type.String({ minLength: 1 }),
    kind: Type.String({ minLength: 1, description: 'The kind of the vertex the unit is about.' }),
    key: PluginKeyValues,
    inputs: Type.Optional(Type.Unknown({ description: 'What the host hands with the unit, a shape the plugin\'s contract names.' })),
  },
  { additionalProperties: false, description: 'One unit of work: the entity by kind and key, and what the host hands with it.' },
);

/** One heartbeat: the plugin is alive, with no unit named or with the unit that is running. */
export const PluginHeartbeat = Type.Object(
  { unitId: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false, description: 'A sign of life while a unit runs.' },
);

/** One progress report from a unit. */
export const PluginProgress = Type.Object(
  {
    unitId: Type.String({ minLength: 1 }),
    done: Type.Optional(Type.Number({ minimum: 0 })),
    total: Type.Optional(Type.Number({ minimum: 0 })),
    note: Type.Optional(Type.String()),
  },
  { additionalProperties: false, description: 'Where a unit stands, in counts of what it reads, with a note a person may read.' },
);

/** One error a plugin reports, with its cause. */
export const PluginErrorReport = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    unitId: Type.Optional(Type.String({ minLength: 1 })),
    file: Type.Optional(Type.String({ minLength: 1 })),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false, description: 'An error inside the plugin: its cause, where it happened, and the unit it belongs to.' },
);

/** The reason a JSON-RPC call failed. */
export const PluginRpcError = Type.Object(
  {
    code: Type.Integer(),
    message: Type.String({ minLength: 1 }),
    data: Type.Optional(Type.Object({ cause: Type.Optional(Type.String({ minLength: 1 })), unitId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

/** One request either side makes, with its own params: the shapes above, one message each. */
const IntroduceRequest = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('introduce'), params: PluginIntroduce }, { additionalProperties: false, description: 'The plugin introduces itself: protocol, name, version, rights, limits and outputs.' });
const UnitRequestMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('unit'), params: Type.Object({ unit: PluginUnitRequest }, { additionalProperties: false }) }, { additionalProperties: false, description: 'The host hands the plugin one unit.' });
const ControlRequest = (method: 'pause' | 'resume' | 'stop') => Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal(method), params: Type.Optional(Type.Unknown()) }, { additionalProperties: false, description: `The host asks the plugin to ${method}.` });
export const PluginAgentRunRequest = Type.Object({ unitId: Type.String({ minLength: 1 }), task: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
const AgentRunMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('agent.run'), params: PluginAgentRunRequest }, { additionalProperties: false });
const GraphFilesMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('graph.files'), params: PluginGraphFilesRequest }, { additionalProperties: false, description: 'The plugin asks the host for the file vertices whose path matches a pattern.' });
const GraphValueMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('graph.value'), params: PluginGraphValueRequest }, { additionalProperties: false, description: 'The plugin asks the host for one field of one vertex.' });
/**
 * One page of the writer's consistency records: the cursor a previous answer named, and the most rows this page may
 * hold. The host bounds the size, so a plugin walks a large store one page at a time.
 */
export const PluginGraphPageRequest = Type.Object(
  {
    after: Type.Optional(Type.String({ description: 'The cursor the previous answer named; absent, the first page.' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000, description: 'The most rows this page may hold; the host bounds it.' })),
  },
  { additionalProperties: false, description: 'One page asked of a consistency read: a cursor and a bound.' },
);
const GraphUnresolvedMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('graph.unresolved'), params: PluginGraphPageRequest }, { additionalProperties: false, description: 'The plugin asks the host for one page of the references the writer recorded and no vertex holds.' });
const GraphRemovedEndsMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('graph.removedEnds'), params: PluginGraphPageRequest }, { additionalProperties: false, description: 'The plugin asks the host for one page of the edges whose end is removed.' });
const GraphUnevidencedMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('graph.unevidenced'), params: PluginGraphPageRequest }, { additionalProperties: false, description: 'The plugin asks the host for one page of the open opinions of fields whose contract requires evidence and that state none.' });

/** One notification either side sends, with its own params. */
const HeartbeatMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), method: Type.Literal('heartbeat'), params: Type.Optional(PluginHeartbeat) }, { additionalProperties: false, description: 'The plugin is alive while a unit runs.' });
const ProgressMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), method: Type.Literal('progress'), params: PluginProgress }, { additionalProperties: false, description: 'Where one unit stands.' });
const ErrorMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), method: Type.Literal('error'), params: PluginErrorReport }, { additionalProperties: false, description: 'An error inside the plugin, with its cause.' });
const CancelMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), method: Type.Literal('cancel') }, { additionalProperties: false, description: 'The host cancels the plugin: the whole tree is killed.' });

/** The answer to a request that succeeded. */
const SuccessMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, result: Type.Unknown({ description: 'The result of a request; for a unit, a PluginUnitResult.' }) }, { additionalProperties: false, description: 'A request\'s answer, succeeded.' });

/** The answer to a request that failed. */
const FailureMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: Type.Union([RpcId, Type.Null()]), error: PluginRpcError }, { additionalProperties: false, description: 'A request\'s answer, failed, with the cause in the error\'s data.' });

/** Every message of the protocol, as the published schema states them. */
export const PluginProtocolMessage = Type.Union(
  [
    IntroduceRequest,
    UnitRequestMessage,
    AgentRunMessage,
    GraphFilesMessage,
    GraphValueMessage,
    GraphUnresolvedMessage,
    GraphRemovedEndsMessage,
    GraphUnevidencedMessage,
    ControlRequest('pause'),
    ControlRequest('resume'),
    ControlRequest('stop'),
    HeartbeatMessage,
    ProgressMessage,
    ErrorMessage,
    CancelMessage,
    SuccessMessage,
    FailureMessage,
  ],
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: PROTOCOL_SCHEMA_ID,
    title: 'Madarch extraction plugin protocol',
    description:
      'One message of the host/plugin protocol, contract version 1: JSON-RPC 2.0 over newline delimited JSON on the plugin\'s standard input and output. The plugin introduces itself (introduce), the host hands it units (unit), and the plugin answers with a PluginUnitResult, progress, heartbeats and errors. Every kind and field a message names is declared in the introduction\'s outputs. The host asks pause, resume and stop, and sends cancel; a pause suspends the heartbeat deadline, a stop asks for the unit to finish and the plugin to exit, and a cancel kills the whole tree.',
  },
);

export type PluginIntroduce = Static<typeof PluginIntroduce>;
export type PluginUnitRequest = Static<typeof PluginUnitRequest>;
export type PluginUnitResult = Static<typeof PluginUnitResult>;
export type PluginUnitEnd = Static<typeof PluginUnitEnd>;
export type PluginVertexResult = Static<typeof PluginVertexResult>;
export type PluginEdgeResult = Static<typeof PluginEdgeResult>;
export type PluginRemoval = Static<typeof PluginRemoval>;
export type PluginEvidence = Static<typeof PluginEvidence>;
export interface PluginEntityRef { readonly kind: string; readonly key: PluginKeyValues; }
export type PluginContractDeclaration = Static<typeof PluginContractDeclaration>;
export type PluginVertexKindDeclaration = Static<typeof PluginVertexKindDeclaration>;
export type PluginEdgeKindDeclaration = Static<typeof PluginEdgeKindDeclaration>;
export type PluginFieldDeclaration = Static<typeof PluginFieldDeclaration>;
export type PluginContractFile = Static<typeof PluginContractFile>;
export type PluginGraphFilesRequest = Static<typeof PluginGraphFilesRequest>;
export type PluginGraphValueRequest = Static<typeof PluginGraphValueRequest>;
export type PluginGraphPageRequest = Static<typeof PluginGraphPageRequest>;
export type PluginGraphAddress = Static<typeof PluginGraphAddress>;
export type PluginGraphEdgeAddress = Static<typeof PluginGraphEdgeAddress>;
export type PluginGraphUnresolvedReference = Static<typeof PluginGraphUnresolvedReference>;
export type PluginGraphRemovedEnd = Static<typeof PluginGraphRemovedEnd>;
export type PluginGraphUnevidencedOpinion = Static<typeof PluginGraphUnevidencedOpinion>;
export type PluginGraphRead = Static<typeof PluginGraphRead>;
export type PluginKeyValues = { readonly [field: string]: string | number | PluginEntityRef };
export type PluginHeartbeat = Static<typeof PluginHeartbeat>;
export type PluginProgress = Static<typeof PluginProgress>;
export type PluginErrorReport = Static<typeof PluginErrorReport>;
export type PluginLimits = Static<typeof PluginLimits>;
export type PluginRights = Static<typeof PluginRights>;
