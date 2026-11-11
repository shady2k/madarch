/**
 * The wiki's one app (decision 0029): every address of a product's wiki opens
 * the knowledge wiki. A product without a kinds manifest has nothing to show:
 * starter set by the server, and a manifest that cannot be read is a page of
 * this same app naming each finding with its file and line. There is no other
 * app and no address that opens one.
 */
import { useEffect, type ReactElement } from 'react';
import { appPath } from '../app-base.js';
import { KnowledgeApp } from './app.js';
import { WIKI_HOME, wikiRouteOf } from './routes.js';

export function Root(): ReactElement {
  // An address the knowledge wiki does not know (the front door, an old bookmark) opens its home page.
  useEffect(() => {
    if (wikiRouteOf(window.location.pathname, window.location.search) === null) window.history.replaceState({}, '', appPath(WIKI_HOME));
  }, []);
  return <KnowledgeApp />;
}
