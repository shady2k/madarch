/** A draft's status must not create a database just to collect Problems without a manifest. */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { knowledgeRootOf, productStoreFolder, storeDatabasePath } from '../src/product/store.js';
import { startServer } from '../src/server/http.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

const root = mkdtempSync(join(tmpdir(), 'madarch-draft-status-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('polling a draft leaves its database absent', async () => {
  const home = join(root, 'products');
  const app = join(root, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>wiki</title>');
  const draft = createDraft({ home, name: 'draft-status', gitEnv: gitEnv(SAMPLE_IDENTITY) });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  const database = storeDatabasePath(productStoreFolder(draft.folder, knowledgeRootOf(home)));
  const server = await startServer({ productFolder: draft.folder, knowledgeRoot: knowledgeRootOf(home), appFolder: app, port: 0, log: () => undefined, errorLog: () => undefined });
  try {
    for (let at = 0; at < 3; at += 1) {
      const response = await fetch(`${server.url}/api/status`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.manifest).toBe('not-filled');
      expect(body.filled).toBe(false);
      expect(existsSync(database)).toBe(false);
    }
  } finally {
    await server.stop();
  }
}, 30_000);
