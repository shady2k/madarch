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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseQuestion, type Question } from '../loop/entities.js';
import type { GraphView } from '../writer/view.js';
import type { PageSink } from '../writer/tools.js';
import { readWorkingFile } from './git.js';
import type { WorkingLayer } from './layer.js';

/** The pages of one repository as the page tools read them. */
export class RepositoryPages implements PageSink {
  constructor(private readonly view: GraphView, readonly layer: WorkingLayer) {}

  /** The repository's Markdown documents, the working tree's list when it changed. */
  async documents(): Promise<string[]> {
    return await this.layer.documentPaths(await this.view.documentPaths());
  }

  async write(relativePath: string): Promise<void> {
    throw new Error(`${resolve(this.layer.repository, relativePath)}:1: madarch mcp is read-only: the tool that writes pages is not served, so nothing was written (src/mcp/pages.ts)`);
  }

  async read(relativePath: string): Promise<string> {
    if (this.layer.hides(relativePath)) {
      const bytes = readWorkingFile(this.layer.repository, relativePath);
      if (bytes === null) throw new Error(`${resolve(this.layer.repository, relativePath)}:1: the working tree holds no ${relativePath} (src/mcp/pages.ts)`);
      return new TextDecoder().decode(bytes);
    }
    const text = await this.view.fileText(relativePath);
    if (text === null) throw new Error(`${resolve(this.layer.repository, relativePath)}:1: the graph holds no text of ${relativePath} (src/mcp/pages.ts)`);
    return text;
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
    let source: string;
    try {
      source = await pages.read(file);
    } catch {
      // A question file the working tree removed between the listing and the read is not a question any more.
      if (!existsSync(resolve(pages.layer.repository, file))) continue;
      throw new Error(`${resolve(pages.layer.repository, file)}:1: the question file could not be read (src/mcp/pages.ts)`);
    }
    found.push(parseQuestion(file, source));
  }
  return found.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
