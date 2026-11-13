/** A completed fill changes the status a poll states: the manifest is ok and the graph is filled together. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { createDraft } from '../src/product/draft.js';
import { fillInProcess } from './fill-inline.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { prepareTestProduct } from './prepared-server.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';

test('a poll says not-filled before a real successful fill and ok with filled after it', async () => {
  const work = mkdtempSync(join(tmpdir(), 'madarch-status-fill-memo-'));
  const home = join(work, 'products');
  const storeRoot = join(work, 'store');
  let reader: KnowledgeProduct | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    const env = gitEnv(SAMPLE_IDENTITY);
    const draft = createDraft({ home, name: 'tracker', gitEnv: env });
    if (draft.outcome !== 'created') throw new Error(`cannot create fixture: ${JSON.stringify(draft)}`);
    writeFolderManifest(draft.folder, `kinds:
  idea:
    source: graph
    origin: person
    fields:
      - { name: title, type: text, producers: [person] }
    title: title
    labels:
      en: { one: Idea, many: Ideas }
      ru: { one: Idea, many: Ideas }
`);
    writeFileSync(join(draft.folder, 'madarch', 'workflows.yaml'), 'workflows:\n  first-fill:\n    status: implemented\n    stages: [plugin-turns]\n');
    execFileSync('git', ['add', '-A'], { cwd: draft.folder, env });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Declare tracker fixture'], { cwd: draft.folder, env });
    release = await prepareTestProduct(draft.folder, home, storeRoot);
    reader = new KnowledgeProduct({ productFolder: draft.folder, storeRoot });
    expect(await reader.status()).toMatchObject({ manifest: 'not-filled', filled: false, kinds: [{ kind: 'idea', count: 0 }] });
    const result = await fillInProcess(draft.folder, home, storeRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('the fixture fill was refused');
    expect(result.state).toBe('succeeded');
    const status = await reader.status();
    expect({ manifest: status.manifest, filled: status.filled, kinds: status.kinds }).toEqual({ manifest: 'ok', filled: true, kinds: [{ kind: 'idea', count: 0 }] });
  } finally {
    await reader?.close();
    await release?.();
    rmSync(work, { recursive: true, force: true });
  }
}, 60_000);
