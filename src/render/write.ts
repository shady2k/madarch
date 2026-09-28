/**
 * Writes a rendering into a folder the caller names: the Mermaid pages
 * into `<folder>/mermaid/`, the LikeC4 workspace into
 * `<folder>/likec4/model.c4`. The folder is created when it is missing,
 * and the pages of views that no longer exist are removed, so a folder
 * written twice holds exactly the views of the model it was last written
 * from — the same layout the reference system's `views/` folder has.
 * `scripts/render-views.ts` and the model check's views write through
 * this one function, so neither keeps its own copy of the writing.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MermaidPage } from './mermaid.js';

export interface WrittenViews {
  /** The folder the pages were written into. */
  mermaidFolder: string;
  /** The file the LikeC4 workspace was written to. */
  likec4File: string;
  /** The number of pages written. */
  pageCount: number;
}

export function writeViews(folder: string, pages: readonly MermaidPage[], workspace: string): WrittenViews {
  const mermaidFolder = join(folder, 'mermaid');
  mkdirSync(mermaidFolder, { recursive: true });
  const written = new Set(pages.map((page) => page.file));
  for (const file of readdirSync(mermaidFolder)) {
    if (file.endsWith('.md') && !written.has(file)) unlinkSync(join(mermaidFolder, file));
  }
  for (const page of pages) writeFileSync(join(mermaidFolder, page.file), page.content);
  const likec4File = join(folder, 'likec4', 'model.c4');
  mkdirSync(join(folder, 'likec4'), { recursive: true });
  writeFileSync(likec4File, workspace);
  return { mermaidFolder, likec4File, pageCount: pages.length };
}
