/**
 * `bun run views:check` (design.md, "Checks"): checks the rendered views
 * against the tools that will read them: Mermaid's parser on every
 * ```mermaid block of the pages under each `--mermaid <folder>`, and
 * `likec4 validate` on each `--likec4 <folder>` as a workspace; with no
 * arguments, the reference system's `views/mermaid/` and `views/likec4/`.
 * Each check is one function this script calls. Exits 1 naming the file,
 * the line and the error of every failure of either check, and 2 for
 * arguments it does not understand. CI runs it after the tests.
 */
import { LIKEC4_FOLDER, MERMAID_FOLDER } from './render-views.js';
import { checkLikeC4Workspaces } from './likec4-check.js';
import { checkMermaidPages, type ViewCheckError } from './mermaid-check.js';

const USAGE = 'usage: bun run views:check [--mermaid <folder>]... [--likec4 <folder>]...';

interface Folders {
  mermaid: string[];
  likec4: string[];
}

/** The folders each check is given, or `undefined` for arguments that are not a check's flag followed by its folder. */
function foldersOf(args: readonly string[]): Folders | undefined {
  if (args.length === 0) return { mermaid: [MERMAID_FOLDER], likec4: [LIKEC4_FOLDER] };
  const folders: Folders = { mermaid: [], likec4: [] };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const folder = args[i + 1];
    if (folder === undefined || folder.startsWith('--')) return undefined;
    if (flag === '--mermaid') folders.mermaid.push(folder);
    else if (flag === '--likec4') folders.likec4.push(folder);
    else return undefined;
  }
  return folders;
}

function report(errors: readonly ViewCheckError[]): void {
  for (const error of errors) console.error(`error: ${error.file}:${error.line}: ${error.message}`);
}

async function main(): Promise<void> {
  const folders = foldersOf(process.argv.slice(2));
  if (folders === undefined) {
    console.error(`error: ${USAGE}`);
    process.exit(2);
  }
  let failed = false;
  if (folders.mermaid.length > 0) {
    const mermaid = await checkMermaidPages(folders.mermaid);
    report(mermaid.errors);
    console.log(`mermaid: checked ${mermaid.blocks} blocks in ${mermaid.pages} pages, ${mermaid.errors.length} errors`);
    failed ||= mermaid.errors.length > 0;
  }
  if (folders.likec4.length > 0) {
    const likec4 = checkLikeC4Workspaces(folders.likec4);
    report(likec4.errors);
    console.log(`likec4: checked ${likec4.files} files, ${likec4.errors.length} errors`);
    failed ||= likec4.errors.length > 0;
  }
  if (failed) process.exit(1);
}

if (import.meta.main) {
  await main();
}
