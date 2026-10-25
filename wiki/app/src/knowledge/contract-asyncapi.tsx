import {useEffect, useRef, useState, type ReactElement} from 'react';
import AsyncApiComponent, {PLUGIN_EVENT_ERROR} from '@asyncapi/react-component';
import '@asyncapi/react-component/styles/default.min.css';
import {useTranslation} from 'react-i18next';
import type {Block} from './types.js';
import {ContractRenderProblem, type ContractRenderFailure, contractValidationFailure, asyncApiEventFailure} from './contract-diagnostic.js';

/** The parser sees the bundled schema object; no schema URL, socket or API execution is supplied. */
export default function ContractAsyncApi({block}: {block: Extract<Block, {type: 'definition'}>}): ReactElement {
  const {t} = useTranslation();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<ContractRenderFailure | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = frame.current;
    if (node === null) return;
    const inspect = (): void => {
      if (node.querySelector('.aui-root #contract-async-schema .panel--center') !== null && (node.textContent?.trim().length ?? 0) > 10) setReady(true);
      const failure = node.querySelector('.aui-root .border-red-500');
      if (failure !== null) setError(contractValidationFailure(failure.textContent ?? undefined));
    };
    const observer = new MutationObserver(inspect); observer.observe(node, {subtree: true, childList: true}); inspect();
    return () => observer.disconnect();
  }, []);
  return <div ref={frame} className="contract-asyncapi" data-testid="contract-asyncapi" data-ready={ready && error === null ? 'true' : 'false'}>
    {error !== null && <ContractRenderProblem failure={error} path={block.contract} fullPath={block.fullPath ?? block.contract} />}
    <AsyncApiComponent schema={block.document!} config={{schemaID: 'contract-async-schema', show: {sidebar: false, errors: true}, publishLabel: t('knowledge.contractPublish'), subscribeLabel: t('knowledge.contractSubscribe'), sendLabel: t('knowledge.contractSend'), receiveLabel: t('knowledge.contractReceive')}} onPluginEvent={(event, data) => {
      const tagged = asyncApiEventFailure(event, PLUGIN_EVENT_ERROR, data); if (tagged !== null) setError(tagged);
    }} />
  </div>;
}
