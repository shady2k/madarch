/**
 * The agent's MCP reads reach graph data only (owner's rule, 2026-11-15: the agent reads only the graph). The general
 * GraphQL executor also serves the reader's page layer, which reads the product's page templates from disk and names
 * absolute files of this machine; a fill's agent asks through `graph_query`, and neither answer may reach it.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDraft } from '../src/product/draft.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { callAgentGraphTool } from '../src/graph/agent-reads.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

test('the agent cannot read template bodies or this machine\'s paths through graph_query', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-agent-reads-'));
  let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
  try {
    const draft = createDraft({ home: root, name: 'agent-reads', template: 'everything', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    const folder = draft.folder;
    // A template the product's own check refuses: the reader's page layer reports it with the file it read.
    writeFileSync(join(folder, 'templates', 'broken.yaml'), 'template: broken\nsections:\n  - id: x\n    component: no-such-component\n    query: |\n      id\n');
    const validation = validateProductManifests(folder);
    if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
    if (validation.value === undefined) throw new Error(`${folder}:1: no manifest`);
    const manifest = validation.value.manifest;
    const contract = withManifestContract(graphContractOf(manifest));
    owner = await createTestDatabaseOwner({ graphContract: contract });
    await publishValidatedManifests(owner, validation.value);
    const source = { owner, manifest, contract, folder };

    const bootstrap = await callAgentGraphTool(source, 'graph_query', { query: '{ bootstrap { templates { name body } } }' });
    expect(bootstrap.isError).toBe(true);
    expect(JSON.stringify(bootstrap.answer)).not.toContain('sections:');
    const findings = await callAgentGraphTool(source, 'graph_query', { query: '{ templateFindings { file } }' });
    expect(findings.isError).toBe(true);
    expect(JSON.stringify(findings.answer)).not.toContain(folder);
    expect(JSON.stringify(findings.answer)).not.toMatch(/templates\/broken\.yaml/);
    // Graph data still answers: the repositories the graph holds.
    const graph = await callAgentGraphTool(source, 'graph_query', { query: '{ allCodeRepository(first: 1) { totalCount } }' });
    expect(graph.isError).toBe(false);
  } finally {
    if (owner !== undefined) await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
