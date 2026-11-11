/** Authored entities, reached without a fill or an agent (madarch-gzaz). */
import { resolve } from 'node:path';
import { KnowledgeProduct } from '../knowledge/product.js';
import { productsHome, type DraftEnv } from './home.js';
import { knowledgeRootOf } from './store.js';
import { whereAmI } from './lifecycle.js';

const HELP = [
  'usage: madarch entity <create|show|update|delete|list|schema> <kind> [uid] [options]',
  '       madarch entity import [--product <folder>] [--home <folder>] [--json]',
  '',
  'Create: madarch entity create doc.term --title Queue --definition "Work waiting to run"',
  'Read:   madarch entity list doc.term --json',
  'Edit:   madarch entity update doc.term <uid> --definition "Updated definition"',
  '',
  '  --product <folder>   Product folder (otherwise the current product)',
  '  --home <folder>      Products home holding the knowledge store',
  '  --field name=value   Set a declared field; repeat for several fields',
  '  --<field> <value>    Set a declared field by its own name',
  '  --words <text>       Keep these exact words with the operation',
  '  --if-revision <id>   Edit only the revision returned by a read',
  '  --json               Print one JSON object',
  '',
  'Run madarch entity schema <kind> to see fields. Use uid from a list or create response.',
].join('\n');

/** Resolve the current product, including a checkout connected under repos/. */
export function entityProductFolder(given: string | undefined, cwd: string): string {
  if (given !== undefined) return resolve(cwd, given);
  const found = whereAmI({ folder: cwd });
  if (found.outcome === 'product' || found.outcome === 'code') return found.product;
  if (found.outcome === 'refused') throw new Error(found.message);
  throw new Error(`${cwd}: no product found; use --product <folder> or run madarch init`);
}

/** Read-only orientation shared by the entity CLI and product MCP answers. */
export async function entityGuidance(product: KnowledgeProduct | undefined, folder?: string) {
  const identity = product?.product();
  const name = identity !== undefined && !('message' in identity) ? identity.name : folder ?? 'No product selected';
  try {
    if (product === undefined) throw new Error('no product');
    const status = await product.status();
    return { product: name, filled: status.filled, fill: status.fill.state,
      next: status.filled ? 'Use madarch entity list <kind>, or open the wiki with madarch serve.' : 'Open the wiki with madarch serve, select catalogue kinds and press Fill first.' };
  } catch {
    return { product: name, filled: null, fill: 'unknown', next: 'Select a product with --product <folder>. Open its wiki with madarch serve; select catalogue kinds and press Fill first.' };
  }
}

