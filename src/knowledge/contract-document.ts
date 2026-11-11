/** Diagnostics published with a definition opinion; the engine does not parse contracts. */
export type ContractReason =
  | {code: 'definitionMissing'}
  | {code: 'contractReadBudget'; params: {maxFiles: number; maxBytes: number}}
  | {code: 'yamlParse'}
  | {code: 'yamlConversion'}
  | {code: 'definitionObjectRequired'}
  | {code: 'yamlAliasCycle'}
  | {code: 'definitionNesting'; params: {maxLevels: number}}
  | {code: 'definitionRepresentationBudget'; params: {maxBytes: number}}
  | {code: 'referenceAnchorUnsupported'; params: {ref: string}}
  | {code: 'referenceRemoteOrAbsolute'; params: {ref: string}}
  | {code: 'referenceEncodingInvalid'; params: {ref: string}}
  | {code: 'referenceEscapesRepository'; params: {ref: string}}
  | {code: 'pointerEncodingInvalid'; params: {ref: string}}
  | {code: 'referenceUnresolved'; params: {ref: string}}
  | {code: 'externalExample'; params: {ref: string}}
  | {code: 'externalLogo'; params: {ref: string}}
  | {code: 'descriptionImage'}
  | {code: 'descriptionMarkupBudget'; params: {maxNodes: number}}
  | {code: 'reservedBundleField'; params: {field: string}}
  | {code: 'operationReferenceBudgetOrCycle'; params: {maxReferences: number}}
  | {code: 'operationReferenceUnresolved'; params: {ref: string}}
  | {code: 'protoImportBudget'; params: {maxFiles: number; maxDepth: number}}
  | {code: 'protoImportMissing'}
  | {code: 'protoByteBudget'; params: {maxBytes: number}}
  | {code: 'protoParse'}
  | {code: 'protoImportInvalid'; params: {ref: string}}
  | {code: 'protoImportEscapesRepository'; params: {ref: string}}
  | {code: 'protoResolve'}
  | {code: 'definitionSubjectUnsupported'}
  | {code: 'declaringContractCount'; params: {count: number}}
  | {code: 'contractFormatUnsupported'; params: {format: string}}
  | {code: 'contractVersionMissing'; params: {format: string}}
  | {code: 'operationSelectionMissing'; params: {method: string; path: string}}
  | {code: 'operationIdAmbiguous'; params: {operationId: string; count: number}}
  | {code: 'unknownDefinitionFailure'}
  | {code: 'rendererFailure'}
  | {code: 'rendererValidationFailure'}
  | {code: 'selectionNotRendered'};
export type ContractDiagnostic = { path: string; line: number; fullPath: string; code: string; detail: string; reason?: ContractReason; technicalDetail?: string };
