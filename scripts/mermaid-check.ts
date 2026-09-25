/**
 * The Mermaid half of `bun run views:check` (design.md, "Checks"): every
 * ```mermaid block of every Markdown page under the given folders must be
 * accepted by Mermaid's own parser (the views capability's mermaid
 * requirement). Mermaid needs a DOM for its sanitizer, so happy-dom's
 * globals are registered for the length of one check, before Mermaid is
 * first imported, and removed again afterwards so they never leak into the
 * rest of the process.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { byCodePoint } from '../src/model/order.js';

export interface ViewCheckError {
  /** The page, or the folder when the problem is the folder itself; empty when no folder was given. */
  file: string;
  /** 1-based line of the block's opening fence in the page; 0 when the problem is not one block. */
  line: number;
  message: string;
}

export interface MermaidCheckResult {
  /** How many Markdown pages were read. */
  pages: number;
  /** How many mermaid blocks were handed to the parser. */
  blocks: number;
  /** Every problem found, in folder, page and line order; empty only when every block parsed. */
  errors: ViewCheckError[];
}

interface Block {
  line: number;
  source: string;
  closed: boolean;
}

/** The ```mermaid blocks of one page, each with the line of its opening fence. */
function mermaidBlocks(content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '```mermaid') continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && lines[i]!.trimEnd() !== '```'; i++) body.push(lines[i]!);
    blocks.push({ line: start + 1, source: body.join('\n'), closed: i < lines.length });
  }
  return blocks;
}

/** Every `.md` file under `folder`, at any depth, in code point order of its path. */
function markdownPages(folder: string): string[] {
  const pages: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) pages.push(...markdownPages(path));
    else if (entry.name.endsWith('.md')) pages.push(path);
  }
  return pages.sort(byCodePoint);
}

type Parse = (source: string) => Promise<unknown>;

async function withMermaid<T>(use: (parse: Parse) => Promise<T>): Promise<T> {
  GlobalRegistrator.register();
  try {
    const { default: mermaid } = await import('mermaid');
    return await use((source) => mermaid.parse(source));
  } finally {
    await GlobalRegistrator.unregister();
  }
}

/**
 * Parses every mermaid block of every Markdown page under `folders`. A
 * folder that cannot be read or holds no pages, a page with no mermaid
 * block and a block never closed are errors too: a check that checks
 * nothing does not pass.
 */
export async function checkMermaidPages(folders: readonly string[]): Promise<MermaidCheckResult> {
  const result: MermaidCheckResult = { pages: 0, blocks: 0, errors: [] };
  if (folders.length === 0) {
    result.errors.push({ file: '', line: 0, message: 'no folders to check' });
    return result;
  }
  await withMermaid(async (parse) => {
    for (const folder of folders) {
      let pages: string[];
      try {
        pages = markdownPages(folder);
      } catch (error) {
        result.errors.push({ file: folder, line: 0, message: `cannot read the folder: ${(error as Error).message}` });
        continue;
      }
      if (pages.length === 0) result.errors.push({ file: folder, line: 0, message: 'no Markdown pages to check' });
      for (const page of pages) {
        result.pages++;
        const blocks = mermaidBlocks(readFileSync(page, 'utf8'));
        if (blocks.length === 0) result.errors.push({ file: page, line: 0, message: 'the page has no mermaid block' });
        for (const block of blocks) {
          result.blocks++;
          if (!block.closed) {
            result.errors.push({ file: page, line: block.line, message: 'the mermaid block is never closed' });
            continue;
          }
          try {
            await parse(block.source);
          } catch (error) {
            result.errors.push({ file: page, line: block.line, message: (error as Error).message });
          }
        }
      }
    }
  });
  return result;
}
