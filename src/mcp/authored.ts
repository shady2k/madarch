/** Authored product tools. Opening this surface never starts a fill or an agent. */
import { KnowledgeProduct } from '../knowledge/product.js';
import { withSpan } from '../obs/trace.js';
import { entityGuidance } from '../product/entity-cli.js';
import { serveUnitMcp } from '../fill/unit-mcp.js';
import { runningVersion } from '../product/version.js';
import { knowledgeRootOf } from '../product/store.js';
import { productsHome, type DraftEnv } from '../product/home.js';
import type { McpToolDefinition, UnitToolAnswer } from './types.js';

const tool = (action: string, description: string, required: readonly string[]): McpToolDefinition => ({
  name: `${action}_entity`, description,
  inputSchema: { type: 'object', properties: {
    kind: { type: 'string', description: 'Authored entity kind from the product catalogue, such as doc.term' },
    uid: { type: 'string', description: 'Stable uid returned by create or read; not a display id' },
    values: { type: 'object', description: 'Declared field names and their values' },
    words: { type: 'string', description: 'Exact original words to keep with the operation' },
  }, required, additionalProperties: false },
});

export const AUTHORED_TOOLS: readonly McpToolDefinition[] = [
  tool('create', 'Create an authored entity using declared fields.', ['kind']),
  tool('read', 'Read by uid, or list a kind when uid is omitted.', ['kind']),
  tool('update', 'Update declared fields by stable uid.', ['kind', 'uid']),
  tool('delete', 'Delete an authored entity by stable uid.', ['kind', 'uid']),
];

/** Validate protocol arguments, then call the same product API used by the CLI and HTTP. */
export async function callAuthoredTool(product: KnowledgeProduct, name: string, input: unknown): Promise<UnitToolAnswer> {
  return await withSpan('mcp.authored', { 'mcp.tool': name }, async () => {
  try {
    if (!AUTHORED_TOOLS.some((one) => one.name === name)) throw new Error(`unknown authored tool ${name}`);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('arguments must be an object');
    const args = input as Record<string, unknown>;
    if (typeof args['kind'] !== 'string' || args['kind'].trim() === '') throw new Error('kind must be a nonempty string');
    if (Object.keys(args).some((key) => !['kind', 'uid', 'values', 'words'].includes(key))) throw new Error('the arguments are kind, uid, values and words');
    if (args['uid'] !== undefined && (typeof args['uid'] !== 'string' || args['uid'].trim() === '')) throw new Error('uid must be a nonempty string');
    if (args['values'] !== undefined && (typeof args['values'] !== 'object' || args['values'] === null || Array.isArray(args['values']))) throw new Error('values must be an object of field names and values');
    if (args['words'] !== undefined && typeof args['words'] !== 'string') throw new Error('words must be a string');
    if ((name === 'update_entity' || name === 'delete_entity') && args['uid'] === undefined) throw new Error(`${name} requires uid`);
    if (name === 'create_entity' && args['uid'] !== undefined) throw new Error('create_entity takes no uid');
    if (name === 'read_entity' && (args['values'] !== undefined || args['words'] !== undefined)) throw new Error(`${name} takes no values or words`);
    if (name === 'delete_entity' && args['values'] !== undefined) throw new Error('delete_entity takes no values');
    const action = name === 'read_entity' ? (args['uid'] === undefined ? 'list' : 'show') : name === 'create_entity' ? 'create' : name === 'update_entity' ? 'update' : 'delete';
    const answer = await product.authored(action, args['kind'], {
      ...(args['uid'] === undefined ? {} : { uid: args['uid'] as string }),
      ...(args['words'] === undefined ? {} : { words: args['words'] as string }),
      ...(args['values'] === undefined ? {} : { values: args['values'] as Record<string, unknown> }),
    });
    return { answer: { ...answer, guidance: await entityGuidance(product) }, isError: false };
  } catch (error) {
    return { answer: { error: { message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && 'field' in error ? { field: error.field } : {}) }, guidance: await entityGuidance(product) }, isError: true };
  }
  });
}

export async function serveProductMcp(options: {
  productFolder: string; home?: string; env?: DraftEnv;
  input?: AsyncIterable<string | Uint8Array>; output?: { write(text: string): void };
}): Promise<number> {
  const env = options.env ?? process.env;
  const product = new KnowledgeProduct({ productFolder: options.productFolder, storeRoot: knowledgeRootOf(productsHome(env, options.home)), env });
  try {
    await serveUnitMcp({ tools: AUTHORED_TOOLS, info: { name: 'madarch', version: runningVersion() },
      call: (name, args) => callAuthoredTool(product, name, args),
      streams: { input: options.input ?? process.stdin, write: (text) => { (options.output ?? process.stdout).write(text); } },
    });
    return 0;
  } finally { await product.close(); }
}
