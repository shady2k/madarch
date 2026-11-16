/** Build-time assets: the same declared dependency files the closure hashes, embedded as bytes. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { withSpanSync } from '../obs/trace.js';
import { walk, dependencyFiles } from './dependency-files.js';

/** Bun evaluates this macro while bundling, including in a compiled release. */
export function pluginFiles(id: string): { path: string; base64: string }[] {
  const folder = resolve(import.meta.dir, '../../plugins', id);
  const files = [...walk(folder), ...dependencyFiles(folder)].sort((left, right) => byCodePoint(left.path, right.path));
  // One span for the reading of every asset: a span for each file would bury what the build embeds.
  return withSpanSync('plugin.files', { 'file.path': folder, 'plugin.files': files.length }, () => files.map((file) => ({
    path: file.path,
    base64: readFileSync(file.file).toString('base64'),
  })));
}
