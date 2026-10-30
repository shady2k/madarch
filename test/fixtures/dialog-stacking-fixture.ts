/**
 * Builds the dialog-stacking browser fixture outside the test runner: the training repository, a product pointing at
 * it, and the graph fill that gives the product page its LikeC4 diagram. The fill needs more memory than a browser test
 * process should carry, so `wiki-dialog-stacking-e2e.test.ts` runs this file as a child and serves its store afterwards.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../../src/server/http.js';
import { generateTrainingRepository, makeProduct, writeSamplePages } from '../knowledge-fixture.js';

const work = process.argv[2];
if (work === undefined) throw new Error('usage: bun test/fixtures/dialog-stacking-fixture.ts <work-folder>');
const repository = join(work, 'training');
generateTrainingRepository(repository);
const home = join(work, 'home');
mkdirSync(home);
const product = makeProduct(home, 'training', repository, 'training');
writeSamplePages(product);
const user = join(work, 'user');
mkdirSync(user);
const store = join(work, 'store');
const server = await startServer({
  productHome: home,
  appFolder: join(work, 'not-served'),
  port: 0,
  knowledgeRoot: store,
  log: () => undefined,
  errorLog: (line) => console.error(line),
  env: { ...process.env, HOME: user, MADARCH_HOME: join(user, 'madarch') },
});
try {
  const started = await fetch(`${server.url}/products/training/api/k/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (started.status !== 202) throw new Error(`the fill was refused: ${started.status} ${await started.text()}`);
  let done = false;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const status = await (await fetch(`${server.url}/products/training/api/k/status`)).json() as { fill?: { state?: string; message?: string } };
    if (status.fill?.state === 'done') { done = true; break; }
    if (status.fill?.state === 'failed') throw new Error(`the fill failed: ${status.fill.message ?? 'no message'}`);
    await new Promise((rest) => setTimeout(rest, 250));
  }
  if (!done) throw new Error('the fill did not end');
} finally {
  await server.stop();
}
writeFileSync(join(work, 'fixture.json'), JSON.stringify({ home, user, store }));
