import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import { createDraft } from '../src/product/draft.js';
import { fillInProcess } from './fill-inline.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { prepareTestProduct } from './prepared-server.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';

export const authoredEnv = gitEnv(SAMPLE_IDENTITY);
/** A product whose one kind is person-authored, filled once so an authored write has a permitted graph behind it. */
export async function authoredFixture(home: string, name = 'authored', fill = true): Promise<string> {
  const draft = createDraft({ home, name, gitEnv: authoredEnv });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  rmSync(join(draft.folder, 'madarch', 'kinds'), { recursive: true, force: true });
  writeFolderManifest(draft.folder, stringify({
    kinds: { note: { source: 'graph', origin: 'person', title: 'title', fields: [
      { name: 'title', type: 'text', producers: ['person'] },
      { name: 'count', type: 'integer', nullable: true, producers: ['person'] },
    ] } },
  }));
  execFileSync('git', ['add', '-A'], { cwd: draft.folder, env: authoredEnv });
  execFileSync('git', ['commit', '-qm', 'Declare fixture authored kind'], { cwd: draft.folder, env: authoredEnv });
  const closePreparation = await prepareTestProduct(draft.folder, home);
  try { if (fill) await fillInProcess(draft.folder, home); }
  finally { await closePreparation(); }
  return draft.folder;
}
