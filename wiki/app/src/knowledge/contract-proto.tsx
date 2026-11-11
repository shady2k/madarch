import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import type { Block } from './types.js';

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
      <Table><TableHeader><TableRow><TableHead>{t('knowledge.contractField')}</TableHead><TableHead>{t('knowledge.contractType')}</TableHead><TableHead>{t('knowledge.contractNumber')}</TableHead><TableHead>{t('knowledge.contractRule')}</TableHead></TableRow></TableHeader><TableBody>
        {held.fields.map((field) => <TableRow key={field.id}><TableCell><code>{field.name}</code></TableCell><TableCell><code>{field.type}</code></TableCell><TableCell>{field.id}</TableCell><TableCell>{t(`knowledge.contractFieldRule.${field.rule}`)}{field.oneof === undefined ? '' : ` · oneof ${field.oneof}`}</TableCell></TableRow>)}
        {held.values?.map((value) => <TableRow key={value.name}><TableCell><code>{value.name}</code></TableCell><TableCell>{t('knowledge.contractEnum')}</TableCell><TableCell>{value.id}</TableCell><TableCell>–</TableCell></TableRow>)}
      </TableBody></Table>
      {held.fields.length === 0 && held.values === undefined && <p>{t('knowledge.contractNoFields')}</p>}
    </section>)}
  </div>;
}
