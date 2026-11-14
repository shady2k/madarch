/**
 * One picture's layout, off the server's request path (decision 0036, sections 7 and 8): the parent reads the bounded
 * neighbourhood and hands the picture's data here; this process draws it — LikeC4's workspace and layout, Mermaid's text,
 * archify's page — and answers one JSON line. A layout that runs long is this process's to lose: the parent kills it and
 * answers its own refusal, so no wiki page waits on a picture.
 */
import type { DiagramGraph } from './diagram.js';
import { archifyDocument, likec4PictureOf, mermaidText, renderArchify } from './diagram.js';

interface Asked {
  readonly format: 'likec4' | 'mermaid' | 'archify';
  readonly graph: DiagramGraph;
}

async function answer(asked: Asked): Promise<Record<string, unknown>> {
  const { graph, format } = asked;
  if (format === 'mermaid') {
    return { kind: 'json', body: { format: 'mermaid', entity: graph.entity, depth: graph.depth, folded: graph.folded, truncated: graph.truncated, source: mermaidText(graph) } };
  }
  const liked = await likec4PictureOf(graph);
  if (format === 'likec4') {
    return { kind: 'json', body: { format: 'likec4', entity: graph.entity, depth: graph.depth, folded: graph.folded, truncated: graph.truncated, workspace: liked.workspace, view: liked.view, links: liked.links } };
  }
  const html = await renderArchify(archifyDocument(graph, liked), graph);
  return { kind: 'html', html };
}

const chunks: Uint8Array[] = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
const text = Buffer.concat(chunks).toString('utf8');
try {
  const asked = JSON.parse(text) as Asked;
  console.log(JSON.stringify(await answer(asked)));
} catch (error) {
  console.log(JSON.stringify({ kind: 'error', message: error instanceof Error ? error.message : String(error) }));
}
