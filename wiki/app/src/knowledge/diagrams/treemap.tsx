/**
 * The treemap of files (`:::treemap`): the area of a cell is the file's lines,
 * its warmth is how often the history changed it. A directory is a frame with its
 * name; a file is a link to its page. Churn is read from the commits that
 * touched the file, over the whole history the fill read.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { Block, TreemapFile } from '../types.js';
import { fit, layoutTreemap, textWidth, type TreeCell } from './layout.js';
import { useDiagramLink } from './open.js';

type TreemapBlock = Extract<Block, { type: 'treemap' }>;

export function TreemapView({ block }: { block: TreemapBlock }): ReactElement {
  const { t } = useTranslation();
  const link = useDiagramLink();
  const holder = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const measure = (): void => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const files = block.files.filter((file) => file.lines > 0);
  const compact = width > 0 && width < 560;
  const w = Math.max(280, width);
  const h = Math.round(Math.min(560, Math.max(compact ? 320 : 260, w * (compact ? 0.9 : 0.48))));
  const cells: TreeCell[] = width === 0 ? [] : layoutTreemap(files.map((file) => ({ id: file.id, name: file.path.slice(file.path.lastIndexOf('/') + 1), path: file.path, value: file.lines, data: file })), w, h);
  if (files.length === 0) {
    return (
      <section data-block="diagram" aria-label={block.title}>
        <h2>{block.title}</h2>
        <p className="text-small text-muted" data-testid="diagram-empty">{t('knowledge.diagram.noFiles')}</p>
      </section>
    );
  }
  const heat = (file: TreemapFile): number => (block.maxChurn === 0 ? 0 : Math.sqrt(file.churn / block.maxChurn));
  return (
    <section data-block="diagram" data-diagram="treemap" aria-label={block.title}>
      <h2>{block.title}</h2>
      <figure className="m-0">
        <div ref={holder} className="dg-treemap" data-testid="treemap">
          {width > 0 && (
            <svg className="dg-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="group" aria-label={block.title}>
              {cells.map((cell) => {
                const file = cell.leaf?.data as TreemapFile | undefined;
                if (file === undefined) {
                  return (
                    <g key={`dir:${cell.path}`} data-testid="treemap-dir">
                      <rect className="dg-tdir" x={cell.x} y={cell.y} width={cell.w} height={cell.h} />
                      {cell.h > 23 && cell.w > 40 && <text className="dg-tdirname" x={cell.x + 5} y={cell.y + 11}>{fit(cell.name, cell.w - 10, 10)}</text>}
                    </g>
                  );
                }
                const label = cell.w > 46 && cell.h > 16 ? fit(cell.name, cell.w - 8, 10) : '';
                const body = (
                  <>
                    <rect className="dg-tfile" x={cell.x} y={cell.y} width={Math.max(0, cell.w - 1)} height={Math.max(0, cell.h - 1)} style={{ ['--heat' as string]: String(heat(file).toFixed(3)) }} />
                    {label !== '' && <text className="dg-tname" x={cell.x + 4} y={cell.y + 12}>{label}</text>}
                    {label !== '' && cell.h > 30 && textWidth(`${file.lines}`, 10) < cell.w - 8 && <text className="dg-tsub" x={cell.x + 4} y={cell.y + 24}>{t('knowledge.diagram.linesN', { count: file.lines })}</text>}
                    <title>{`${file.path} — ${t('knowledge.diagram.linesN', { count: file.lines })}, ${t('knowledge.diagram.commitsN', { count: file.churn })}`}</title>
                  </>
                );
                return (
                  <g key={file.id} data-testid="treemap-file" data-churn={file.churn} data-lines={file.lines}>
                    {file.href === null ? <g>{body}</g> : <a {...link(file.href)}>{body}</a>}
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <figcaption className="dg-legend" data-testid="treemap-legend">
          <span className="dg-key">{t('knowledge.diagram.areaIsLines')}</span>
          <span className="dg-key"><span className="dg-ramp" aria-hidden="true" />{t('knowledge.diagram.heatIsChurn', { max: block.maxChurn })}</span>
          {block.notes.map((note) => <span key={note}>{note}</span>)}
        </figcaption>
      </figure>
    </section>
  );
}
