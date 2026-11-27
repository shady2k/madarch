import { afterAll, beforeAll, expect, test } from 'bun:test';
import { entityCommand } from '../src/product/entity-cli.js';
import { mcpCommand } from '../src/mcp/cli.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/http.js';
import { activateTestProduct, retainTestStorePreparationOwner } from './prepared-server.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { publishStoreOwner } from '../src/product/store-preparation.js';
import { createDatabaseOwner } from '../src/adapters/database-owner.js';
import { loadAssertions } from '../src/graph/assertion-read.js';
import { advanceRun, createRun } from '../src/graph/fill-state.js';
import { startupBinding } from '../src/graph/manifest-publication.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { installSystemSources } from '../src/graph/system-installation.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { readPinnedGraphContract } from '../src/product/fill-stages.js';
import { authoredEnv, authoredFixture } from './authored-fixture.js';

let work: string;
let server: StartedServer;
let base: string;
let home: string;
let folder: string;
let closePreparationOwner: (() => Promise<void>) | undefined;
const authorEnv = { ...authoredEnv, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined };
const privateEmail = 'private-author@example.test';

function configureAuthor(name: string): void {
  execFileSync('git', ['config', '--local', 'user.name', name], { cwd: folder, env: authorEnv });
  execFileSync('git', ['config', '--local', 'user.email', privateEmail], { cwd: folder, env: authorEnv });
}

beforeAll(async () => {
  closePreparationOwner = await retainTestStorePreparationOwner();
  work = mkdtempSync(join(tmpdir(), 'authored-http-'));
  home = join(work, 'products');
  folder = await authoredFixture(home, 'authored', false);
  configureAuthor('Acceptance Person');
  await activateTestProduct(folder, home);
  const app = join(work, 'app');
  mkdirSync(app); writeFileSync(join(app, 'index.html'), '<!doctype html><title>Fixture</title>');
  server = await startServer({ productHome: home, appFolder: app, knowledgeRoot: knowledgeRootOf(home), port: 0, env: authorEnv, log: () => {} });
  base = `${server.url}/products/authored/api/authored?kind=note`;
}, 60_000);

afterAll(async () => {
  try { await server?.stop(); } finally {
    try { await closePreparationOwner?.(); } finally {
      if (work) rmSync(work, { recursive: true, force: true });
    }
  }
});

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${server.url}/products/authored/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  expect(response.status).toBe(200);
  const result = await response.json() as { data: T; errors?: unknown };
  expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
  return result.data;
}

interface Identity { readonly id: string; readonly label: string }
interface Journal {
  readonly entity: { readonly details: readonly {
    readonly name: string;
    readonly assertions: readonly { readonly selected: boolean; readonly source: Identity; readonly author: Identity }[];
  }[] };
}

const journalQuery = `query ($id: ID!) {
  entity(id: $id) { details { name assertions { selected source { id label } author { id label } } } }
}`;

