/**
 * Which app opens at an address (decision 0029): the knowledge wiki under `/k`,
 * and — for a product whose repository holds a kinds manifest — at its front
 * door too, so a product that `madarch new` made opens on its own pages. A
 * product without the manifest, and the address `/?documents` of a product
 * that has one, open the documents app as before.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { appPath, appRoute } from '../app-base.js';
import { App } from '../app.js';
import { getStatus } from './api.js';
import { KnowledgeApp } from './app.js';
import { K_HOME, kRouteOf } from './routes.js';

type Mode = 'checking' | 'knowledge' | 'documents';

function first(): Mode {
  if (kRouteOf(window.location.pathname, window.location.search) !== null) return 'knowledge';
  const front = appRoute(window.location.pathname) === '/' && !new URLSearchParams(window.location.search).has('documents');
  return front ? 'checking' : 'documents';
}

export function Root(): ReactElement | null {
  const [mode, setMode] = useState<Mode>(first);
  useEffect(() => {
    if (mode !== 'checking') return;
    const controller = new AbortController();
    getStatus(controller.signal).then(
      (status) => {
        if (status.manifest === 'ok') {
          window.history.replaceState({}, '', appPath(K_HOME));
          setMode('knowledge');
        } else setMode('documents');
      },
      () => {
        if (!controller.signal.aborted) setMode('documents');
      },
    );
    return () => controller.abort();
  }, [mode]);
  if (mode === 'checking') return null;
  return mode === 'knowledge' ? <KnowledgeApp /> : <App />;
}
