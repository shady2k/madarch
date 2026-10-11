/**
 * The LikeC4 webcomponent bundle for the wiki app (feature E,
 * madarch-iuc.15): the same generation the static wiki's build runs
 * (src/wiki/build.ts) — the pinned `likec4` of the checkout turns the
 * rendered workspace into one self-contained script that defines the
 * `<likec4-view>` element with the model's views embedded — served to the
 * app from the server's cache root so a browser renders the interactive
 * LikeC4 views.
 *
 * The scratch lives under the wiki's per-user cache root (src/wiki/cache.ts,
 * the same root the build uses), named after the workspace's content hash:
 * the same workspace generates the same bytes wherever it runs, two asks of
 * one model share the folder harmlessly, and a changed model generates
 * again. The folder is private (0700) like the root itself. A generation
 * that fails is a named error, never a half bundle.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWikiCacheRoot } from '../wiki/cache.js';

/** The checkout's root: where the pinned likec4 lives. */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Where the LikeC4 binary is expected, as the static build names it. */
function likec4Bin(): string {
  return join(PACKAGE_ROOT, 'node_modules', '.bin', 'likec4');
}

export type LikeC4Bundle =
  | { ok: true; /** The generated bundle's text. */ script: string }
  | { ok: false; message: string };

/**
 * The webcomponent bundle of one rendered workspace, generated under the
 * cache root named by `env` (the process's by default) and read back as
 * text. The same workspace answers from the folder a previous ask left;
 * the generation runs only for a workspace whose folder is not there yet.
 */
export function likec4Webcomponent(workspace: string, env: Readonly<Record<string, string | undefined>> = process.env): LikeC4Bundle {
  const cache = ensureWikiCacheRoot(env);
  if (!cache.ok) return { ok: false, message: cache.message };
  const bin = likec4Bin();
  if (!existsSync(bin)) {
    return { ok: false, message: `likec4 was not found at ${bin}: the wiki serves the LikeC4 webcomponent the pinned likec4 in devDependencies generates; run "bun install" in the madarch checkout` };
  }
  const scratch = join(cache.root, `likec4-${createHash('sha256').update(workspace).digest('hex').slice(0, 16)}`);
  const bundle = join(scratch, 'likec4-view.js');
  if (!existsSync(bundle)) {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    writeFileSync(join(scratch, 'model.c4'), workspace);
    const gen = spawnSync(bin, ['gen', 'webcomponent', scratch, '-o', bundle], { encoding: 'utf8' });
    if (gen.status !== 0 || !existsSync(bundle)) {
      return {
        ok: false,
        message: `the LikeC4 webcomponent could not be generated for the product's model:\n${`${gen.stdout ?? ''}${gen.stderr ?? ''}`.trim()}`,
      };
    }
  }
  try {
    return { ok: true, script: readBundle(bundle) };
  } catch (error) {
    return { ok: false, message: `the LikeC4 webcomponent at ${bundle} could not be read: ${(error as Error).message}` };
  }
}

/** The bundle's text, read whole. */
function readBundle(path: string): string {
  return readFileSync(path, 'utf8');
}