test('wiki, CLI and MCP journal the configured person under one durable author ID', async () => {
  await graphql('{ allNote(first: 1) { totalCount } }');
  const owner = await createDatabaseOwner({ store: storeDatabasePath(productStoreFolder(folder, knowledgeRootOf(home))), connectOnly: true });
  const unpublish = publishStoreOwner(home);
  const oldLabel = 'fixture-machine-login';
  try {
    const contract = await readPinnedGraphContract(folder);
    // The commands require a completed fill. Record that precondition independently of the fill worker.
    const fill = { transaction: owner.transaction.bind(owner), graphContract: withAssertionContract(contract) };
    const runId = 'authored-fixture';
    const at = 1_700_000_000_000;
    await createRun(fill, { runId, product: 'authored', at });
    expect((await advanceRun(fill, { runId, event: { type: 'plan', configuration: 'fixture', at: at + 1 } })).ok).toBe(true);
    expect((await advanceRun(fill, { runId, event: { type: 'start', stages: 1, at: at + 2 } })).ok).toBe(true);
    const evidence = { runnable: 0, inFlight: 0, waiting: 0, coverageMet: true };
    expect((await advanceRun(fill, { runId, event: { type: 'complete', evidence, at: at + 3 } })).ok).toBe(true);
    const { person } = await installSystemSources(owner, contract);
    await owner.transaction('write', async (tx) => {
      const installed = await startupBinding(tx, contract, 'system-installation');
      await publishGraphDrafts(tx, installed.contract, { vertices: [{
        kind: 'person', uid: person.uid, key: {}, values: { label: oldLabel, version: '1' }, producer: 'system', producerVersion: '1',
      }], removals: [] });
    });
    const personQuery = `query ($id: ID!) { entity(id: $id) { id label } }`;
    expect(await graphql(personQuery, { id: person.uid })).toEqual({ entity: { id: person.uid, label: 'person' } });

    const response = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { title: 'From the wiki' } }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { entity: { uid: string }; author: { id: string; label: string } };
    const wikiAuthor = { id: person.uid, label: 'Acceptance Person' };
    expect(created.author).toEqual(wikiAuthor);
    const wiki = await graphql<Journal>(journalQuery, { id: created.entity.uid });
    expect(wiki.entity.details).toContainEqual({ name: 'title', assertions: [{ selected: true, source: wikiAuthor, author: wikiAuthor }] });

    configureAuthor('Renamed Person');
    const renamedAuthor = { id: person.uid, label: 'Renamed Person' };
    const selection = ['--home', home, '--product', folder];
    const env = { ...process.env, ...authorEnv };
    let cli = '';
    const exit = await entityCommand(['update', 'note', created.entity.uid, '--title', 'From the CLI', '--json', ...selection], {
      env, stdout: { write: (text) => { cli += text; } },
    });
    expect(exit, cli).toBe(0);
    expect(JSON.parse(cli).author).toEqual(renamedAuthor);
    expect(cli).not.toContain(privateEmail);
    const journal = await graphql<Journal>(journalQuery, { id: created.entity.uid });
    const title = journal.entity.details.find((detail) => detail.name === 'title');
    expect(title?.assertions).toEqual([
      { selected: true, source: renamedAuthor, author: renamedAuthor },
      { selected: false, source: renamedAuthor, author: renamedAuthor },
    ]);

    const snapshots = await graphql<{ allSystemContentSnapshot: { edges: { node: { id: string } }[] } }>('{ allSystemContentSnapshot(first: 1) { edges { node { id } } } }');
    const snapshot = snapshots.allSystemContentSnapshot.edges[0]?.node.id;
    expect(snapshot).toEqual(expect.any(String));
    const noteId = randomUUID();
    const supports = [{ target: { kind: 'system.content-snapshot', uid: snapshot, key: {} } }];
    const messages = [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'fixture-client' } } },
      { id: 2, method: 'tools/call', params: { name: 'put_entity', arguments: {
        kind: 'note', id: noteId, values: { title: 'From MCP' }, evidence: supports,
      } } },
      { id: 3, method: 'tools/call', params: { name: 'graph_query', arguments: { query: journalQuery, variables: { id: noteId } } } },
    ];
    async function* input() {
      for (const message of messages) yield JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
    }
    let mcp = '';
    expect(await mcpCommand(selection, { env, input: input(), output: { write: (text) => { mcp += text; } } })).toBe(0);
    const replies = mcp.trim().split('\n').map((line) => JSON.parse(line) as { id: number; result: { isError?: boolean; content: [{ text: string }] } });
    for (const id of [2, 3]) {
      const reply = replies.find((message) => message.id === id);
      expect(reply?.result.isError, reply?.result.content[0].text).toBe(false);
    }
    const read = replies.find((message) => message.id === 3)!.result.content[0].text;
    const { data } = JSON.parse(read) as { data: Journal };
    const agent = data.entity.details.find((detail) => detail.name === 'title')?.assertions[0];
    expect(agent).toEqual({ selected: true, source: { id: expect.any(String), label: 'Local MCP agent' }, author: renamedAuthor });
    expect(agent?.source.id).not.toBe(agent?.author.id);
    expect(JSON.stringify([wiki, journal, mcp])).not.toContain(oldLabel);
    expect(JSON.stringify([wiki, journal, mcp])).not.toContain(privateEmail);

    await installSystemSources(owner, contract);
    await owner.transaction('snapshot', async (tx) => {
      const { rows: [node] } = await tx.query<{ id: number }>('SELECT id FROM node WHERE uid = $1::uuid', [person.uid]);
      const labels = await loadAssertions(tx, 'vertex', 'person', ['label'], [Number(node!.id)]);
      expect(labels.map(({ value }) => value).sort()).toEqual(['Acceptance Person', 'Renamed Person', oldLabel]);
    });
    expect(await graphql(personQuery, { id: person.uid })).toEqual({ entity: renamedAuthor });
  } finally {
    unpublish();
    await owner.close();
  }
}, 30_000);
