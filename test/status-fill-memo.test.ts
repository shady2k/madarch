/** A completed fill changes live status even when the cached manifest body has the same key. */
import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeProduct } from '../src/knowledge/product.js';
import { createDraft } from '../src/product/draft.js';
import { fillInProcess } from './fill-inline.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { prepareTestProduct } from './prepared-server.js';

test('a cached status says manifest ok and filled together after a real successful fill', async () => {
  const work = mkdtempSync(join(tmpdir(), 'madarch-status-fill-memo-'));
  const home = join(work, 'products');
  const storeRoot = join(work, 'store');
  let reader: KnowledgeProduct | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    const env = gitEnv(SAMPLE_IDENTITY);
    const draft = createDraft({ home, name: 'tracker', gitEnv: env });
    if (draft.outcome !== 'created') throw new Error(`cannot create fixture: ${JSON.stringify(draft)}`);
    mkdirSync(join(draft.folder, 'templates'), { recursive: true });
    writeFileSync(join(draft.folder, 'templates', 'idea.liquid'), '{{ page.title }}\n');
    writeFileSync(join(draft.folder, 'madarch', 'kinds.yaml'), `groups:
  tracker: { en: Tracker, ru: Tracker }
kinds:
  idea:
    template: templates/idea.liquid
    source: graph
    origin: person
    group: tracker
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
    // Isolate the terminal-state refresh from graph/file cache invalidation. The fill and its persisted result are real.
    const key = spyOn(reader as unknown as { statusKey(revision?: string): Promise<string> }, 'statusKey').mockResolvedValue('unchanged-status-key');
    try {
      expect(await reader.status()).toMatchObject({ manifest: 'not-filled', filled: false });
      const result = await fillInProcess(draft.folder, home, storeRoot);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('the fixture fill was refused');
      expect(result.state).toBe('succeeded');
      const status = await reader.status();
      expect({ manifest: status.manifest, filled: status.filled }).toEqual({ manifest: 'ok', filled: true });
    } finally {
      key.mockRestore();
    }
  } finally {
    await reader?.close();
    await release?.();
    rmSync(work, { recursive: true, force: true });
  }
}, 60_000);
