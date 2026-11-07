/**
 * The pages and questions of a served repository (madarch-ztyq.10): the
 * `PageSink` the seven tools' page reads take, and the questions
 * `search_questions` searches.
 *
 * The sink is read-only by construction: `madarch mcp` serves a person's
 * checkout to an agent, and an agent that could write through it would write a
 * file the person never asked for. A write is refused with the rule, not
 * swallowed.
 *
 * A page's text is the working tree's when the working tree changed the file,
 * and the graph's otherwise — the same rule every other read follows.
 */
import { resolve } from 'node:path';
import { parseQuestion, type Question } from '../loop/entities.js';
import type { GraphView } from '../writer/view.js';
import type { PageSink } from '../writer/tools.js';
import { readCommitFile } from './git.js';

/**
 * The pages of one repository as the page tools read them: the store's own document
 * list and the commit's bytes. Nothing is re-extracted here, and no answer is the
 * working tree's: a file the checkout changed since the filled commit is named by
 * every answer's source, and its text stays the commit's.
 */
export class RepositoryPages implements PageSink {
  constructor(private readonly view: GraphView, readonly repository: string, private readonly commit: string) {}

  /** The repository's Markdown documents, as the store lists them. */
  async documents(): Promise<string[]> {
    return await this.view.documentPaths();
  }

  async write(relativePath: string): Promise<void> {
    throw new Error(`${resolve(this.repository, relativePath)}:1: madarch mcp is read-only: the tool that writes pages is not served, so nothing was written (src/mcp/pages.ts)`);
  }

  async read(relativePath: string): Promise<string> {
    const bytes = readCommitFile(this.repository, this.commit, relativePath);
    if (bytes === null) throw new Error(`${resolve(this.repository, relativePath)}:1: the commit ${this.commit} holds no ${relativePath} (src/mcp/pages.ts)`);
    return new TextDecoder().decode(bytes);
  }

  async list(folder: string): Promise<string[]> {
    const prefix = `${folder}/`;
    return (await this.documents()).filter((path) => path.startsWith(prefix));
  }
}

/** The questions of one repository: every file of `docs/questions`, read as the writer reads it. */
export async function repositoryQuestions(pages: RepositoryPages): Promise<readonly Question[]> {
  const found: Question[] = [];
  for (const file of (await pages.documents()).filter((path) => path.startsWith('docs/questions/'))) {
    const source = await pages.read(file).catch((error: unknown) => {
      throw new Error(`${resolve(pages.repository, file)}:1: the question file could not be read: ${error instanceof Error ? error.message : String(error)} (src/mcp/pages.ts)`);
    });
    found.push(parseQuestion(file, source));
  }
  return found.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
