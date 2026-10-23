/**
 * The wiki's one app (decision 0029): every address of a product's wiki opens
 * the knowledge wiki. A product without a kinds manifest is seeded with the
 * starter set by the server, and a manifest that cannot be read is a page of
 * this same app naming each finding with its file and line. There is no other
 * app and no address that opens one.
 */
import { useEffect, type ReactElement } from 'react';
import { appPath } from '../app-base.js';
import { KnowledgeApp } from './app.js';
import { K_HOME, kRouteOf } from './routes.js';

export function Root(): ReactElement {
  // An address the knowledge wiki does not know (the front door, an old bookmark) opens its home page.
  useEffect(() => {
    if (kRouteOf(window.location.pathname, window.location.search) === null) window.history.replaceState({}, '', appPath(K_HOME));
  }, []);
  return <KnowledgeApp />;
}
