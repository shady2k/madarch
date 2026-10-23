/**
 * What a click on a node of a diagram does. The default follows the address in
 * the wiki; the wiki's tabs (madarch-m38l.6) provide their own `onOpen` through
 * `DiagramOpenProvider` to open the node's page in a tab of their own. A click
 * with a modifier key (or a middle click) is left to the browser, which opens
 * the link's address in a tab of its own.
 */
import { createContext, createElement, useContext, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { appPath } from '../../app-base.js';
import { navigateTo } from '../../hold.js';

/** Opens the page a node stands for; `href` is the wiki address of the page, without the app's base. */
export type OnOpen = (href: string) => void;

const defaultOpen: OnOpen = (href) => navigateTo(appPath(href));

export const DiagramOpenContext = createContext<OnOpen>(defaultOpen);

/** Wires the click of every diagram under it. */
export function DiagramOpenProvider({ onOpen, children }: { onOpen: OnOpen; children: ReactNode }): ReactElement {
  return createElement(DiagramOpenContext.Provider, { value: onOpen }, children);
}

/** The hook a diagram uses: the click handler of a link to `href`. */
export function useDiagramLink(): (href: string) => { href: string; onClick: (event: MouseEvent<Element>) => void } {
  const open = useContext(DiagramOpenContext);
  return (href) => ({
    href: appPath(href),
    onClick: (event) => {
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      open(href);
    },
  });
}
