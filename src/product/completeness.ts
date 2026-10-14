/** Reads the external skill set’s committed completeness snapshot. */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join as joinPath, relative, sep } from 'node:path';
import { Value } from 'typebox/value';
import { ProductCompleteness, type ProductCompleteness as ProductCompletenessData } from './schema.js';

export const COMPLETENESS_FILE = 'docs/completeness.json';

/** Snapshot data or absence. Invalid/unreadable snapshots are surfaced as a problem. */
export type CompletenessRead =
  | { present: false }
  | { present: true; snapshot: ProductCompletenessData }
  | { present: true; problem: string };

export function readProductCompleteness(productFolder: string): CompletenessRead {
  const path = joinPath(productFolder, ...COMPLETENESS_FILE.split('/'));
  let text: string;
  try {
    const root = realpathSync(productFolder);
    const real = realpathSync(path);
    const within = relative(root, real);
    if (!within.startsWith(`docs${sep}`) || within === '..' || within.startsWith(`..${sep}`) || statSync(real).isFile() === false) {
      return { present: true, problem: `${COMPLETENESS_FILE} is not a regular file under the product docs folder` };
    }
    text = readFileSync(real, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { present: false };
    return { present: true, problem: `${COMPLETENESS_FILE} could not be read: ${(error as Error).message}` };
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { return { present: true, problem: `${COMPLETENESS_FILE} is not JSON: ${(error as Error).message}` }; }
  if (!Value.Check(ProductCompleteness, value)) return { present: true, problem: `${COMPLETENESS_FILE} does not match the published completeness schema` };
  return { present: true, snapshot: value as ProductCompletenessData };
}
