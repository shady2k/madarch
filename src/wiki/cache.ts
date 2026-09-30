/**
 * The wiki's per-user cache root (docs/changes/wiki/capabilities/wiki.md,
 * security): the one folder the build may write outside its arguments —
 * the Starlight template's installs, which the build executes `astro`
 * from, and the LikeC4 webcomponent scratch — live under it. The folder
 * is private to the user running the build, created 0700, and refused
 * when it cannot be trusted: a predictable folder another user could have
 * planted, filled or redirected must never be executed from. Tests move
 * the whole root with `MADARCH_WIKI_CACHE`; the default follows XDG,
 * `$XDG_CACHE_HOME/madarch/wiki`, else `~/.cache/madarch/wiki`.
 */
import { lstatSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The environment the cache root is read from: the process's, or the caller's. */
export type WikiCacheEnv = Readonly<Record<string, string | undefined>>;

/** Where the cache root is: `MADARCH_WIKI_CACHE`, else madarch/wiki under the XDG cache home, else under ~/.cache. */
export function wikiCacheRoot(env: WikiCacheEnv): string {
  const override = env.MADARCH_WIKI_CACHE;
  if (override !== undefined && override.trim() !== '') return override;
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg !== undefined && xdg.trim() !== '' ? xdg : join(homedir(), '.cache'), 'madarch', 'wiki');
}

/** The cache root accepted for use, or the refusal naming it and how to fix it. */
export type WikiCacheRoot = { ok: true; root: string } | { ok: false; message: string };

/**
 * Makes sure the cache root exists for this user alone: created, with the
 * folders above it, mode 0700 when missing; refused — with the fix — when
 * it is owned by another user, writable by group or others, or a symlink.
 */
export function ensureWikiCacheRoot(env: WikiCacheEnv): WikiCacheRoot {
  const root = wikiCacheRoot(env);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, message: `the wiki cache root ${root} cannot be created: ${(error as Error).message}` };
  }
  const move = 'point MADARCH_WIKI_CACHE at a private folder of your own';
  if (lstatSync(root).isSymbolicLink()) {
    return { ok: false, message: `the wiki cache root ${root} is a symlink: the wiki refuses a cache root whose folder another path could redirect; remove the symlink and let the wiki create the folder, or ${move}` };
  }
  const stats = statSync(root);
  if (process.getuid !== undefined && stats.uid !== process.getuid()) {
    return { ok: false, message: `the wiki cache root ${root} is owned by another user: the wiki runs installs and keeps scratch in this folder and refuses one it cannot trust; run "chown -R $(id -un) ${root}", or ${move}` };
  }
  if ((stats.mode & 0o022) !== 0) {
    return { ok: false, message: `the wiki cache root ${root} is writable by group or others: the wiki runs installs from this folder and refuses one another user could plant; run "chmod 700 ${root}", or ${move}` };
  }
  return { ok: true, root };
}