/** The command only parses and prints; KnowledgeProduct owns all entity behavior. */
export async function entityCommand(args: readonly string[], options: {
  cwd?: string; env?: DraftEnv;
  stdout?: { write(text: string): void }; stderr?: { write(text: string): void };
} = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    stdout.write(`${HELP}\nProduct: use --product <folder> or the current product. Open its wiki, select catalogue kinds and press Fill first; then list a kind.\n`); return 0;
  }
  let product: KnowledgeProduct | undefined;
  const json = args.includes('--json');
  try {
    const action = args[0];
    if (action !== 'create' && action !== 'show' && action !== 'update' && action !== 'delete' && action !== 'list' && action !== 'schema' && action !== 'import') {
      throw new Error(`unknown entity action ${JSON.stringify(action)}; choose create, show, update, delete, list, schema or import`);
    }
    const positional: string[] = [];
    let folder: string | undefined;
    let home: string | undefined;
    let words: string | undefined;
    let ifRevision: string | undefined;
    const rawValues: Record<string, string> = {};
    const setField = (name: string, value: string): void => {
      if (name === '' || Object.hasOwn(rawValues, name)) throw new Error(`field ${JSON.stringify(name)} must be named once`);
      rawValues[name] = value;
    };
    const seen = new Set<string>();
    for (let at = 1; at < args.length; at++) {
      const arg = args[at]!;
      if (!arg.startsWith('--')) { positional.push(arg); continue; }
      if (arg === '--json') continue;
      const split = arg.indexOf('=');
      const name = split < 0 ? arg.slice(2) : arg.slice(2, split);
      const value = split < 0 ? args[++at] : arg.slice(split + 1);
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      if (name !== 'field' && seen.has(name)) throw new Error(`--${name} must be given once`);
      seen.add(name);
      if (name === 'product') folder = value;
      else if (name === 'home') home = value;
      else if (name === 'words') words = value;
      else if (name === 'if-revision') ifRevision = value;
      else if (name === 'field') {
        const equals = value.indexOf('=');
        if (equals <= 0) throw new Error('--field needs name=value');
        setField(value.slice(0, equals), value.slice(equals + 1));
      } else setField(name, value);
    }
    const [kind, uid] = positional;
    if (kind === undefined && action !== 'import') throw new Error('an entity kind is required; run madarch entity schema to see the kinds');
    if (action === 'import' && positional.length > 0) throw new Error('import takes no kind or uid; it imports declared legacy Markdown sources');
    if (positional.length > 2) throw new Error('too many arguments: give a kind and, for show/update/delete, one uid');
    if (['show', 'update', 'delete'].includes(action) && uid === undefined) throw new Error(`${action} needs the uid from a create or list response`);
    if (['create', 'list', 'schema'].includes(action) && uid !== undefined) throw new Error(`${action} takes no uid`);
    if (action !== 'create' && action !== 'update' && Object.keys(rawValues).length > 0) throw new Error(`${action} takes no field values`);
    if (!['create', 'update', 'delete'].includes(action) && words !== undefined) throw new Error(`${action} takes no --words`);
    if (ifRevision !== undefined && action !== 'update') throw new Error(`${action} takes no --if-revision`);
    const env = options.env ?? process.env;
    const productFolder = entityProductFolder(folder, options.cwd ?? process.cwd());
    product = new KnowledgeProduct({ productFolder, storeRoot: knowledgeRootOf(productsHome(env, home)), env });
    const values: Record<string, unknown> = {};
    if (action === 'create' || action === 'update') {
      const schema = await product.authored('schema', kind!);
      for (const [name, raw] of Object.entries(rawValues)) {
        const field = schema.fields.find((held) => held.name === name);
        if (field === undefined) throw new Error(`field ${JSON.stringify(name)}: not declared by this kind`);
        if (field.type !== 'text' && field.nullable === true && raw === 'null') values[name] = null;
        else if (field.reference === undefined && ['text', 'timestamp', 'bigint'].includes(field.type)) values[name] = raw;
        else {
          try { values[name] = JSON.parse(raw); }
          catch { throw new Error(`field ${JSON.stringify(name)}: expected ${field.reference === undefined ? field.type : `a reference to ${field.reference}`}`); }
        }
      }
    }
    const answer = action === 'import' ? await product.importAuthored() : await product.authored(action, kind!, { ...(uid === undefined ? {} : { uid }), ...(words === undefined ? {} : { words }), ...(ifRevision === undefined ? {} : { ifRevision }), values });
    stdout.write(`${JSON.stringify({ ...answer, guidance: await entityGuidance(product) }, null, json ? undefined : 2)}\n`);
    return 'errors' in answer && answer.errors.length > 0 ? 2 : 0;
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = /^\/.+:\d+:/u.test(rawMessage) ? rawMessage : `${import.meta.path}:1: ${rawMessage}`;
    const guidance = await entityGuidance(product);
    if (json) stdout.write(`${JSON.stringify({ error: { message, ...(error instanceof Error && 'field' in error ? { field: error.field } : /^field "([^"]+)"/u.test(rawMessage) ? { field: /^field "([^"]+)"/u.exec(rawMessage)![1] } : {}), ...(error instanceof Error && 'conflict' in error && error.conflict !== undefined ? { conflict: error.conflict } : {}) }, guidance, help: 'madarch entity --help' })}\n`);
    else stderr.write(`${message}\n${JSON.stringify(guidance)}\nRun madarch entity --help for examples and options.\n`);
    return 2;
  } finally { await product?.close(); }
}
