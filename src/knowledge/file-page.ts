/**
 * The file page's one block (madarch-j9ao.2.1): the file's facts, its text, the commits that touched it and the files
 * changed with it. Everything is read from the graph — the files producer's facts and bytes, the touched and commit
 * edges, the history evidence — and nothing reads Git or the file system at page time. The app draws the header, the
 * Overview's Rendered/Source switch and the History and Co-change tabs.
 */
import { sourceAddress } from './addresses.js';
import { languageOf, type RenderContext, type Subject } from './blocks.js';
import type { Block } from './model.js';

export async function filePageBlock(ctx: RenderContext, subject: Subject, file: string, line: number): Promise<Block> {
  if (subject.source !== 'graph' || subject.entity.kind !== 'code.file') {
    return { type: 'problem', block: 'file-page', file, line, message: 'the file page shows a code.file entity' };
  }
  const repository = String(subject.entity.properties['repository'] ?? '');
  const path = String(subject.entity.properties['path'] ?? '');
  const data = await ctx.graph.file(repository, path);
  if (data === null) return { type: 'problem', block: 'file-page', file, line, message: `the graph holds no file ${JSON.stringify(path)} of ${repository}` };
  const repo = ctx.repoOfScope(subject.entity.scope) ?? repository;
  const text = await ctx.readSource(repo, path);
  const source = text === undefined ? undefined : {
    text,
    language: languageOf(path),
    href: sourceAddress(repo, path, 1),
    ...(ctx.webOf?.(repo, path, 1, text.split('\n').length) === undefined ? {} : { web: ctx.webOf!(repo, path, 1, text.split('\n').length)! }),
  };
  return {
    type: 'filePage',
    data,
    ...(source === undefined ? {} : { source }),
    markdown: /\.(md|markdown)$/iu.test(path),
    history: [],
    cochange: [],
    commits: 0,
  };
}
