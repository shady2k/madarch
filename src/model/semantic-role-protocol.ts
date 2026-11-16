import { Type } from 'typebox';
import { Value } from 'typebox/value';

/** Engine projection slots. Catalogue descriptors map their own vocabulary into these checked roles. */
export const ROLE_BINDING_SCHEMA = Type.Union([
  Type.Object({ role: Type.Literal('document'), properties: Type.Object({ path: Type.String(), content: Type.String(), anchors: Type.Record(Type.String(), Type.Object({ title: Type.String(), start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }), markdown: Type.String() }, { additionalProperties: false })), repository: Type.Array(Type.String(), { 'x-semantic-edge': true }), commit: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('source'), properties: Type.Object({ path: Type.String(), content: Type.Union([Type.String(), Type.Null()]), repository: Type.Array(Type.String(), { 'x-semantic-edge': true }), commit: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('evidence-support'), properties: Type.Object({ about: Type.Array(Type.String(), { 'x-semantic-edge': true }) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('repository'), properties: Type.Object({ contains: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })), history: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })), asIs: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })), name: Type.Optional(Type.Union([Type.String(), Type.Null()])), url: Type.Optional(Type.Union([Type.String(), Type.Null()])), default_branch: Type.Optional(Type.Union([Type.String(), Type.Null()])), history_shallow: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])), tree_snapshot: Type.Optional(Type.Union([Type.String(), Type.Null()])) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('file'), properties: Type.Object({ repository: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })), renamedFrom: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })), path: Type.Optional(Type.Union([Type.String(), Type.Null()])), mode: Type.Optional(Type.Union([Type.String(), Type.Null()])), blob: Type.Optional(Type.Union([Type.String(), Type.Null()])), bytes: Type.Optional(Type.Union([Type.Number(), Type.Null()])), form: Type.Optional(Type.Union([Type.String(), Type.Null()])), lines: Type.Optional(Type.Union([Type.Number(), Type.Null()])), language: Type.Optional(Type.Union([Type.String(), Type.Null()])), languages: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])), content: Type.Optional(Type.Union([Type.String(), Type.Null()])) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('commit'), properties: Type.Object({ parent: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })), touched: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })), hash: Type.Optional(Type.Union([Type.String(), Type.Null()])), subject: Type.Optional(Type.Union([Type.String(), Type.Null()])), author_date: Type.Optional(Type.Union([Type.String(), Type.Null()])), author_offset_min: Type.Optional(Type.Union([Type.Number(), Type.Null()])), commit_date: Type.Optional(Type.Union([Type.String(), Type.Null()])), commit_offset_min: Type.Optional(Type.Union([Type.Number(), Type.Null()])) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('author'), properties: Type.Object({ authored: Type.Optional(Type.Array(Type.String(), { 'x-semantic-edge': true })), name: Type.Optional(Type.Union([Type.String(), Type.Null()])), email: Type.Optional(Type.Union([Type.String(), Type.Null()])) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('directory'), properties: Type.Object({  }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('repository.history'), properties: Type.Object({ walk: Type.Optional(Type.Integer()) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('commit.parent'), properties: Type.Object({ position: Type.Optional(Type.Integer()) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('question-claim'), properties: Type.Object({ ordinal: Type.Integer(), claimText: Type.String(), parentKeys: Type.Array(Type.String(), { 'x-semantic-edge': true }) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('question'), properties: Type.Object({ file: Type.String(), language: Type.String(), questionType: Type.String(), status: Type.String(), questionText: Type.String(), why: Type.String(), answerText: Type.Union([Type.String(), Type.Null()]), askedAt: Type.String(), resolvedAt: Type.Union([Type.String(), Type.Null()]), presentationSlug: Type.String(), about: Type.Array(Type.String(), { 'x-semantic-edge': true }), resolvedBy: Type.Array(Type.String(), { 'x-semantic-edge': true }) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('correction'), properties: Type.Object({ file: Type.String(), status: Type.String(), statementText: Type.String(), reason: Type.String(), at: Type.String(), resolvedAt: Type.Union([Type.String(), Type.Null()]), presentationSlug: Type.String(), about: Type.Array(Type.String(), { 'x-semantic-edge': true }), resolvedBy: Type.Array(Type.String(), { 'x-semantic-edge': true }) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('problem-task'), properties: Type.Object({ title: Type.String(), description: Type.Optional(Type.String()), status: Type.Optional(Type.String()), tracker: Type.Optional(Type.String()), key: Type.Optional(Type.String()), problems: Type.Array(Type.String(), { 'x-semantic-edge': true }) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('detector-cycle'), properties: Type.Object({ cycleLevel: Type.String(), memberKeys: Type.Array(Type.String(), { 'x-semantic-edge': true }) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('detector-route'), properties: Type.Object({ path: Type.String(), method: Type.String(), ownerKeys: Type.Array(Type.String(), { 'x-semantic-edge': true }), handlerKeys: Type.Array(Type.String(), { 'x-semantic-edge': true }) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('detector-operation'), properties: Type.Object({ path: Type.String(), openToCallers: Type.Boolean(), contractKeys: Type.Array(Type.String(), { 'x-semantic-edge': true }) }, { additionalProperties: false }) }),
  Type.Object({ role: Type.Literal('detector-debt'), properties: Type.Object({ markerWord: Type.String(), text: Type.String(), path: Type.String(), line: Type.Number() }, { additionalProperties: false }) }),
]);

export function semanticRoleFields(role: string): string[] {
  const schema = ROLE_BINDING_SCHEMA.anyOf.find((schema) => schema.properties.role.const === role);
  if (schema === undefined) throw new Error(`unknown engine semantic role "${role}"`);
  return Object.entries(schema.properties.properties.properties).filter(([, slot]) => !(slot as Record<string, unknown>)['x-semantic-edge']).map(([name]) => name);
}

export function semanticRoleEdges(role: string): string[] {
  const schema = ROLE_BINDING_SCHEMA.anyOf.find((schema) => schema.properties.role.const === role);
  if (schema === undefined) throw new Error(`unknown engine semantic role "${role}"`);
  return Object.entries(schema.properties.properties.properties).filter(([, slot]) => (slot as Record<string, unknown>)['x-semantic-edge'] === true).map(([name]) => name);
}

/** Shared projection boundary; unknown extension roles remain the declaring consumer's responsibility. */
export function checkRoleProperties(role: string, properties: Readonly<Record<string, unknown>>, place: string): void {
  const schema = ROLE_BINDING_SCHEMA.anyOf.find((schema) => schema.properties.role.const === role);
  if (schema === undefined) return;
  if (Value.Check(schema, { role, properties })) return;
  const problem = [...Value.Errors(schema, { role, properties })][0];
  throw new Error(`${place}: semantic role "${role}" projection ${problem?.instancePath ?? ''} ${problem?.message ?? 'does not match its protocol'}`);
}
