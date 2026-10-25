import {useState, type ReactElement} from 'react';
import AsyncApiComponent, {PLUGIN_EVENT_READY, PLUGIN_EVENT_ERROR} from '@asyncapi/react-component';
import '@asyncapi/react-component/styles/default.min.css';
import {useTranslation} from 'react-i18next';
import type {Block} from './types.js';

/** The parser sees the bundled schema object; no schema URL, socket or API execution is supplied. */
export default function ContractAsyncApi({block}: {block: Extract<Block, {type: 'definition'}>}): ReactElement {
  const {t} = useTranslation();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="contract-asyncapi" data-testid="contract-asyncapi" data-ready={ready && error === null ? 'true' : 'false'}>
    {error !== null && <p role="alert">{t('knowledge.contractRenderError', {reason: error})} {block.contract}:1 ({block.fullPath ?? block.contract})</p>}
    <AsyncApiComponent schema={block.document!} config={{show: {sidebar: false, errors: true}, publishLabel: t('knowledge.contractPublish'), subscribeLabel: t('knowledge.contractSubscribe'), sendLabel: t('knowledge.contractSend'), receiveLabel: t('knowledge.contractReceive')}} onPluginEvent={(event, data) => {
      if (event === PLUGIN_EVENT_READY) setReady(true);
      if (event === PLUGIN_EVENT_ERROR) setError(typeof data === 'string' ? data : JSON.stringify(data));
    }} />
  </div>;
}
