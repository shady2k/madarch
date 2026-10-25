import {Component, lazy, Suspense, type ReactElement, type ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import {Badge} from '@/components/ui/badge.js';
import {KLink} from './blocks.js';
import type {Block} from './types.js';
import './contract.css';

const Redoc = lazy(() => import('./contract-redoc.js'));
const AsyncApi = lazy(() => import('./contract-asyncapi.js'));
const Proto = lazy(() => import('./contract-proto.js'));
class RendererBoundary extends Component<{children: ReactNode; failure: string}, {error: string | null}> {
  state = {error: null as string | null};
  static getDerivedStateFromError(error: unknown): {error: string} { return {error: String(error)}; }
  override render(): ReactNode { return this.state.error === null ? this.props.children : <p role="alert">{this.props.failure}: {this.state.error}</p>; }
}

export default function ContractView({block}: {block: Extract<Block, {type: 'definition'}>}): ReactElement {
  const {t} = useTranslation();
  return <section data-block="definition" aria-label={block.title} className="contract-definition">
    <h2>{block.title}</h2>
    <p className="flex flex-wrap items-center gap-2"><Badge>{block.format === 'proto' ? 'gRPC' : block.format === 'asyncapi' ? 'AsyncAPI' : 'OpenAPI'}</Badge>
      {block.location === undefined ? <code>{block.contract}</code> : <KLink href={block.location.href}>{block.contract}</KLink>}</p>
    {block.diagnostics?.map((diagnostic, index) => <div role="alert" key={index} data-testid="contract-diagnostic">
      <p>{t('knowledge.contractDiagnostic', {reason: diagnostic.detail})}</p><p><code>{diagnostic.path}:{diagnostic.line} ({diagnostic.fullPath})</code></p>
    </div>)}
    {block.diagnostics === undefined && <RendererBoundary key={`${block.contract}:${block.selection?.operationId ?? ''}`} failure={t('knowledge.contractRendererFailed', {path: block.contract, fullPath: block.fullPath ?? block.contract})}>
      <Suspense fallback={<p role="status">{t('knowledge.contractLoading')}</p>}>
        {block.format === 'openapi' && block.document !== undefined ? <Redoc block={block} /> : block.format === 'asyncapi' && block.document !== undefined ? <AsyncApi block={block} /> : block.format === 'proto' && block.protobuf !== undefined ? <Proto block={block} /> : <p role="alert">{t('knowledge.contractMissingDocument')}</p>}
      </Suspense>
    </RendererBoundary>}
  </section>;
}
