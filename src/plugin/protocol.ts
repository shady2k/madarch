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
export const PluginKeyValues = Type.Record(Type.String({ minLength: 1 }), Type.Union([Type.String(), Type.Number()]), {
  description: 'The key fields of one entity: field name to its value, as the kind\'s contract declares them.',
});

/** A reference inside a key: the kind and the key values of the entity it names. */
export const PluginEntityRef = Type.Object(
  {
    kind: Type.String({ minLength: 1, description: 'The referenced kind, one of its contract\'s vertex kinds.' }),
    key: PluginKeyValues,
  },
  { additionalProperties: false, description: 'One entity named by its kind and key values, the way a result names its ends.' },
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
    required: Type.Boolean({ description: 'Whether the plugin cannot run without it: a kind\'s natural key and every field its reading needs.' }),
  },
  { additionalProperties: false, description: 'One field of a declared kind: its type, its meaning, an example and whether it is required. Every value a producer states of it is an opinion.' },
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

/**
 * The rights a plugin asks for (decision 0035, item 9): the network profile, whether it reads the graph through the
 * host's queries, and whether it may see the repository snapshot at all. A right it does not declare is one the host
 * grants it nothing for: only the files producer — the reader of the source filesystem and git — declares the
 * repository, and the glossary reads the file vertices and their content from the graph, never a folder.
 */
export const PluginRights = Type.Object(
  {
    network: Type.Union([Type.Literal('none')], { description: 'The network profile. "none" is the only one this build runs: the network namespace is unshared and socket creation refused.' }),
    graph: Type.Optional(Type.Boolean({ description: 'Whether the plugin reads the graph through the host\'s read-only queries (`graph.files`, `graph.value`); absent, it may not.' })),
    filesystem: Type.Optional(Type.Boolean({ description: 'Whether the plugin sees the repository snapshot read-only at /repo; absent, it sees no repository at all.' })),
  },
  { additionalProperties: false, description: 'The rights a plugin declares it needs: its network profile, graph reads and the repository snapshot.' },
);

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
  },
  { additionalProperties: false, description: 'A plugin folder\'s contract: its id, its version and the outputs its introduction declares.' },
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
  },
  { additionalProperties: false, description: 'The plugin\'s introduction: its contract, version, rights and limits.' },
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
const GraphFilesMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('graph.files'), params: PluginGraphFilesRequest }, { additionalProperties: false, description: 'The plugin asks the host for the file vertices whose path matches a pattern.' });
const GraphValueMessage = Type.Object({ jsonrpc: Type.Literal('2.0'), id: RpcId, method: Type.Literal('graph.value'), params: PluginGraphValueRequest }, { additionalProperties: false, description: 'The plugin asks the host for one field of one vertex.' });

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
    GraphFilesMessage,
    GraphValueMessage,
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
export type PluginEntityRef = Static<typeof PluginEntityRef>;
export type PluginContractDeclaration = Static<typeof PluginContractDeclaration>;
export type PluginVertexKindDeclaration = Static<typeof PluginVertexKindDeclaration>;
export type PluginEdgeKindDeclaration = Static<typeof PluginEdgeKindDeclaration>;
export type PluginFieldDeclaration = Static<typeof PluginFieldDeclaration>;
export type PluginContractFile = Static<typeof PluginContractFile>;
export type PluginGraphFilesRequest = Static<typeof PluginGraphFilesRequest>;
export type PluginGraphValueRequest = Static<typeof PluginGraphValueRequest>;
export type PluginKeyValues = Static<typeof PluginKeyValues>;
export type PluginHeartbeat = Static<typeof PluginHeartbeat>;
export type PluginProgress = Static<typeof PluginProgress>;
export type PluginErrorReport = Static<typeof PluginErrorReport>;
export type PluginLimits = Static<typeof PluginLimits>;
export type PluginRights = Static<typeof PluginRights>;
