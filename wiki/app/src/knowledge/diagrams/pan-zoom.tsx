/**
 * The frame of a diagram that can be moved and scaled: drag to pan (a touch
 * drag along the page's width pans, one along its height scrolls the page),
 * the buttons or Ctrl and the wheel to zoom, and "Fit" to return. A link inside
 * is followed by a click and not by the end of a drag.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from 'react';
import { MinusIcon, PlusIcon, ScanIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';

interface View {
  scale: number;
  x: number;
  y: number;
}

const MIN = 0.3;
const MAX = 2.5;

export interface PanZoomProps {
  width: number;
  height: number;
  /** The point (in diagram units) the first view centres on when the diagram is wider than the frame. */
  focus?: { x: number; y: number };
  /** The smallest scale the first view takes: below it, text is unreadable and the diagram is panned instead. */
  floor?: number;
  label: string;
  children: ReactNode;
  testId?: string;
  toolbar?: ReactNode;
}

export function PanZoom({ width, height, focus, floor = 0.85, label, children, testId, toolbar }: PanZoomProps): ReactElement {
  const { t } = useTranslation();
  const frame = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; id: number } | null>(null);
  const fitted = useRef(false);

  const frameHeight = Math.min(600, Math.max(180, Math.ceil(height + 16)));

  const fit = useCallback((w: number): View => {
    const scale = Math.min(1, Math.max(floor, Math.min((w - 16) / Math.max(1, width), (frameHeight - 16) / Math.max(1, height))));
    const spare = w - width * scale;
    // Wider than the frame: the first view starts at the left edge (where the reading starts), or centred on the focus.
    const x = spare >= 0 ? spare / 2 : focus === undefined ? 8 : Math.min(8, Math.max(spare - 8, w / 2 - focus.x * scale));
    const spareY = frameHeight - height * scale;
    const y = spareY >= 0 ? spareY / 2 : Math.min(8, Math.max(spareY - 8, frameHeight / 2 - (focus?.y ?? height / 2) * scale));
    return { scale, x, y };
  }, [width, height, focus?.x, focus?.y, floor, frameHeight]);

  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const measure = (): void => setBox({ w: element.clientWidth, h: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (box.w === 0) return;
    if (!fitted.current) {
      fitted.current = true;
      setView(fit(box.w));
    }
  }, [box.w, fit]);

  const zoom = (factor: number, cx: number, cy: number): void => {
    setView((held) => {
      if (held === null) return held;
      const scale = Math.min(MAX, Math.max(MIN, held.scale * factor));
      const k = scale / held.scale;
      return { scale, x: cx - (cx - held.x) * k, y: cy - (cy - held.y) * k };
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || view === null) return;
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false, id: event.pointerId };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = drag.current;
    if (held === null || held.id !== event.pointerId) return;
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    if (!held.moved && Math.hypot(dx, dy) < 5) return;
    if (!held.moved) {
      held.moved = true;
      frame.current?.setPointerCapture?.(event.pointerId);
    }
    setView((current) => (current === null ? current : { ...current, x: held.vx + dx, y: held.vy + dy }));
  };
  const endDrag = (): void => {
    const held = drag.current;
    drag.current = null;
    if (held?.moved) {
      // The click that ends a drag is not a follow of the link under the pointer.
      const swallow = (event: Event): void => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    }
  };

  return (
    <div className="dg-frame" data-testid={testId ?? 'pan-zoom'}>
      <div className="dg-toolbar" role="toolbar" aria-label={label}>
        {toolbar}
        <span className="dg-spacer" />
        <Button type="button" variant="ghost" size="icon" aria-label={t('knowledge.diagram.zoomOut')} onClick={() => zoom(1 / 1.25, box.w / 2, frameHeight / 2)}><MinusIcon aria-hidden="true" /></Button>
        <Button type="button" variant="ghost" size="icon" aria-label={t('knowledge.diagram.zoomIn')} onClick={() => zoom(1.25, box.w / 2, frameHeight / 2)}><PlusIcon aria-hidden="true" /></Button>
        <Button type="button" variant="ghost" size="icon" aria-label={t('knowledge.diagram.fit')} title={t('knowledge.diagram.fit')} onClick={() => setView(fit(box.w))}><ScanIcon aria-hidden="true" /></Button>
      </div>
      <div
        ref={frame}
        className="dg-viewport"
        style={{ height: frameHeight }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          const rect = frame.current?.getBoundingClientRect();
          zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - (rect?.left ?? 0), event.clientY - (rect?.top ?? 0));
        }}
      >
        <svg className="dg-svg" width="100%" height="100%" role="group" aria-label={label} data-scale={view?.scale.toFixed(3) ?? ''}>
          <g transform={view === null ? undefined : `translate(${view.x} ${view.y}) scale(${view.scale})`} data-testid="pan-zoom-content">{children}</g>
        </svg>
      </div>
    </div>
  );
}
