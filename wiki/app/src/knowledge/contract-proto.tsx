import type {ReactElement} from 'react';
import {useTranslation} from 'react-i18next';
import type {Block} from './types.js';

export default function ContractProto({block}: {block: Extract<Block, {type: 'definition'}>}): ReactElement {
  const {t} = useTranslation();
  const model = block.protobuf!;
  const anchor = (name: string): string => `proto-${encodeURIComponent(name)}`;
  const message = (name: string): ReactElement => <a href={`#${anchor(name)}`}>{name}</a>;
  return <div className="contract-proto" data-testid="contract-proto" data-ready="true">
    {model.services.map((service) => <section key={service.name}>
      <h3>{t('knowledge.contractService')} <code>{service.name}</code></h3>
      {service.methods.map((method) => <section key={method.name}>
        <h4><code>{method.name}</code></h4>
        <dl><dt>{t('knowledge.contractRequest')}</dt><dd>{method.requestStream && <span>{t('knowledge.contractStream')} </span>}{message(method.request)}</dd>
          <dt>{t('knowledge.contractResponse')}</dt><dd>{method.responseStream && <span>{t('knowledge.contractStream')} </span>}{message(method.response)}</dd></dl>
      </section>)}
    </section>)}
    {model.messages.map((held) => <section key={held.name} id={anchor(held.name)}>
      <h3><code>{held.name}</code></h3>
      <div className="table-wrap"><table><thead><tr><th>{t('knowledge.contractField')}</th><th>{t('knowledge.contractType')}</th><th>{t('knowledge.contractNumber')}</th><th>{t('knowledge.contractRule')}</th></tr></thead><tbody>
        {held.fields.map((field) => <tr key={field.id}><td><code>{field.name}</code></td><td><code>{field.type}</code></td><td>{field.id}</td><td>{t(`knowledge.contractFieldRule.${field.rule}`)}{field.oneof === undefined ? '' : ` · oneof ${field.oneof}`}</td></tr>)}
        {held.values?.map((value) => <tr key={value.name}><td><code>{value.name}</code></td><td>{t('knowledge.contractEnum')}</td><td>{value.id}</td><td>–</td></tr>)}
      </tbody></table></div>
      {held.fields.length === 0 && held.values === undefined && <p>{t('knowledge.contractNoFields')}</p>}
    </section>)}
  </div>;
}
