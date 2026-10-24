/** Browser-side evidence for one renderer, scoped to one views block (or its own archify document). */
export const DIAGRAM_MEASURES = String.raw`(async (options) => {
  const fail = (message) => { throw new Error(message); };
  const block = options.renderer === 'archify' ? document : document.querySelectorAll('[data-diagram=views]')[options.blockAt];
  if (!block) fail('views block is absent');
  const deep = (root, selector) => {
    const result = [...root.querySelectorAll(selector)];
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) result.push(...deep(node.shadowRoot, selector));
    return result;
  };
  const unique = (nodes) => [...new Set(nodes)];
  const parent = (node) => node.parentElement || node.getRootNode().host || null;
  const plain = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top });
  const union = (rects) => {
    if (!rects.length) return null;
    return plain({ left: Math.min(...rects.map(r => r.left)), top: Math.min(...rects.map(r => r.top)), right: Math.max(...rects.map(r => r.right)), bottom: Math.max(...rects.map(r => r.bottom)) });
  };
  const intersection = (a, b) => plain({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const inside = (a, b) => a.width > 0 && a.height > 0 && a.left >= b.left - 0.5 && a.top >= b.top - 0.5 && a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5;
  const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const scaleOf = (node) => {
    if (node instanceof SVGGraphicsElement) {
      const m = node.getScreenCTM();
      if (!m) fail('SVG has no screen matrix');
      return Math.hypot(m.a, m.b);
    }
    if (node instanceof HTMLElement) {
      let scale = 1;
      for (let at = node; at; at = parent(at)) {
        if (at instanceof SVGGraphicsElement) return scale * scaleOf(at);
        const m = new DOMMatrixReadOnly(getComputedStyle(at).transform);
        scale *= Math.hypot(m.a, m.b);
      }
      return scale;
    }
    fail('cannot measure scale of ' + node.tagName);
  };
  const textRect = (node) => {
    // Ranges include text outside a clipped/line-clamped HTML label. A CSS-sized div alone would hide truncation.
    if (!(node instanceof SVGElement)) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
      if (rects.length) return union(rects);
    }
    return plain(node.getBoundingClientRect());
  };
  const clippedViewport = (node, viewport) => {
    let box = viewport;
    for (let at = node; at && at !== document.documentElement; at = parent(at)) {
      const style = getComputedStyle(at);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      const r = at.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) box = intersection(box, { left: r.left, right: r.right, top: box.top, bottom: box.bottom });
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) box = intersection(box, { left: box.left, right: box.right, top: r.top, bottom: r.bottom });
    }
    return box;
  };
  let root, viewportNode, svg, titleNodes, edges, contentNodes;
  if (options.renderer === 'archify') {
    root = document.querySelector('.diagram-container');
    svg = root && root.querySelector('svg');
    if (!svg) fail('.diagram-container svg is absent');
    viewportNode = root;
    const nodes = [...svg.querySelectorAll('g[id^="node-"]')];
    titleNodes = nodes.map(n => n.querySelector('text[data-node-label]'));
    if (titleNodes.some(n => !n)) fail('an archify node group has no text[data-node-label]');
    edges = [...svg.querySelectorAll('[data-edge-label] text')];
    contentNodes = [svg];
  } else if (options.renderer === 'likec4') {
    root = block.querySelector('[data-testid=view-frame-likec4]');
    if (!root) fail('LikeC4 frame is absent');
    viewportNode = deep(root, '.react-flow')[0];
    if (!viewportNode) fail('LikeC4 .react-flow viewport is absent');
    titleNodes = deep(root, '[data-likec4-node-title], .likec4-compound-title');
    edges = deep(root, '.likec4-edge-label');
    contentNodes = deep(root, '.react-flow__node, .react-flow__edge, .likec4-edge-label');
  } else if (options.renderer === 'mermaid') {
    root = block.querySelector('[data-testid=view-picture] [data-testid=mermaid-diagram]');
    svg = root && root.querySelector('svg');
    viewportNode = block.querySelector('[data-testid=zoom-box]');
    if (!svg || !viewportNode) fail('Mermaid svg or zoom viewport is absent');
    const type = block.querySelector('[data-testid=view]').getAttribute('data-view');
    if (type === 'sequence') {
      // Each actor header/footer is one title, even when Mermaid splits it into several text lines.
      titleNodes = unique([...svg.querySelectorAll('text.actor')].filter(n => !n.closest('.actorPopupMenu')).map(n => n.parentElement));
    } else if (type === 'er') {
      titleNodes = [...svg.querySelectorAll('g.node')].map(n => n.querySelector('g.name') || n.querySelector('g.label, .nodeLabel'));
      if (titleNodes.some(n => !n)) fail('an ER node has no name/title label');
    } else {
      const nodes = [...svg.querySelectorAll('g.node, g.cluster')];
      titleNodes = nodes.map(n => {
        const title = n.querySelector('.nodeLabel, .cluster-label, .state-title, g.label');
        if (!title && (n.textContent || '').trim()) fail('a Mermaid node has text but no supported title selector: ' + n.id);
        return title;
      }).filter(Boolean);
    }
    edges = [...svg.querySelectorAll('g.edgeLabel, text.messageText, text.transition, .relationshipLabel')];
    contentNodes = [svg];
  } else fail('unknown renderer ' + options.renderer);
  titleNodes = unique(titleNodes);
  if (options.renderer === 'likec4') {
    for (const node of deep(root, '.react-flow__node')) {
      if (!deep(node, '[data-likec4-node-title], .likec4-compound-title').length) fail('a LikeC4 node has no title selector: ' + node.getAttribute('data-id'));
    }
  }
  if (!titleNodes.length) fail('renderer-specific node-title selector found no titles');
  if (!contentNodes.length) fail('renderer content bounds are absent');
  const viewportOf = () => {
    const rect = viewportNode.getBoundingClientRect();
    const sx = viewportNode.offsetWidth > 0 ? rect.width / viewportNode.offsetWidth : 1;
    const sy = viewportNode.offsetHeight > 0 ? rect.height / viewportNode.offsetHeight : 1;
    const client = { left: rect.left + viewportNode.clientLeft * sx, top: rect.top + viewportNode.clientTop * sy, right: rect.left + (viewportNode.clientLeft + viewportNode.clientWidth) * sx, bottom: rect.top + (viewportNode.clientTop + viewportNode.clientHeight) * sy };
    let box = intersection(client, options.parentViewport || { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    for (let at = parent(viewportNode); at && at !== document.documentElement; at = parent(at)) {
      const style = getComputedStyle(at), r = at.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) box = intersection(box, { left: r.left, right: r.right, top: box.top, bottom: box.bottom });
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) box = intersection(box, { left: box.left, right: box.right, top: r.top, bottom: r.bottom });
    }
    return box;
  };
  if (document.fonts) await document.fonts.ready;
  // ResizeObserver, React effects, and renderer fitting must finish before the evidence and the screenshot.
  const tick = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  let last = '', stable = 0;
  for (let attempt = 0; attempt < 120; attempt++) {
    await tick();
    const signature = JSON.stringify([viewportOf(), ...contentNodes.map(n => plain(n.getBoundingClientRect())), ...titleNodes.map(n => plain(n.getBoundingClientRect()))]);
    stable = signature === last ? stable + 1 : 0;
    last = signature;
    if (stable >= 3) break;
    if (attempt === 119) fail('renderer geometry did not settle after resize in 120 double frames');
  }
  const viewport = viewportOf();
  if (viewport.width <= 0 || viewport.height <= 0) fail('renderer viewport has no visible area');
  const titleEntries = titleNodes.map((node, index) => {
    let leaves = [node];
    if (node instanceof SVGElement && !node.matches('text, tspan')) {
      const svgTexts = [...node.querySelectorAll('text')];
      const htmlTexts = [...node.querySelectorAll('foreignObject p')];
      leaves = svgTexts.length ? svgTexts : htmlTexts.length ? htmlTexts : [node];
    }
    const sizes = leaves.map(n => parseFloat(getComputedStyle(n).fontSize) * scaleOf(n));
    if (sizes.some(n => !Number.isFinite(n) || n <= 0)) fail('invalid rendered font size for title ' + index);
    const rect = node instanceof SVGElement ? union(leaves.map(textRect)) : textRect(node);
    const clip = clippedViewport(node, viewport);
    const localTruncation = leaves.some(n => n instanceof HTMLElement && (n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1));
    const full = rect && clip && inside(rect, clip) && !localTruncation;
    const partial = rect && clip && intersects(rect, clip) && !full;
    return { name: (node instanceof SVGElement ? leaves.map(n => n.textContent || '').join(' ') : node.textContent || '').trim(), index, rect, smallestPx: Math.min(...sizes), full: Boolean(full), partial: Boolean(partial), localTruncation };
  });
  if (titleEntries.some(t => !t.name)) fail('a node-title selector produced an empty title');
  const visible = titleEntries.filter(t => t.full).map(t => t.name);
  const clipped = titleEntries.filter(t => t.partial).map(t => t.name);
  const edgeEntries = unique(edges).filter(n => (n.textContent || '').trim()).map(node => {
    const rect = textRect(node), clip = clippedViewport(node, viewport);
    return { name: node.textContent.trim(), rect, clipped: Boolean(rect && clip && intersects(rect, clip) && !inside(rect, clip)), rightClipped: Boolean(rect && clip && intersects(rect, clip) && rect.right > clip.right + 0.5) };
  });
  const allText = unique(deep(root, 'text, foreignObject p, [data-likec4-node-title], [data-likec4-node-technology], [data-likec4-node-description], .likec4-compound-title, .likec4-edge-label')).filter(n => (n.textContent || '').trim() && n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0);
  const labelEntries = unique(allText).map(node => ({ name: node.textContent.trim(), rect: textRect(node), size: parseFloat(getComputedStyle(node).fontSize) * scaleOf(node) }));
  const overlaps = [];
  for (let i = 0; i < labelEntries.length; i++) for (let j = i + 1; j < labelEntries.length; j++) {
    const a = labelEntries[i], b = labelEntries[j];
    if (!a.rect || !b.rect || allText[i].contains(allText[j]) || allText[j].contains(allText[i])) continue;
    if (Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1.5 && Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1.5) overlaps.push(a.name + ' / ' + b.name);
  }
  const contentBounds = union(contentNodes.map(n => plain(n.getBoundingClientRect())));
  let scale;
  if (options.renderer === 'likec4') {
    const flow = deep(root, '.react-flow__viewport')[0];
    if (!flow) fail('LikeC4 transform is absent');
    const m = new DOMMatrixReadOnly(getComputedStyle(flow).transform);
    scale = Math.hypot(m.a, m.b);
  } else scale = scaleOf(svg);
  if (!Number.isFinite(scale) || scale <= 0) fail('invalid renderer scale');
  return {
    measurementStatus: 'measured', wholeFit: Boolean(contentBounds && inside(contentBounds, viewport)), scale,
    readingWindowValid: (options.renderer === 'likec4' ? deep(root, '[data-reading-window-valid]')[0] : svg)?.getAttribute('data-reading-window-valid') ?? null,
    titleFloorTolerancePx: 0.01,
    smallestTitlePx: Math.min(...titleEntries.map(t => t.smallestPx)),
    titlesVisibleInFull: { count: visible.length, names: visible }, clippedTitles: clipped, clippedTitleCount: clipped.length,
    totalTitles: titleEntries.length, titles: titleEntries, viewport, contentBounds,
    clippedEdgeLabels: edgeEntries.filter(e => e.clipped).map(e => e.name), clippedEdgeLabelCount: edgeEntries.filter(e => e.clipped).length,
    rightClippedEdgeLabels: edgeEntries.filter(e => e.rightClipped).map(e => e.name), totalEdgeLabels: edgeEntries.length,
    texts: labelEntries.length, minFontPx: labelEntries.length ? Math.min(...labelEntries.map(e => e.size)) : null,
    overlaps, overlapCount: overlaps.length
  };
})`;
