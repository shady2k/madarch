import type {ReactElement} from 'react';
import {useTranslation} from 'react-i18next';
import {Badge} from '@/components/ui/badge.js';
import {Table, TableHeader, TableRow, TableHead, TableBody, TableCell} from '@/components/ui/table.js';
import {EntityName, CodePlace} from './blocks.js';
import type {EntityRef, OperationMetadata} from './types.js';
import {contractRelationText} from './contract-diagnostic.js';

export function Operations({rows, metadata}: {rows: EntityRef[]; metadata: Record<string, OperationMetadata>}): ReactElement {
  const {t} = useTranslation();
  const groups = new Map<string, {entity?: EntityRef; protocol: string; rows: EntityRef[]}>();
  for (const row of rows) {
    const owners = metadata[row.id]?.contracts ?? [];
    if (owners.length === 0) {
      const held = groups.get('') ?? {protocol: '', rows: []}; held.rows.push(row); groups.set('', held);
    }
    for (const owner of owners) { const held = groups.get(owner.entity.id) ?? {entity: owner.entity, protocol: owner.protocol, rows: []}; held.rows.push(row); groups.set(owner.entity.id, held); }
  }
  const refs = (rows: EntityRef[]): ReactElement => <>{rows.length === 0 ? '–' : rows.map((entity, index) => <span key={entity.id}>{index > 0 ? ', ' : ''}<EntityName entity={entity} /></span>)}</>;
  return <div data-testid="operations-catalogue">{[...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, group]) => <section key={id} data-contract={id}>
    <h2 className="flex flex-wrap items-center gap-2">{group.entity === undefined ? t('knowledge.contractUnassigned') : <EntityName entity={group.entity} />}{group.protocol !== '' && <Badge>{group.protocol}</Badge>}</h2>
    <Table><TableHeader><TableRow><TableHead>{t('knowledge.contractOperation')}</TableHead><TableHead>{t('knowledge.contractImplementedBy')}</TableHead><TableHead>{t('knowledge.contractCalledBy')}</TableHead><TableHead>{t('knowledge.colPlace')}</TableHead></TableRow></TableHeader>
      <TableBody>{group.rows.map((row) => <TableRow key={row.id} data-entity={row.id}>
        <TableCell><EntityName entity={row} />{metadata[row.id]?.contracts.filter((owner) => owner.entity.id === id).map((owner) => <div key={owner.entity.id}>
          {owner.directionStatus === 'unavailable' && <p>{t('knowledge.contractDirectionsUnavailable')}</p>}
          {owner.directions?.map((direction) => <p key={direction}>{t(direction === 'subscribe' ? 'knowledge.contractProduces' : 'knowledge.contractConsumes')} ({t(direction === 'subscribe' ? 'knowledge.contractSubscribe' : 'knowledge.contractPublish')}): {refs(direction === 'subscribe' ? owner.producedBy ?? [] : owner.consumedBy ?? [])}</p>)}
        </div>)}{metadata[row.id]?.cuts.map((cut) => <p key={cut.relation}>{t('knowledge.contractLinksCut', {...cut, relation: contractRelationText(t, cut.relation)})}</p>)}</TableCell>
        <TableCell>{refs(metadata[row.id]?.implementedBy ?? [])}</TableCell><TableCell>{refs(metadata[row.id]?.calledBy ?? [])}</TableCell>
        <TableCell>{row.location === undefined ? '–' : <CodePlace location={row.location} />}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </section>)}</div>;
}
