import { useEffect, useRef, useState, type ReactElement } from 'react';
import { RedocStandalone } from 'redoc';
import type {Block} from './types.js';
import {ContractRenderProblem, type ContractRenderFailure, contractSelectionFailure, redocLoadedFailure, selectContractOperation} from './contract-diagnostic.js';

/** This module is fetched only when Definition opens. Redoc receives an object, never a URL to fetch. */
export default function ContractRedoc({block}: {block: Extract<Block, {type: 'definition'}>}): ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ContractRenderFailure | null>(null);
  useEffect(() => {
    if (!loaded || block.selection === undefined) return;
    const target = selectContractOperation(container.current, block.selection.operationId);
    if (target === null || target === undefined) { setError(contractSelectionFailure()); return; }
    target.scrollIntoView({block: 'start'});
    target.dataset['contractSelected'] = 'true';
  }, [loaded, block.selection]);
  const colors = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const color = (token: string, fallback: string): string => colors?.getPropertyValue(token).trim() || fallback;
  return <div ref={container} className="contract-redoc" data-testid="contract-redoc" data-ready={loaded && error === null ? 'true' : 'false'}>
    {error !== null && <ContractRenderProblem failure={error} path={block.contract} fullPath={block.fullPath ?? block.contract} />}
    <RedocStandalone spec={block.document} options={{disableSearch: true, hideDownloadButtons: true, hideHostname: true, hideFab: true, untrustedSpec: true, nativeScrollbars: true, theme: {colors: {text: {primary: color('--text', '#2e3034'), secondary: color('--text-secondary', '#5c5e66')}}, typography: {fontFamily: 'inherit', headings: {fontFamily: 'inherit'}, code: {fontFamily: 'monospace'}}, sidebar: {width: '0px', backgroundColor: color('--bg-page', '#ffffff')}, rightPanel: {width: '35%', backgroundColor: color('--surface-code', '#f2f3f4'), textColor: color('--text', '#2e3034')}}}} onLoaded={(failure) => { const tagged = redocLoadedFailure(failure); if (tagged !== null) setError(tagged); else setLoaded(true); }} />
  </div>;
}
