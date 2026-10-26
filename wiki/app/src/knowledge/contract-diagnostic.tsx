import type {ReactElement} from 'react';
import {useTranslation} from 'react-i18next';
import type {TFunction} from 'i18next';
import type {ContractDiagnostic, ContractReason} from './types.js';

/** Protocol and product vocabulary only; no source parsing or server runtime imports. */
const reasonKeys = {
  definitionMissing: 'knowledge.contractReason.definitionMissing',
  contractReadBudget: 'knowledge.contractReason.contractReadBudget',
  yamlParse: 'knowledge.contractReason.yamlParse',
  yamlConversion: 'knowledge.contractReason.yamlConversion',
  definitionObjectRequired: 'knowledge.contractReason.definitionObjectRequired',
  yamlAliasCycle: 'knowledge.contractReason.yamlAliasCycle',
  definitionNesting: 'knowledge.contractReason.definitionNesting',
  definitionRepresentationBudget: 'knowledge.contractReason.definitionRepresentationBudget',
  referenceAnchorUnsupported: 'knowledge.contractReason.referenceAnchorUnsupported',
  referenceRemoteOrAbsolute: 'knowledge.contractReason.referenceRemoteOrAbsolute',
  referenceEncodingInvalid: 'knowledge.contractReason.referenceEncodingInvalid',
  referenceEscapesRepository: 'knowledge.contractReason.referenceEscapesRepository',
  pointerEncodingInvalid: 'knowledge.contractReason.pointerEncodingInvalid',
  referenceUnresolved: 'knowledge.contractReason.referenceUnresolved',
  externalExample: 'knowledge.contractReason.externalExample',
  externalLogo: 'knowledge.contractReason.externalLogo',
  descriptionImage: 'knowledge.contractReason.descriptionImage',
  descriptionMarkupBudget: 'knowledge.contractReason.descriptionMarkupBudget',
  reservedBundleField: 'knowledge.contractReason.reservedBundleField',
  operationReferenceBudgetOrCycle: 'knowledge.contractReason.operationReferenceBudgetOrCycle',
  operationReferenceUnresolved: 'knowledge.contractReason.operationReferenceUnresolved',
  protoImportBudget: 'knowledge.contractReason.protoImportBudget',
  protoImportMissing: 'knowledge.contractReason.protoImportMissing',
  protoByteBudget: 'knowledge.contractReason.protoByteBudget',
  protoParse: 'knowledge.contractReason.protoParse',
  protoImportInvalid: 'knowledge.contractReason.protoImportInvalid',
  protoImportEscapesRepository: 'knowledge.contractReason.protoImportEscapesRepository',
  protoResolve: 'knowledge.contractReason.protoResolve',
  definitionSubjectUnsupported: 'knowledge.contractReason.definitionSubjectUnsupported',
  declaringContractCount: 'knowledge.contractReason.declaringContractCount',
  contractFormatUnsupported: 'knowledge.contractReason.contractFormatUnsupported',
  contractVersionMissing: 'knowledge.contractReason.contractVersionMissing',
  operationSelectionMissing: 'knowledge.contractReason.operationSelectionMissing',
  operationIdAmbiguous: 'knowledge.contractReason.operationIdAmbiguous',
  unknownDefinitionFailure: 'knowledge.contractReason.unknownDefinitionFailure',
  rendererFailure: 'knowledge.contractReason.rendererFailure',
  rendererValidationFailure: 'knowledge.contractReason.rendererValidationFailure',
  selectionNotRendered: 'knowledge.contractReason.selectionNotRendered',
 } as const satisfies Record<ContractReason['code'], string>;

export function contractReasonText(t: TFunction, reason: ContractReason | undefined): string {
  if (reason === undefined || !Object.prototype.hasOwnProperty.call(reasonKeys, reason.code)) return t('knowledge.contractUnknownReason');
  return t(reasonKeys[reason.code], 'params' in reason ? reason.params : {});
}

export function ContractTechnicalDetails({text}: {text: string | undefined}): ReactElement | null {
  const {t} = useTranslation();
  return text === undefined || text === '' ? null : <details data-testid="contract-technical-details"><summary>{t('knowledge.contractTechnicalDetails')}</summary><pre className="whitespace-pre-wrap break-words">{text}</pre></details>;
}

export function ContractDiagnosticView({diagnostic}: {diagnostic: ContractDiagnostic}): ReactElement {
  const {t} = useTranslation();
  return <div role="alert" data-testid="contract-diagnostic">
    <p data-testid="contract-diagnostic-summary">{t('knowledge.contractDiagnostic', {reason: contractReasonText(t, diagnostic.reason)})}</p>
    <p><code>{diagnostic.path}:{diagnostic.line} ({diagnostic.fullPath})</code></p>
    <ContractTechnicalDetails text={diagnostic.technicalDetail ?? diagnostic.detail} />
  </div>;
}

export type ContractRenderFailure = {reason: ContractReason; technicalDetail?: string};
export function ContractRenderProblem({failure, path, fullPath}: {failure: ContractRenderFailure; path: string; fullPath: string}): ReactElement {
  const {t} = useTranslation();
  return <div role="alert" data-testid="contract-render-problem"><p data-testid="contract-render-summary">{t('knowledge.contractRenderError', {reason: contractReasonText(t, failure.reason)})}</p><p><code>{path}:1 ({fullPath})</code></p><ContractTechnicalDetails text={failure.technicalDetail} /></div>;
}

export function contractRelationText(t: TFunction, relation: string): string {
  switch (relation) {
    case 'code.declares': return t('knowledge.contractRelation.contracts');
    case 'code.serves': case 'code.implements': return t('knowledge.contractRelation.implementations');
    case 'code.calls': case 'code.calls-remote': return t('knowledge.contractRelation.callers');
    case 'code.publishes': return t('knowledge.contractRelation.publishers');
    case 'code.consumes': return t('knowledge.contractRelation.consumers');
    default: return t('knowledge.contractRelation.unknown');
  }
}

export const contractRendererFailure = (detail: string | undefined): ContractRenderFailure => ({reason: {code: 'rendererFailure'}, ...(detail === undefined ? {} : {technicalDetail: detail})});
export const contractValidationFailure = (detail: string | undefined): ContractRenderFailure => ({reason: {code: 'rendererValidationFailure'}, ...(detail === undefined ? {} : {technicalDetail: detail})});
export const contractSelectionFailure = (): ContractRenderFailure => ({reason: {code: 'selectionNotRendered'}});
export function redocLoadedFailure(error: Error | undefined): ContractRenderFailure | null {
  return error === undefined ? null : contractRendererFailure(error.message);
}
export function asyncApiEventFailure(event: string, errorEvent: string, data: unknown): ContractRenderFailure | null {
  if (event !== errorEvent) return null;
  if (typeof data === 'string') return contractRendererFailure(data);
  try { return contractRendererFailure(JSON.stringify(data)); }
  catch (error) { return contractRendererFailure(`Vendor error details could not be serialized: ${String(error)}`); }
}
export function selectContractOperation(container: ParentNode | null, operationId: string): HTMLElement | null {
  return container?.querySelector<HTMLElement>(`[data-section-id="operation/${CSS.escape(operationId)}"]`) ?? null;
}
