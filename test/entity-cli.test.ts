import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { entityCommand } from '../src/product/entity-cli.js';
import { stripEngineLocation } from '../src/server/engine-location.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { AuthoredRefusal, authoredEntity } from '../src/graph/authored.js';
import { GraphRefusal } from '../src/graph/validation.js';
import { releaseRoot } from '../src/product-wiki/release-assets.js';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { withSystemContract } from '../src/graph/system-contract.js';
import { personBinding } from '../src/graph/system-installation.js';
import { createTestDatabaseOwner } from './test-database.js';

test('entity CLI parses exactly the fields advertised by the authored door', async () => {
  const manifest = parseKinds(`kinds:
  person:
    extends: system:person
    origin: person
    fields:
      - { name: name, type: text, nullable: true, producers: [person] }
      - { name: count, type: integer, nullable: true, producers: [person] }
      - { name: active, type: boolean, nullable: true, producers: [person] }
      - { name: serial, type: bigint, nullable: true, producers: [person] }
      - { name: at, type: timestamp, nullable: true, producers: [person] }
      - name: aliases
        type: json
        nullable: true
        producers: [person]
        schema:
          $schema: https://json-schema.org/draft/2020-12/schema
          type: array
          items: { type: string }
`, 'madarch/catalog.yaml', '/tmp');
  expect(manifest.findings).toEqual([]);
  const contract = withSystemContract(graphContractOf(manifest));
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const binding = await personBinding(owner, contract);
  // Keep product discovery/fill outside this parser test; every schema and write uses the real door.
  const authored = spyOn(KnowledgeProduct.prototype, 'authored').mockImplementation(async (action, kind, args = {}) =>
    owner.transaction(action === 'schema' || action === 'show' || action === 'list' ? 'snapshot' : 'write', async tx =>
      authoredEntity(tx, manifest, 'product', binding, action === 'show' ? 'read' : action === 'update' ? 'edit' : action, kind, args)));
  const status = spyOn(KnowledgeProduct.prototype, 'status').mockRejectedValue(new Error('no fill in parser fixture'));
  const close = spyOn(KnowledgeProduct.prototype, 'close').mockResolvedValue(undefined);
  async function run(args: string[]) {
    let output = '';
    const code = await entityCommand([...args, '--product', '/tmp/cli-fixture', '--json'], { stdout: { write: text => { output += text; } } });
    return { code, body: JSON.parse(output) };
  }
  try {
    const schema = await run(['schema', 'person']);
    expect(schema.code).toBe(0);
    expect(schema.body.fields.map((field: { name: string }) => field.name)).toEqual(['name', 'count', 'active', 'serial', 'at', 'aliases']);
    const made = await run(['create', 'person', '--name', 'null', '--count', '3', '--active', 'true', '--serial', '9223372036854775807', '--at', '2026-11-19T12:00:00.000Z', '--aliases', '["First","Second"]']);
    expect(made.code).toBe(0);
    expect(made.body.entity.values).toMatchObject({ name: 'null', count: 3, active: true, serial: '9223372036854775807', at: '2026-11-19T12:00:00.000Z', aliases: ['First', 'Second'] });
    expect(made.body.entity.values).toHaveProperty('installation');
    const updated = await run(['update', 'person', made.body.entity.uid, '--field', 'count=4', '--field', 'aliases=["Changed"]', '--active', 'null']);
    expect(updated.code).toBe(0);
    expect(updated.body.entity.values).toMatchObject({ count: 4, aliases: ['Changed'], active: null });
    for (const action of ['create', 'update']) {
      const refused = await run([action, 'person', ...(action === 'update' ? [made.body.entity.uid] : []), '--installation', 'forged']);
      expect(refused.code).toBe(2);
      expect(refused.body.error).toMatchObject({ field: 'installation', message: expect.stringContaining('not declared by this kind') });
    }
    const invalid = await run(['update', 'person', made.body.entity.uid, '--count', '"bad"']);
    expect(invalid.code).toBe(2);
    expect(invalid.body.error.message).toMatch(/^\/values\/count: expected integer/u);
    // A refusal names its reason, never the engine's own location (madarch-64o5.203).
    expect(invalid.body.error.message).not.toContain('$bunfs');
    expect(invalid.body.error.message).not.toContain(releaseRoot());
    let printed = '';
    const plain = await entityCommand(['update', 'person', made.body.entity.uid, '--count', '"bad"', '--product', '/tmp/cli-fixture'], { stdout: { write: () => {} }, stderr: { write: text => { printed += text; } } });
    expect(plain).toBe(2);
    expect(printed.split('\n')[0]).toMatch(/^\/values\/count: expected integer/u);
    expect(printed).not.toContain('$bunfs');
    expect(printed).not.toContain(releaseRoot());
    const read = await run(['show', 'person', made.body.entity.uid]);
    expect(read.code).toBe(0);
    expect(read.body.fields.map((field: { name: string }) => field.name)).toContain('installation');
    expect(read.body.entity.values.count).toBe(4);
  } finally {
    authored.mockRestore(); status.mockRestore(); close.mockRestore();
    await owner.close();
  }
}, 30_000);

