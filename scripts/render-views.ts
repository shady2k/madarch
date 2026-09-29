/**
 * Renders the views of the invented reference system into its `views/`
 * folder (see design.md, "Checks"): loads and compiles
 * `examples/reference-system`, stores it as one version, builds the query
 * engine from that history and writes one Mermaid page per view into
 * `views/mermaid/`, removing the pages of views that no longer exist, and
 * the LikeC4 workspace into `views/likec4/model.c4`. Run with `bun run
 * views`; the tests of the reference system's committed views and
 * workspace fail if the committed files fall out of date with the model.
 * The writing itself is `writeViews`, shared with the model check's
 * views.
 *
 * The loading, storing and rendering itself lives in
 * `src/render/prepare.ts`, shared with the model check's views.
 *
 * The model has no history of its own, so it is stored and rendered at one
 * fixed moment, the day it was written: the pages change only when the
 * model or the renderer does, never with the clock.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRendering } from '../src/render/prepare.js';
import { writeViews } from '../src/render/write.js';

export const REFERENCE_SYSTEM = fileURLToPath(new URL('../examples/reference-system', import.meta.url));
export const VIEWS_FOLDER = join(REFERENCE_SYSTEM, 'views');
export const MERMAID_FOLDER = join(VIEWS_FOLDER, 'mermaid');
export const LIKEC4_FOLDER = join(VIEWS_FOLDER, 'likec4');
export const LIKEC4_FILE = join(LIKEC4_FOLDER, 'model.c4');

/** 2026-09-25T00:00:00Z: the version's commit time, the time it is stored at, and the valid and known time it is rendered at. */
export const REFERENCE_TIME = Date.UTC(2026, 8, 25);

export function renderReferenceSystem() {
  return prepareRendering(REFERENCE_SYSTEM, { source: 'reference-system', commit: 'working-tree', at: REFERENCE_TIME });
}

function main(): void {
  const { pages, workspace, notDrawn, errors, warnings } = renderReferenceSystem();
  for (const warning of warnings) console.error(`warning: ${warning}`);
  for (const line of notDrawn) console.error(`note: ${line}`);
  if (pages === undefined || workspace === undefined) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }
  const written = writeViews(VIEWS_FOLDER, pages, workspace);
  console.log(`wrote ${written.pageCount} pages into ${written.mermaidFolder}`);
  console.log(`wrote the LikeC4 workspace ${written.likec4File}`);
}

if (import.meta.main) {
  main();
}
