/**
 * The picture's layout, off the server's request path (decision 0036, sections 7 and 8): one long-lived process the server
 * hands pictures to, one line of JSON in and one line out. It starts once and stays warm, so a picture costs its layout
 * and not the module graph; a picture that runs long is killed by the parent, which starts a new one for the next.
 */
import type { DiagramGraph } from './diagram.js';
import { archifyDocument, likec4PictureOf, mermaidText } from './diagram.js';

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
  // The archify page's own renderer is a process of its own; this process hands its document to the server, which
  // starts that renderer — a process cannot start the vendored renderer from inside this one.
  return { kind: 'archify-document', document: archifyDocument(graph, liked) };
}

// Ready once its modules are loaded — the layout engine's too: the parent's deadline starts with the picture, not with
// starting this process or reading the engine's module graph.
await import('likec4');
console.log(JSON.stringify({ kind: 'ready' }));

let held = '';
for await (const chunk of Bun.stdin.stream()) {
  held += Buffer.from(chunk).toString('utf8');
  let end = held.indexOf('\n');
  while (end >= 0) {
    const line = held.slice(0, end).trim();
    held = held.slice(end + 1);
    end = held.indexOf('\n');
    if (line === '') continue;
    try {
      const started = performance.now();
      const held = await answer(JSON.parse(line) as Asked);
      console.log(JSON.stringify({ ...held, ms: Math.round(performance.now() - started) }));
    } catch (error) {
      console.log(JSON.stringify({ kind: 'error', message: error instanceof Error ? error.message : String(error) }));
    }
  }
}