test('entity CLI refusals keep the reason and field and drop an engine location they already carry', async () => {
  const bundle = '/$bunfs/root/madarch-linux-arm64';
  const authored = spyOn(KnowledgeProduct.prototype, 'authored');
  const status = spyOn(KnowledgeProduct.prototype, 'status').mockRejectedValue(new Error('no fill in refusal fixture'));
  const close = spyOn(KnowledgeProduct.prototype, 'close').mockResolvedValue(undefined);
  async function run(args: string[], product = '/tmp/cli-fixture') {
    let output = '';
    const code = await entityCommand([...args, '--product', product, '--json'], { stdout: { write: text => { output += text; } } });
    return { code, body: JSON.parse(output) };
  }
  try {
    // A refusal raised with the bundle's own location, as a compiled binary's import.meta.path names it.
    authored.mockRejectedValueOnce(new Error(`${bundle}:1: field "queue_position": expected integer`));
    const held = await run(['show', 'task', 'a1']);
    expect(held.code).toBe(2);
    expect(held.body.error).toEqual({ message: 'field "queue_position": expected integer', field: 'queue_position' });
    // A refusal that wrapped another repeats the location, because each error names its own module.
    authored.mockRejectedValueOnce(new AuthoredRefusal(400, new GraphRefusal('/values/queue_position', 'integer', 'bad').message));
    const repeated = await run(['show', 'task', 'a1']);
    expect(repeated.code).toBe(2);
    expect(repeated.body.error.message).toBe('/values/queue_position: expected integer, got "bad"');
    expect(repeated.body.error.message).not.toContain('$bunfs');
    expect(repeated.body.error.message).not.toContain(releaseRoot());
    // The plain-text answer is the same reason, with no location of the engine either.
    authored.mockRejectedValueOnce(new AuthoredRefusal(400, new GraphRefusal('/values/queue_position', 'integer', 'bad').message));
    let printed = '';
    const plain = await entityCommand(['show', 'task', 'a1', '--product', '/tmp/cli-fixture'], { stdout: { write: () => {} }, stderr: { write: text => { printed += text; } } });
    expect(plain).toBe(2);
    expect(printed.split('\n')[0]).toBe('/values/queue_position: expected integer, got "bad"');
    expect(printed).not.toContain('$bunfs');
    expect(printed).not.toContain(releaseRoot());
    // A product inside the checkout's own src/ keeps its file and line, in JSON and in plain text.
    const nested = join(releaseRoot(), 'src', 'nested-fixture');
    const named = `${nested}/workspace.yaml:1: the manifest ${nested}/workspace.yaml holds 999 at "schemaVersion": not a schema version this program knows`;
    authored.mockRejectedValueOnce(new Error(named));
    const kept = await run(['show', 'task', 'a1'], nested);
    expect(kept.code).toBe(2);
    expect(kept.body.error.message).toBe(named);
    authored.mockRejectedValueOnce(new Error(named));
    printed = '';
    const keptPlain = await entityCommand(['show', 'task', 'a1', '--product', nested], { stdout: { write: () => {} }, stderr: { write: text => { printed += text; } } });
    expect(keptPlain).toBe(2);
    expect(printed.split('\n')[0]).toBe(named);
    // An engine location with no line number ends at its own separator: the reason's numbered path stays.
    const unnumbered = `${bundle}: could not read ${nested}/workspace.yaml:42: unexpected field`;
    authored.mockRejectedValueOnce(new Error(unnumbered));
    const reasonKept = await run(['show', 'task', 'a1'], nested);
    expect(reasonKept.code).toBe(2);
    expect(reasonKept.body.error.message).toBe(`could not read ${nested}/workspace.yaml:42: unexpected field`);
    authored.mockRejectedValueOnce(new Error(unnumbered));
    printed = '';
    const reasonKeptPlain = await entityCommand(['show', 'task', 'a1', '--product', nested], { stdout: { write: () => {} }, stderr: { write: text => { printed += text; } } });
    expect(reasonKeptPlain).toBe(2);
    expect(printed.split('\n')[0]).toBe(`could not read ${nested}/workspace.yaml:42: unexpected field`);
    // A repeated engine location goes one at a time, and the product's own line stays with it.
    const twice = `${bundle}: ${bundle}:1: could not read ${nested}/workspace.yaml:42: unexpected field`;
    authored.mockRejectedValueOnce(new Error(twice));
    const twiceKept = await run(['show', 'task', 'a1'], nested);
    expect(twiceKept.code).toBe(2);
    expect(twiceKept.body.error.message).toBe(`could not read ${nested}/workspace.yaml:42: unexpected field`);
    authored.mockRejectedValueOnce(new Error(twice));
    printed = '';
    const twicePlain = await entityCommand(['show', 'task', 'a1', '--product', nested], { stdout: { write: () => {} }, stderr: { write: text => { printed += text; } } });
    expect(twicePlain).toBe(2);
    expect(printed.split('\n')[0]).toBe(`could not read ${nested}/workspace.yaml:42: unexpected field`);
  } finally {
    authored.mockRestore(); status.mockRestore(); close.mockRestore();
  }
});

