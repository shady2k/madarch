/**
 * Renders the views of the invented reference system into its `views/`
 * folder (see design.md, "Checks"): loads and compiles
 * `examples/reference-system`, stores it as one version, builds the query
 * engine from that history and writes one Mermaid page per view into
 * `views/mermaid/`, removing the pages of views that no longer exist. Run
 * with `bun run views`; the test `the reference system's committed views`
 * fails if the committed pages fall out of date with the model.
 *
 * The model has no history of its own, so it is stored and rendered at one
 * fixed moment, the day it was written: the pages change only when the
 * model or the renderer does, never with the clock.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildViewSet, createLadybugEngine, createSqliteHistory, loadAndCompileModel, renderMermaidPages, type MermaidPage } from '../src/index.js';

export const REFERENCE_SYSTEM = fileURLToPath(new URL('../examples/reference-system', import.meta.url));
export const MERMAID_FOLDER = join(REFERENCE_SYSTEM, 'views', 'mermaid');

/** 2026-09-25T00:00:00Z: the version's commit time, the time it is stored at, and the valid and known time it is rendered at. */
export const REFERENCE_TIME = Date.UTC(2026, 8, 25);

export interface RenderedReferenceSystem {
  /** Left out when there are errors. */
  pages?: MermaidPage[];
  /** Every problem that kept the pages from being rendered, one line each. */
  errors: string[];
  /** The model's warnings, one line each; they do not keep the pages from being rendered. */
  warnings: string[];
}

export function renderReferenceSystem(): RenderedReferenceSystem {
  const { model, errors, warnings } = loadAndCompileModel(REFERENCE_SYSTEM);
  const warningLines = warnings.map((w) => `${w.file}:${w.line}: ${w.path}: ${w.message}`);
  if (model === undefined) return { errors: errors.map((e) => `${e.file}:${e.line}: ${e.path}: ${e.message}`), warnings: warningLines };

  const history = createSqliteHistory({ clock: { now: () => REFERENCE_TIME } });
  const engine = createLadybugEngine();
  try {
    const stored = history.store({ source: 'reference-system', commit: 'working-tree', committedAt: REFERENCE_TIME, model });
    if (stored.errors.length > 0) return { errors: stored.errors.map((e) => `storing the model: ${e.message}`), warnings: warningLines };
    engine.rebuild(history.assertions());

    const viewSet = buildViewSet(engine, model, { valid: REFERENCE_TIME, known: REFERENCE_TIME });
    if (viewSet.views === undefined) return { errors: viewSet.errors.map((e) => e.message), warnings: warningLines };
    const rendered = renderMermaidPages(viewSet.views);
    if (rendered.pages === undefined) return { errors: rendered.errors.map((e) => e.message), warnings: warningLines };
    return { pages: rendered.pages, errors: [], warnings: warningLines };
  } finally {
    engine.close();
    history.close();
  }
}

function main(): void {
  const { pages, errors, warnings } = renderReferenceSystem();
  for (const warning of warnings) console.error(`warning: ${warning}`);
  if (pages === undefined) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }
  mkdirSync(MERMAID_FOLDER, { recursive: true });
  const written = new Set(pages.map((page) => page.file));
  for (const file of readdirSync(MERMAID_FOLDER)) {
    if (file.endsWith('.md') && !written.has(file)) unlinkSync(join(MERMAID_FOLDER, file));
  }
  for (const page of pages) writeFileSync(join(MERMAID_FOLDER, page.file), page.content);
  console.log(`wrote ${pages.length} pages into ${MERMAID_FOLDER}`);
}

if (import.meta.main) {
  main();
}
