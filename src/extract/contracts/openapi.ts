/**
 * The OpenAPI reader: contracts/openapi/*.yaml into one `code.contract` node
 * and one `code.operation` node per operation (method + path), each with the
 * span it was read at. The reading is the plain document shape: paths, their
 * operations' ids and summaries, and each operation's security -- a document
 * or operation-level `security: []` makes it public, a named scheme (or the
 * document's own) makes it secured.
 */
import {parseDocument} from 'yaml';
import {contractKey, KIND_CONTRACT, KIND_OPERATION, operationKey} from './schema.js';
import {SpanMeasure} from './spans.js';
import type {ExtractedNode, SourceSpan, ExtractionGap} from '../../extract/records.js';

/** One operation of an OpenAPI document, as the contract states it. */
export interface OpenApiOperation {
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
  readonly summary?: string;
  /** False only where the contract says the operation needs no security. */
  readonly public: boolean;
  readonly span: SourceSpan;
}

export interface OpenApiContract {
  readonly path: string;
  readonly title?: string;
  readonly version?: string;
  readonly specVersion?: string;
  readonly operations: readonly OpenApiOperation[];
}

/** The HTTP methods an OpenAPI path item can carry, in no order (the operations carry their own). */
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * Reads one OpenAPI document. A file that is not well-formed YAML is a gap,
 * never a silence; a document that parses but holds no paths yields a contract
 * with no operations.
 */
export function readOpenApi(path: string, text: string): {contract: OpenApiContract; gaps: readonly ExtractionGap[]} {
  const gaps: ExtractionGap[] = [];
  const doc = parseDocument(text, {uniqueKeys: false});
  if (doc.errors.length > 0) {
    const where = doc.errors[0]!.pos?.[0] ?? 0;
    const line = new SpanMeasure(text).lineOf(where);
    gaps.push({path, reason: `openapi: YAML parse error at line ${line}: ${doc.errors[0]!.message}`});
    return {contract: {path, operations: []}, gaps};
  }
  const root = doc.toJS() as {
    openapi?: string;
    info?: {title?: string; version?: string};
    security?: readonly Record<string, unknown>[];
    paths?: Record<string, Record<string, unknown>>;
  } | null;
  const measure = new SpanMeasure(text);
  const documentPublic = Array.isArray(root?.security) && root.security.length === 0;
  const operations: OpenApiOperation[] = [];
  for (const [routePath, item] of Object.entries(root?.paths ?? {})) {
    if (typeof item !== 'object' || item === null) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      const operation = (op ?? {}) as {
        operationId?: string;
        summary?: string;
        security?: readonly Record<string, unknown>[];
      };
      const node = doc.getIn(['paths', routePath, method], true) as {range?: readonly number[]} | undefined;
      const valueStart = node?.range?.[0];
      const valueEnd = node?.range?.[1];
      operations.push({
        method: method.toUpperCase(),
        path: routePath,
        operationId: typeof operation.operationId === 'string' ? operation.operationId : undefined,
        summary: typeof operation.summary === 'string' ? operation.summary : undefined,
        public: (Array.isArray(operation.security) && operation.security.length === 0) || documentPublic,
        span: measure.span(path, valueStart ?? 0, valueEnd ?? 0),
      });
    }
  }
  operations.sort((a, b) => (a.path + ' ' + a.method < b.path + ' ' + b.method ? -1 : 1));
  return {
    contract: {
      path,
      title: typeof root?.info?.title === 'string' ? root.info.title : undefined,
      version: typeof root?.info?.version === 'string' ? root.info.version : undefined,
      specVersion: typeof root?.openapi === 'string' ? root.openapi : undefined,
      operations,
    },
    gaps,
  };
}

/** The contract and operation nodes of one OpenAPI document. */
export function openApiNodes(contract: OpenApiContract): ExtractedNode[] {
  const contractNode: ExtractedNode = {
    key: contractKey(contract.path),
    kind: KIND_CONTRACT,
    label: contract.title ?? contract.path,
    properties: {
      format: 'openapi',
      ...(contract.specVersion !== undefined ? {specVersion: contract.specVersion} : {}),
      ...(contract.version !== undefined ? {version: contract.version} : {}),
    },
  };
  const operationNodes: ExtractedNode[] = contract.operations.map((op) => ({
    key: operationKey(contract.path, `${op.method}:${op.path}`),
    kind: KIND_OPERATION,
    label: `${op.method} ${op.path}`,
    properties: {
      method: op.method,
      path: op.path,
      ...(op.operationId !== undefined ? {operationId: op.operationId} : {}),
      ...(op.summary !== undefined ? {summary: op.summary} : {}),
      public: op.public,
    },
    span: op.span,
  }));
  return [contractNode, ...operationNodes];
}
