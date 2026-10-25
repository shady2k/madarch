/** One renderer-specific title definition for fitting and browser evidence. No captions or ER attributes are titles. */
export interface DiagramTitleNode {
  querySelectorAll(selector: string): ArrayLike<DiagramTitleNode>;
  querySelector(selector: string): DiagramTitleNode | null;
  closest(selector: string): DiagramTitleNode | null;
  getAttribute(name: string): string | null;
  readonly parentElement: DiagramTitleNode | null;
  readonly shadowRoot?: DiagramTitleRoot | null;
}
export interface DiagramTitleRoot {
  querySelectorAll(selector: string): ArrayLike<DiagramTitleNode>;
}

/** Kept self-contained so the same implementation can run in the embedded frame and acceptance browser. */
export function diagramTitleNodes(root: DiagramTitleRoot, renderer: string, type: string): { title: DiagramTitleNode; node: DiagramTitleNode }[] {
  const all = (at: DiagramTitleRoot, selector: string): DiagramTitleNode[] => {
    const found = Array.from(at.querySelectorAll(selector));
    for (const node of Array.from(at.querySelectorAll('*'))) if (node.shadowRoot) found.push(...all(node.shadowRoot, selector));
    return [...new Set(found)];
  };
  if (renderer === 'likec4') {
    const pairs = all(root, '[data-likec4-node-title], .likec4-compound-title').map(title => ({ title, node: title.closest('.react-flow__node') ?? title }));
    for (const node of all(root, '.react-flow__node')) if (!pairs.some(pair => pair.node === node)) throw new Error('LikeC4 node has no supported title: ' + (node.getAttribute('data-id') ?? '(unnamed)'));
    return pairs;
  }
  if (renderer === 'archify') return all(root, 'text[data-node-label], text[data-boundary-label]').map(title => {
    if (title.getAttribute('data-boundary-label') !== null) {
      const frame = title.closest('[data-composition-frame-id]');
      const id = frame?.getAttribute('data-composition-frame-id');
      const node = all(root, '[data-graph-role="structural-frame"]').find(candidate => candidate.getAttribute('data-composition-frame-id') === id);
      if (!node) throw new Error('Archify boundary title has no associated frame: ' + String(id));
      return { title, node };
    }
    return { title, node: title.closest('g[id^="node-"]') ?? title };
  });
  if (renderer !== 'mermaid') return [];
  if (type === 'sequence') return all(root, 'text.actor').filter(title => !title.closest('.actorPopupMenu')).map(title => ({ title, node: title.parentElement ?? title }));
  if (type === 'er') return all(root, 'g.node').flatMap(node => {
    const title = node.querySelector('g.name, .entityTitleText') ?? node.querySelector('g.label');
    if (!title) throw new Error('Mermaid node has no supported title: ' + (node.getAttribute('id') ?? '(unnamed)'));
    return [{ title, node }];
  });
  return all(root, 'g.node, g.cluster').flatMap(node => {
    const title = Array.from(node.querySelectorAll('.cluster-label, .nodeLabel, .state-title, g.label')).find(candidate => candidate.closest('g.node, g.cluster') === node);
    if (!title) throw new Error('Mermaid node has no supported title: ' + (node.getAttribute('id') ?? '(unnamed)'));
    return [{ title, node }];
  });
}
