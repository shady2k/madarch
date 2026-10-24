/**
 * The full-screen button every diagram carries (madarch-m38l.15, the owner's walk of 2026-10-23): the diagram's frame
 * takes the whole window, its pan and zoom keep working, and a click on an element closes the frame and opens the
 * element's page behind it. Escape closes it too. The diagram inside asks `useFullscreen()` for the room it has.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Maximize2Icon, Minimize2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DiagramOpenContext } from './open.js';

const FullscreenContext = createContext(false);

/** Whether the diagram is in full screen now. */
export const useFullscreen = (): boolean => useContext(FullscreenContext);

/** The height a full-screen diagram has under the window's top bar, in pixels. */
export const fullscreenHeight = (reserve: number): number => Math.max(320, (typeof window === 'undefined' ? 800 : window.innerHeight) - reserve);

export function Fullscreenable({ children }: { children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const outer = useContext(DiagramOpenContext);
  useEffect(() => {
    if (!full) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', close);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', close);
      document.body.style.overflow = overflow;
    };
  }, [full]);
  // A page opened from inside the full-screen frame appears behind it: the frame closes first.
  const open = useCallback((href: string): void => {
    setFull(false);
    outer(href);
  }, [outer]);
  const label = t(full ? 'knowledge.views.exitFullscreen' : 'knowledge.views.fullscreen');
  return (
    <div className={full ? 'dg-fullable dg-full' : 'dg-fullable'} data-fullscreen={full ? 'true' : 'false'} data-testid="fullscreenable">
      <button type="button" className="dg-fs-button" onClick={() => setFull(!full)} aria-label={label} title={label} aria-pressed={full} data-testid="fullscreen-button">
        {full ? <Minimize2Icon aria-hidden="true" className="size-4" /> : <Maximize2Icon aria-hidden="true" className="size-4" />}
      </button>
      <FullscreenContext.Provider value={full}>
        <DiagramOpenContext.Provider value={open}>{children}</DiagramOpenContext.Provider>
      </FullscreenContext.Provider>
    </div>
  );
}
