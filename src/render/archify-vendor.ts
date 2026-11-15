/**
 * Where the vendored archify renderer is read from (madarch-64o5.97): the checkout's `vendor/archify`, or the copy the
 * wiki app's own build lays under `dist/archify/vendor/archify`. A release binary carries the wiki app's dist as its
 * embedded asset, so the same file the source build runs is the one the binary carries; the checkout's vendor folder is
 * what a source run reads, and the app's copy is what an installed binary has.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddedWikiApp } from '../product-wiki/release-assets.js';

/** The renderer's own path under a vendor folder. */
export const ARCHIFY_RENDERER = ['renderers', 'architecture', 'render-architecture.mjs'] as const;

/** The repo root as this module sees it: the checkout, or the release binary's own bundle. */
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The vendor folder holding the archify renderer, checkout first, then the wiki app's built copy; undefined when neither has it. */
export function archifyVendorFolder(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  return archifyVendorCandidates(env).find((folder) => existsSync(join(folder, ...ARCHIFY_RENDERER)));
}

/** The folders the lookup tried, for a failure that must say where the renderer was looked for. */
export function archifyVendorCandidates(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const candidates: string[] = [join(ROOT, 'vendor', 'archify')];
  const app = embeddedWikiApp();
  if (app !== undefined) candidates.push(join(app, 'dist', 'archify', 'vendor', 'archify'));
  const named = env['MADARCH_APP']?.trim();
  if (named !== undefined && named !== '') candidates.push(join(named, 'archify', 'vendor', 'archify'), join(named, 'dist', 'archify', 'vendor', 'archify'));
  candidates.push(join(ROOT, 'wiki', 'app', 'dist', 'archify', 'vendor', 'archify'));
  return candidates;
}

/**
 * Lays the vendor folder at a destination, file by file. A release binary's copy lives inside its own bundle, which
 * `cpSync` cannot copy out of, so the walk reads each file and writes it: the entry, its sibling modules and the
 * template and assets it reads beside itself come out whole (madarch-64o5.97).
 */
export function copyArchifyVendor(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  const walk = (from: string, to: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const read = join(from, entry.name);
      const write = join(to, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(write, { recursive: true });
        walk(read, write);
      } else {
        mkdirSync(dirname(write), { recursive: true });
        writeFileSync(write, readFileSync(read));
      }
    }
  };
  walk(source, destination);
}
