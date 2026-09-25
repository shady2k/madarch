/**
 * `bun run views:check` (design.md, "Checks"): checks the rendered views
 * against the tools that will read them. Today that is Mermaid's parser on
 * every ```mermaid block of the pages under the folders given as arguments,
 * by default the reference system's `views/mermaid/`; each check is one
 * function this script calls, so another tool's check sits beside it. Exits
 * non-zero naming the page, the line and the error of every failure. CI runs
 * it after the tests.
 */
import { MERMAID_FOLDER } from './render-views.js';
import { checkMermaidPages } from './mermaid-check.js';

async function main(): Promise<void> {
  const folders = process.argv.length > 2 ? process.argv.slice(2) : [MERMAID_FOLDER];
  const mermaid = await checkMermaidPages(folders);
  for (const error of mermaid.errors) console.error(`error: ${error.file}:${error.line}: ${error.message}`);
  console.log(`mermaid: checked ${mermaid.blocks} blocks in ${mermaid.pages} pages, ${mermaid.errors.length} errors`);
  if (mermaid.errors.length > 0) process.exit(1);
}

if (import.meta.main) {
  await main();
}
