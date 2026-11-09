/**
 * What a click on a node of a diagram does: the node's page opens in a new tab of
 * the wiki (`openInNewTab`, tabs.ts). A host that wants another place provides its
 * own `onOpen` through `DiagramOpenProvider`. A click with shift or alt, or with
 * a button other than the main and the middle one, is left to the browser.
 */
import { createContext, createElement, useContext, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { appPath } from '../../app-base.js';
import { openInNewTab } from '../tabs.js';

/** Opens the page a node stands for; `href` is the wiki address of the page, without the app's base. */
export type OnOpen = (href: string) => void;

/** A node's page opens in a new in-wiki tab (a page already open in a tab is switched to). */
const defaultOpen: OnOpen = (href) => openInNewTab(href);

export const DiagramOpenContext = createContext<OnOpen>(defaultOpen);

/** Wires the click of every diagram under it. */
export function DiagramOpenProvider({ onOpen, children }: { onOpen: OnOpen; children: ReactNode }): ReactElement {
  return createElement(DiagramOpenContext.Provider, { value: onOpen }, children);
}

/** The hook a diagram uses: the click handler of a link to `href`. */
export function useDiagramLink(): (href: string) => { href: string; onClick: (event: MouseEvent<Element>) => void; onAuxClick: (event: MouseEvent<Element>) => void } {
  const open = useContext(DiagramOpenContext);
  return (href) => {
    const go = (event: MouseEvent<Element>): void => {
      if (event.shiftKey || event.altKey || (event.button !== 0 && event.button !== 1)) return;
      event.preventDefault();
      open(href);
    };
    return { href: appPath(href), onClick: go, onAuxClick: (event) => { if (event.button === 1) go(event); } };
  };
}