test('engine locations are stripped only where the location is the engine\'s', () => {
  const src = join(releaseRoot(), 'src');
  const reason = '/values/count: expected integer, got "bad"';
  // An engine module's own location goes, line and column included.
  expect(stripEngineLocation(`${join(src, 'graph', 'validation.ts')}:1: ${reason}`)).toBe(reason);
  expect(stripEngineLocation(`/$bunfs/root/madarch-linux-arm64:123:4: ${reason}`)).toBe(reason);
  expect(stripEngineLocation(`Error: ${join(src, 'graph', 'validation.ts')}:1: ${reason}`)).toBe(reason);
  // An engine location with no line number goes too.
  expect(stripEngineLocation(`${join(src, 'fill', 'plugin-turns.ts')}: the unit is missing`)).toBe('the unit is missing');
  // A folder of the checkout holding a colon and a space does not end the location before its line.
  expect(stripEngineLocation(`${join(src, 'rev: two', 'graph', 'validation.ts')}:1: ${reason}`)).toBe(reason);
  // An engine prefix with no line number ends at its own separator: the reason's numbered path stays.
  expect(stripEngineLocation('/$bunfs/root/madarch: could not read /tmp/product/workspace.yaml:42: unexpected field'))
    .toBe('could not read /tmp/product/workspace.yaml:42: unexpected field');
  // An engine prefix followed straight away by a product location ends at its own separator too.
  expect(stripEngineLocation('/$bunfs/root/madarch: /tmp/product/workspace.yaml:42: unexpected field'))
    .toBe('/tmp/product/workspace.yaml:42: unexpected field');
  // The same for a checkout: the module the engine raised in ends the location, not the reason's own line.
  expect(stripEngineLocation(`${join(src, 'graph', 'fill-orchestration.ts')}: /tmp/product/workspace.yaml:42: unexpected field`))
    .toBe('/tmp/product/workspace.yaml:42: unexpected field');
  // A source folder of the checkout named with a colon and a space is consumed with the root, whole.
  expect(stripEngineLocation(`${join(src, 'fixture: source checkout', 'graph', 'validation.ts')}:1: ${reason}`)).toBe(reason);
  const colonRoot = '/tmp/fixture: source checkout';
  expect(stripEngineLocation(`${join(colonRoot, 'src', 'graph', 'validation.ts')}:1: ${reason}`, undefined, colonRoot)).toBe(reason);
  // A numbered file under src/ that is no engine module is a product's: it and the reason's line stay.
  const notModule = `${join(src, 'nested', 'workspace.yaml')}:1: could not read /tmp/other/app.ts:42: bad`;
  expect(stripEngineLocation(notModule)).toBe(notModule);
  // A checkout folder whose last part ends in `Error` is a path, not the name of an error before it.
  expect(stripEngineLocation(`${join(src, 'ScratchError: source', 'graph', 'validation.ts')}:1: ${reason}`)).toBe(reason);
  // The product asked about keeps its own file and line, even inside the engine's src/.
  const product = join(src, 'fixture: one');
  const named = `${join(product, 'workspace.yaml')}:1: the manifest holds 999 at "schemaVersion"`;
  expect(stripEngineLocation(named, product)).toBe(named);
  // A product path outside the engine is nobody's to strip, asked about or not.
  expect(stripEngineLocation('/tmp/product/workspace.yaml:1: the manifest holds 999')).toBe('/tmp/product/workspace.yaml:1: the manifest holds 999');
  // A plain reason names no location and keeps its colons.
  expect(stripEngineLocation('field "queue_position": expected integer')).toBe('field "queue_position": expected integer');
});
