/**
 * The archify pages of the wiki's diagrams (madarch-7br.3.1, lifted for
 * madarch-tzte.23.4 so the served app and the static build share one
 * implementation): the layout LikeC4 computes for a workspace's views, the
 * archify document of one of them (`archify.ts`), and the self-contained page the
 * vendored renderer writes from it.
 *
 * Both halves are pure of the clock and of the machine: the layout is LikeC4's
 * own and the document is `archifyDocument`'s, so the same workspace gives the
 * same page anywhere; only the page's text is a side effect of the renderer and
 * comes back to the caller as bytes.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchifyDocument, ArchifyLayoutedView, LayoutPoint } from './archify.js';

/** The madarch checkout the renderer is vendored in. */
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The vendored renderer the archify pages are made with, pinned at 3.0.1 (vendor/archify/README.md). */
export const ARCHIFY_RENDERER = join(PACKAGE_ROOT, 'vendor', 'archify', 'renderers', 'architecture', 'render-architecture.mjs');

/**
 * The layout LikeC4 computed for every view of the workspace: node
 * positions, sizes, groups and edges, exactly what the archify document
 * is built from. A view the layout pass skipped is absent from the map, and a
 * caller that needs it says so by name.
 */
export async function layoutedViews(workspace: string): Promise<Map<string, ArchifyLayoutedView>> {
  const { LikeC4 } = await import('likec4');
  const likec4 = await LikeC4.fromSource(workspace, { logger: false, printErrors: false, throwIfInvalid: true });
  try {
    const views = new Map<string, ArchifyLayoutedView>();
    for (const diagram of (await likec4.diagrams()) as unknown as ReadonlyArray<Record<string, unknown>>) {
      const id = diagram.id as string;
      const nodes = (diagram.nodes as ReadonlyArray<Record<string, unknown>>).map((node) => ({
        id: node.id as string,
        kind: (node.kind as string | undefined) ?? 'external',
        title: node.title as string,
        parent: (node.parent as string | null) ?? null,
        x: node.x as number,
        y: node.y as number,
        width: node.width as number,
        height: node.height as number,
      }));
      const edges = (diagram.edges as ReadonlyArray<Record<string, unknown>>).map((edge) => ({
        source: edge.source as string,
        target: edge.target as string,
        ...(edge.label === undefined ? {} : { label: edge.label as string }),
        ...(edge.labelBBox === undefined
          ? {}
          : {
              labelAt: [
                (edge.labelBBox as { x: number; y: number; width: number; height: number }).x + (edge.labelBBox as { width: number }).width / 2,
                (edge.labelBBox as { x: number; y: number; height: number }).y + (edge.labelBBox as { height: number }).height / 2,
              ] as LayoutPoint,
            }),
      }));
      views.set(id, { id, title: diagram.title as string, nodes, edges });
    }
    return views;
  } finally {
    await likec4[Symbol.asyncDispose]?.();
  }
}

/**
 * How long the vendored renderer may run before it is killed: a render of a laid-out
 * view takes about a second, and a renderer that hangs must not hold its caller (a
 * server answers other readers meanwhile) open forever (madarch-1xq).
 */
const ARCHIFY_RENDER_TIMEOUT_MS = 120_000;

/**
 * Renders one archify document with the vendored renderer: document in,
 * self-contained page out. Bounded like every other external tool call here, and a
 * renderer that could not be run at all names why — a refusal that says nothing is
 * a refusal nobody can act on.
 */
export function renderArchifyPage(document: ArchifyDocument, input: string, output: string): { status: number | null; output: string } {
  writeFileSync(input, JSON.stringify(document));
  const run = spawnSync('node', [ARCHIFY_RENDERER, input, output], { encoding: 'utf8', timeout: ARCHIFY_RENDER_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (run.error !== undefined) {
    // A renderer that could not be started is a missing toolchain; one that was killed at the bound said nothing and
    // is reported as what it is.
    const timedOut = (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || run.signal === 'SIGKILL';
    return {
      status: run.status,
      output: timedOut
        ? `the archify renderer was killed after ${String(ARCHIFY_RENDER_TIMEOUT_MS / 1000)} s without writing a page`
        : `the archify renderer at ${ARCHIFY_RENDERER} could not be run: ${run.error.message} (it is run with node; install Node.js, https://nodejs.org/)`,
    };
  }
  const said = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  if (run.status !== 0 && said === '') {
    return { status: run.status, output: `the archify renderer said nothing and was ended with ${run.signal === null ? `status ${String(run.status)}` : `signal ${run.signal}`} after at most ${String(ARCHIFY_RENDER_TIMEOUT_MS / 1000)} s` };
  }
  return { status: run.status, output: said };
}
