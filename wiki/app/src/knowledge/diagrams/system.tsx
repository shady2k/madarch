/**
 * The system view (`:::system`, the C4 container level) and the module graph
 * of a service (`:::modules`): boxes laid out in layers from left to right,
 * links between them drawn as curves, each box a link to its page. The kind of
 * a link is told by its line (solid for HTTP, long dashes for gRPC, dots for
 * SQL, dash-dot for events) and by its word on the line, never by colour alone.
 */
import { type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { Block, SystemEdge } from '../types.js';
import { fit, layoutModules, layoutSystem, SYS_H, SYS_W, textWidth } from './layout.js';
import { useDiagramLink } from './open.js';
import { PanZoom } from './pan-zoom.js';

type SystemBlock = Extract<Block, { type: 'system' }>;
type ModulesBlock = Extract<Block, { type: 'modules' }>;

const VIA_CLASS: Record<SystemEdge['via'], string> = { http: 'dg-via-http', grpc: 'dg-via-grpc', sql: 'dg-via-sql', publishes: 'dg-via-event', consumes: 'dg-via-event' };

export function SystemView({ block }: { block: SystemBlock }): ReactElement {
  const { t } = useTranslation();
  const link = useDiagramLink();
  const layout = layoutSystem(block.nodes, block.edges);
  if (block.nodes.length === 0) {
    return (
      <section data-block="diagram" aria-label={block.title}>
        <h2>{block.title}</h2>
        <p className="text-small text-muted" data-testid="diagram-empty">{t('knowledge.diagram.noSystem')}</p>
      </section>
    );
  }
  const vias = [...new Set(block.edges.map((edge) => edge.via))];
  return (
    <section data-block="diagram" data-diagram="system" aria-label={block.title}>
      <h2>{block.title}</h2>
      <figure className="m-0">
        <PanZoom width={layout.width} height={layout.height} label={block.title} testId="system" floor={0.7}>
          <defs>
            <marker id="dg-sys-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path className="dg-headpath" d="M0,0 L10,5 L0,10 z" /></marker>
          </defs>
          <g>
            {layout.edges.map(({ edge, d }) => <path key={`${edge.from}|${edge.to}|${edge.via}`} className={`dg-edge ${VIA_CLASS[edge.via]}`} d={d} markerEnd="url(#dg-sys-head)" data-via={edge.via} />)}
          </g>
          <g>
            {layout.edges.map(({ edge, label }) => {
              const text = `${t(`knowledge.diagram.via.${edge.via}`)}${edge.via === 'http' || edge.via === 'grpc' ? ` ${edge.label}` : edge.via === 'sql' ? ` · ${edge.label}` : ''}`;
              const shown = fit(text, 150, 11);
              const w = textWidth(shown, 11) + 10;
              return (
                <g key={`${edge.from}|${edge.to}|${edge.via}`} data-testid="system-edge-label">
                  <rect className="dg-labelbg" x={label.x - w / 2} y={label.y - 9} width={w} height={17} rx="4" />
                  <text className="dg-edgelabel" x={label.x} y={label.y + 3} textAnchor="middle">{shown}</text>
                  <title>{`${text}${edge.count > 1 ? ` ×${edge.count}` : ''}`}</title>
                </g>
              );
            })}
          </g>
          <g>
            {layout.nodes.map(({ node, box }) => {
              const body = (
                <>
                  <rect className={`dg-node dg-sys-${node.kind}`} width={SYS_W} height={SYS_H} rx={node.kind === 'database' ? 22 : 8} />
                  <text className="dg-label" x={SYS_W / 2} y="23" textAnchor="middle">{fit(node.label, SYS_W - 20, 13)}</text>
                  <text className="dg-kind" x={SYS_W / 2} y="40" textAnchor="middle">{fit(node.sub === '' ? t(`knowledge.diagram.kind.${node.kind}`) : `${t(`knowledge.diagram.kind.${node.kind}`)} · ${node.sub}`, SYS_W - 16, 10)}</text>
                  <title>{`${node.label} — ${t(`knowledge.diagram.kind.${node.kind}`)}${node.sub === '' ? '' : ` · ${node.sub}`}`}</title>
                </>
              );
              return (
                <g key={node.id} transform={`translate(${box.x} ${box.y})`} data-testid="system-node" data-node={node.id}>
                  {node.href === null ? <g>{body}</g> : <a {...link(node.href)}>{body}</a>}
                </g>
              );
            })}
          </g>
        </PanZoom>
        <figcaption className="dg-legend" data-testid="system-legend">
          {vias.map((via) => (
            <span key={via} className="dg-key"><svg width="34" height="10" aria-hidden="true"><line className={`dg-edge ${VIA_CLASS[via]}`} x1="0" x2="34" y1="5" y2="5" /></svg>{t(`knowledge.diagram.via.${via}`)}</span>
          ))}
          {block.notes.map((note) => <span key={note}>{note}</span>)}
        </figcaption>
      </figure>
    </section>
  );
}

export function ModulesView({ block }: { block: ModulesBlock }): ReactElement {
  const { t } = useTranslation();
  const link = useDiagramLink();
  const layout = layoutModules(block.nodes, block.edges);
  if (block.nodes.length === 0) {
    return (
      <section data-block="diagram" aria-label={block.title}>
        <h2>{block.title}</h2>
        <p className="text-small text-muted" data-testid="diagram-empty">{t('knowledge.diagram.noModules')}</p>
      </section>
    );
  }
  const names = new Map(block.nodes.map((node) => [node.id, node.label]));
  return (
    <section data-block="diagram" data-diagram="modules" aria-label={block.title}>
      <h2>{block.title}</h2>
      <figure className="m-0">
        <PanZoom width={layout.width} height={layout.height} label={block.title} testId="modules" floor={0.7}>
          <defs>
            <marker id="dg-mod-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path className="dg-headpath" d="M0,0 L10,5 L0,10 z" /></marker>
            <marker id="dg-mod-head-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path className="dg-headpath dg-cycle-fill" d="M0,0 L10,5 L0,10 z" /></marker>
          </defs>
          <g>
            {layout.edges.map(({ edge, d }) => <path key={`${edge.from}|${edge.to}`} className={`dg-edge${edge.cycle ? ' dg-cycle' : ''}`} d={d} markerEnd={edge.cycle ? 'url(#dg-mod-head-cycle)' : 'url(#dg-mod-head)'} data-cycle={edge.cycle ? 'true' : undefined} />)}
          </g>
          <g>
            {layout.nodes.map(({ node, box }) => {
              const body = (
                <>
                  <rect className={`dg-node${node.cycle ? ' dg-cycle-node' : ''}`} width={box.w} height={box.h} rx="8" />
                  <text className="dg-label" x="10" y="17">{fit(node.label, box.w - 20)}</text>
                  <text className="dg-kind" x="10" y="31">{t('knowledge.diagram.fileCount', { count: node.files })}{node.cycle ? ` · ${t('knowledge.diagram.inCycle')}` : ''}</text>
                  <title>{`${node.label}${node.cycle ? ` — ${t('knowledge.diagram.inCycle')}` : ''}`}</title>
                </>
              );
              return (
                <g key={node.id} transform={`translate(${box.x} ${box.y})`} data-testid="module-node" data-node={node.id} data-cycle={node.cycle ? 'true' : undefined}>
                  {node.href === null ? <g>{body}</g> : <a {...link(node.href)}>{body}</a>}
                </g>
              );
            })}
          </g>
        </PanZoom>
        <figcaption className="dg-legend">
          <span className="dg-key"><svg width="34" height="10" aria-hidden="true"><line className="dg-edge" x1="0" x2="34" y1="5" y2="5" /></svg>{t('knowledge.diagram.dependsOn')}</span>
          {block.cycles.length > 0 && <span className="dg-key"><svg width="34" height="10" aria-hidden="true"><line className="dg-edge dg-cycle" x1="0" x2="34" y1="5" y2="5" /></svg>{t('knowledge.diagram.cycle')}</span>}
          {block.cycles.map((members) => <span key={members.join('|')} data-testid="cycle">{t('knowledge.diagram.cycleOf', { members: members.map((member) => names.get(member) ?? member).join(' ⇄ ') })}</span>)}
          {block.notes.map((note) => <span key={note}>{note}</span>)}
        </figcaption>
      </figure>
    </section>
  );
}
