import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import { createDraft } from '../src/product/draft.js';
import { fillInProcess } from './fill-inline.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { prepareTestProduct } from './prepared-server.js';

export const authoredEnv = gitEnv(SAMPLE_IDENTITY);
export async function authoredFixture(home: string, name = 'authored', fill = true): Promise<string> {
  const draft = createDraft({ home, name, gitEnv: authoredEnv });
  if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
  mkdirSync(join(draft.folder, 'templates'), { recursive: true });
  writeFileSync(join(draft.folder, 'templates', 'note.liquid'), '{{ entity.title }}');
  writeFileSync(join(draft.folder, 'madarch', 'kinds.yaml'), stringify({
    kinds: { note: { source: 'graph', origin: 'person', template: 'templates/note.liquid', title: 'title', fields: [
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
