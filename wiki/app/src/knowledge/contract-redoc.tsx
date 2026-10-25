import { useEffect, useRef, useState, type ReactElement } from 'react';
import { RedocStandalone } from 'redoc';
import { useTranslation } from 'react-i18next';
import type { Block } from './types.js';

/** This module is fetched only when Definition opens. Redoc receives an object, never a URL to fetch. */
export default function ContractRedoc({block}: {block: Extract<Block, {type: 'definition'}>}): ReactElement {
  const {t} = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded || block.selection === undefined) return;
    const target = container.current?.querySelector<HTMLElement>(`[data-section-id="operation/${CSS.escape(block.selection.operationId)}"]`);
    if (target === null || target === undefined) { setError(t('knowledge.contractSelectionMissing')); return; }
    target.scrollIntoView({block: 'start'});
    target.dataset['contractSelected'] = 'true';
  }, [loaded, block.selection, t]);
  const colors = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const color = (token: string, fallback: string): string => colors?.getPropertyValue(token).trim() || fallback;
  return <div ref={container} className="contract-redoc" data-testid="contract-redoc" data-ready={loaded && error === null ? 'true' : 'false'}>
    {error !== null && <p role="alert">{t('knowledge.contractRenderError', {reason: error})} {block.contract}:1 ({block.fullPath ?? block.contract})</p>}
    <RedocStandalone spec={block.document} options={{disableSearch: true, hideDownloadButtons: true, hideHostname: true, hideFab: true, untrustedSpec: true, nativeScrollbars: true, theme: {colors: {text: {primary: color('--text', '#2e3034'), secondary: color('--text-secondary', '#5c5e66')}}, typography: {fontFamily: 'inherit', headings: {fontFamily: 'inherit'}, code: {fontFamily: 'monospace'}}, sidebar: {width: '0px', backgroundColor: color('--bg-page', '#ffffff')}, rightPanel: {width: '35%', backgroundColor: color('--surface-code', '#f2f3f4'), textColor: color('--text', '#2e3034')}}}} onLoaded={(failure) => { if (failure !== undefined) setError(failure.message); else setLoaded(true); }} />
  </div>;
}
