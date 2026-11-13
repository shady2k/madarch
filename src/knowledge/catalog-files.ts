/** Catalogue files embedded by Bun at build time, including in offline release binaries. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { byCodePoint } from '../model/order.js';

export function catalogFiles(): Record<string, string> {
  const root = join(import.meta.dir, '../../catalog');
  const files: Record<string, string> = {};
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name))) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.yaml')) files[relative(root, file).replaceAll('\\', '/')] = readFileSync(file, 'utf8');
      else throw new Error(`${file}:1: the catalogue holds only folders and YAML files`);
    }
  };
  visit(root);
  return files;
}
