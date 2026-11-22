import { expect, spyOn, test } from 'bun:test';
import { entityCommand } from '../src/product/entity-cli.js';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { authoredEntity } from '../src/graph/authored.js';
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
    expect(invalid.body.error.message).toContain('/values/count: expected integer');
    const read = await run(['show', 'person', made.body.entity.uid]);
    expect(read.code).toBe(0);
    expect(read.body.fields.map((field: { name: string }) => field.name)).toContain('installation');
    expect(read.body.entity.values.count).toBe(4);
  } finally {
    authored.mockRestore(); status.mockRestore(); close.mockRestore();
    await owner.close();
  }
}, 30_000);
