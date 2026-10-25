import {Component, lazy, Suspense, type ReactElement, type ReactNode} from 'react';
import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import {parseFragment, html as htmlVocabulary, type DefaultTreeAdapterTypes} from 'parse5';
import {useTranslation} from 'react-i18next';
import {Badge} from '@/components/ui/badge.js';
import {KLink} from './blocks.js';
import type {Block, ContractDiagnostic} from './types.js';
import {ContractDiagnosticView, ContractRenderProblem} from './contract-diagnostic.js';
import './contract.css';

const Redoc = lazy(() => import('./contract-redoc.js'));
const AsyncApi = lazy(() => import('./contract-asyncapi.js'));
const Proto = lazy(() => import('./contract-proto.js'));
export class RendererBoundary extends Component<{children: ReactNode; path: string; fullPath: string}, {error: string | null}> {
  state = {error: null as string | null};
  static getDerivedStateFromError(error: unknown): {error: string} { return {error: String(error)}; }
  override render(): ReactNode { return this.state.error === null ? this.props.children : <ContractRenderProblem path={this.props.path} fullPath={this.props.fullPath} failure={{reason: {code: 'rendererFailure'}, technicalDetail: this.state.error}} />; }
}

type DescriptionSource = {text: string; path: string; line: number; fullPath: string};
/** Parse markup without mounting a renderer or resolving any resource. Scalar source lines stay exact. */
export function descriptionImageDiagnostic(descriptions: readonly DescriptionSource[]): ContractDiagnostic | undefined {
  let remaining = 100_000;
  const parser = unified().use(remarkParse).use(remarkGfm);
  type MarkdownNode = {type: string; value?: string; children?: readonly MarkdownNode[]};
  for (const source of descriptions) {
    let image = false;
    try {
      const markdown: MarkdownNode[] = [parser.parse(source.text)];
      const fragments: string[] = [];
      while (markdown.length > 0 && remaining-- > 0) {
        const node = markdown.pop()!;
        if (node.type === 'image' || node.type === 'imageReference') image = true;
        // Keep raw HTML in document order across remark's separate inline nodes.
        if (node.children !== undefined) for (let i = node.children.length - 1; i >= 0; i--) markdown.push(node.children[i]!);
        if (node.type === 'html' && node.value !== undefined) fragments.push(node.value);
      }
      if (remaining > 0 && fragments.length > 0) {
        const html: DefaultTreeAdapterTypes.Node[] = [parseFragment(fragments.join('\n'))];
        while (html.length > 0 && remaining-- > 0) {
          const held = html.pop()!;
          if ('tagName' in held && (held.tagName === 'img' || (held.tagName === 'image' && held.namespaceURI === htmlVocabulary.NS.SVG) || (held.tagName === 'source' && held.parentNode !== null && 'tagName' in held.parentNode && held.parentNode.tagName === 'picture'))) image = true;
          if ('childNodes' in held) for (const child of held.childNodes) html.push(child);
          if ('content' in held) html.push(held.content);
        }
      }
      if (remaining <= 0) return {path: source.path, line: source.line, fullPath: source.fullPath, code: 'limit', detail: 'description markup exceeds the documentation node budget', reason: {code: 'descriptionMarkupBudget', params: {maxNodes: 100_000}}};
      if (image) return {path: source.path, line: source.line, fullPath: source.fullPath, code: 'reference', detail: 'embedded description images are not bundled', reason: {code: 'descriptionImage'}};
    } catch (error) {
      return {path: source.path, line: source.line, fullPath: source.fullPath, code: 'parse', detail: String(error), technicalDetail: String(error), reason: {code: 'unknownDefinitionFailure'}};
    }
  }
  return undefined;
}

export default function ContractView({block}: {block: Extract<Block, {type: 'definition'}>}): ReactElement {
  const {t} = useTranslation();
  const imageDiagnostic = block.diagnostics === undefined ? descriptionImageDiagnostic(block.descriptions ?? []) : undefined;
  const diagnostics = block.diagnostics ?? (imageDiagnostic === undefined ? undefined : [imageDiagnostic]);
  return <section data-block="definition" aria-label={block.title} className="contract-definition">
    <h2>{block.title}</h2>
    <p className="flex flex-wrap items-center gap-2"><Badge>{block.format === 'proto' ? 'gRPC' : block.format === 'asyncapi' ? 'AsyncAPI' : 'OpenAPI'}</Badge>
      {block.location === undefined ? <code>{block.contract}</code> : <KLink href={block.location.href}>{block.contract}</KLink>}</p>
    {diagnostics?.map((diagnostic, index) => <ContractDiagnosticView key={index} diagnostic={diagnostic} />)}
    {diagnostics === undefined && <RendererBoundary key={`${block.contract}:${block.selection?.operationId ?? ''}`} path={block.contract} fullPath={block.fullPath ?? block.contract}>
      <Suspense fallback={<p role="status">{t('knowledge.contractLoading')}</p>}>
        {block.format === 'openapi' && block.document !== undefined ? <Redoc block={block} /> : block.format === 'asyncapi' && block.document !== undefined ? <AsyncApi block={block} /> : block.format === 'proto' && block.protobuf !== undefined ? <Proto block={block} /> : <p role="alert">{t('knowledge.contractMissingDocument')}</p>}
      </Suspense>
    </RendererBoundary>}
  </section>;
}
