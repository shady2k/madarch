/** Build the vendored archify renderer into the wiki assets (madarch-m38l.15). */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor', 'archify');
const assetRoot = join(root, 'wiki', 'app', 'dist', 'archify');
const vendored = join(assetRoot, 'vendor', 'archify');
const entry = join(source, 'renderers', 'architecture', 'render-architecture.mjs');
const output = join(vendored, 'renderers', 'architecture', 'render-architecture.mjs');
if (!existsSync(entry)) {
  console.error(`${entry}:1: the vendored archify renderer is missing`);
  process.exitCode = 1;
} else {
  mkdirSync(assetRoot, { recursive: true });
  cpSync(source, vendored, { recursive: true });
  const built = spawnSync('bun', ['build', '--target=bun', '--outfile', output, entry], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0 || !existsSync(output)) {
    console.error(`${entry}:1: could not bundle archify into ${output} (exit ${String(built.status)}): ${(built.stderr ?? built.stdout ?? '').trim() || 'bun printed nothing'}`);
    process.exitCode = 1;
  } else {
    console.log(`bundled archify into ${output}`);
  }
}
