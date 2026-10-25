/** The reader's first view: title-based fit, otherwise a top-left reading window without cut titles. */
export interface RectBox { x: number; y: number; width: number; height: number }
export interface TitleBox extends RectBox { font: number; node?: RectBox }
export function firstView(bounds: { x: number; y: number; width: number; height: number }, titles: readonly TitleBox[], width: number, height: number, full: boolean, labels: readonly TitleBox[] = []): { x: number; y: number; zoom: number; whole: boolean; readable: boolean } {
  const pad = 12;
  const fit = Math.min((width - 2 * pad) / bounds.width, (height - 2 * pad) / bounds.height);
  const floor = (full ? 9 : 11) / (titles.length ? Math.min(...titles.map((t) => t.font)) : 14);
  if (fit >= floor) { const zoom = Math.min(fit, Math.max(1, floor)); return { zoom, x: (width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (height - bounds.height * zoom) / 2 - bounds.y * zoom, whole: true, readable: true }; }
  // A layout can start with empty canvas at the left. Search reading-window boundaries, not the diagram centre.
  // Keep the earliest row, then the leftmost complete titles. Never silently accept a title cut at the floor.
  const first = [...titles].sort((a, b) => a.y - b.y || a.x - b.x)[0];
  const obstacles = [...titles, ...labels];
  const boundaries = [...obstacles, ...titles.flatMap(title => title.node ? [title.node] : [])];
  const xs = [...new Set([bounds.x, ...boundaries.flatMap(t => [t.x - pad / floor, t.x + t.width + pad / floor, t.x + t.width - (width - pad) / floor])])].sort((a, b) => a - b);
  const ys = [...new Set([bounds.y, ...boundaries.map(t => t.y - pad / floor)])].sort((a, b) => a - b);
  for (const top of ys) for (const left of xs) {
    if (top < bounds.y || left < bounds.x) continue;
    const x = pad - left * floor, y = pad - top * floor;
    // A later cluster cannot stand in for the beginning. Keep the earliest content title in full.
    if (first && (x + first.x * floor < 0 || x + (first.x + first.width) * floor > width || y + first.y * floor < 0 || y + (first.y + first.height) * floor > height)) continue;
    let cuts = 0, visible = 0;
    for (const t of obstacles) {
      const l = x + t.x * floor, r = l + t.width * floor;
      const a = y + t.y * floor, b = a + t.height * floor;
      const titleInside = l >= 0 && r <= width && a >= 0 && b <= height;
      const node = t.node ?? t;
      const nl = x + node.x * floor, nr = nl + node.width * floor;
      const nt = y + node.y * floor, nb = nt + node.height * floor;
      const nodeVisible = nr > 0 && nl < width && nb > 0 && nt < height;
      if (nodeVisible && !titleInside) cuts++;
      else if (r > 0 && l < width && b > 0 && a < height) {
        if (!titleInside) cuts++; else if (titles.includes(t)) visible++;
      }
    }
    if (cuts === 0 && visible >= Math.min(2, titles.length)) return { zoom: floor, x, y, whole: false, readable: true };
  }
  // No window can meet the rule (for example one title wider than the frame). The caller must report that limit.
  return { zoom: floor, x: pad - (first?.x ?? bounds.x) * floor, y: pad - (first?.y ?? bounds.y) * floor, whole: false, readable: false };
}
