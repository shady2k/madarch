import {afterAll, afterEach, beforeAll, expect, test} from 'bun:test';
import {GlobalRegistrator} from '@happy-dom/global-registrator';
import {createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {BlockView} from './blocks.js';
import {Operations} from './operations.js';
import {setWikiLanguage} from '../i18n.js';
import type {EntityRef, ContractDiagnostic, ContractReason} from './types.js';
import {ContractDiagnosticView, ContractRenderProblem, contractReasonText, redocLoadedFailure, asyncApiEventFailure, contractSelectionFailure, contractValidationFailure, selectContractOperation} from './contract-diagnostic.js';
import i18n from '../i18n.js';
import en from '../locales/en.json';
import ru from '../locales/ru.json';
import ContractView, {descriptionImageDiagnostic, RendererBoundary} from './contract-view.js';
import type {Block} from './types.js';
const originalFetch = globalThis.fetch;
let root: Root | undefined;
beforeAll(async () => {GlobalRegistrator.register({url: 'http://localhost/'}); await setWikiLanguage('en');});
afterEach(() => {root?.unmount(); root = undefined; document.body.innerHTML = ''; globalThis.fetch = originalFetch;});
afterAll(async () => {
  // React schedules passive cleanup after unmount; keep the DOM until that turn has run.
  await new Promise((done) => setTimeout(done, 50));
  GlobalRegistrator.unregister();
});
async function until(condition: () => boolean): Promise<void> {const end = Date.now() + 2000; while (!condition()) {if (Date.now() > end) throw new Error('contract-view.test.tsx:14: expected UI did not arrive'); await new Promise((done) => setTimeout(done, 10));}}
function mount(element: ReturnType<typeof createElement>): HTMLElement {const node = document.createElement('div'); document.body.append(node); root = createRoot(node); root.render(element); return node;}
test('Definition requests neither bytes nor renderer until the reader opens it', async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(async () => {requests++; return new Response(JSON.stringify({type: 'problem', block: 'definition', file: 'api.yaml', line: 1, message: 'fixture refusal'}), {headers: {'content-type': 'application/json'}});}, {preconnect: originalFetch.preconnect});
  const node = mount(createElement(BlockView, {pageId: 'code.contract:api.yaml', resolutions: {}, block: {type: 'deferred', block: 'definition', title: 'Definition', id: 'definition-1a2b3c4d5e6f'}}));
  await until(() => node.querySelector('details') !== null);
  expect(requests).toBe(0); expect(node.querySelector('[data-testid=contract-redoc]')).toBeNull();
  const details = node.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle'));
  await until(() => requests === 1); await until(() => node.textContent?.includes('fixture refusal') === true);
});
test('grouped catalogue preserves every owned and unowned row and both language labels', async () => {
  const row = (id: string): EntityRef => ({id, label: id, kind: 'code.operation', href: null});
  for (const language of ['en', 'ru'] as const) {
    await setWikiLanguage(language);
    const rows = [row('first'), row('second'), row('unowned')];
    const contract: EntityRef = {id: 'code.contract:api.yaml', label: 'Catalogue API', kind: 'code.contract', href: null};
    const node = mount(createElement(Operations, {rows, metadata: {first: {contracts: [{entity: contract, protocol: 'OpenAPI'}], implementedBy: [], calledBy: [], cuts: []}, second: {contracts: [{entity: contract, protocol: 'OpenAPI'}], implementedBy: [], calledBy: [], cuts: []}}}));
    await until(() => node.querySelectorAll('[data-entity]').length === 3);
    expect(node.textContent).toContain(language === 'ru' ? 'Объявляющий контракт не найден' : 'No declaring contract');
    expect(node.textContent).toContain(language === 'ru' ? 'Реализуют' : 'Implemented by');
    expect(node.querySelectorAll('h2')).toHaveLength(2);
    root?.unmount(); root = undefined; node.remove();
  }
});


test('every structured reason has both languages and preserves typed parameters', async () => {
  const reasons: ContractReason[] = [
    {code: 'definitionRepresentationBudget', params: {maxBytes: 4194304}},
    {code: 'descriptionMarkupBudget', params: {maxNodes: 100000}},
  {
    "code": "definitionMissing"
  },
  {
    "code": "contractReadBudget",
    "params": {
      "maxFiles": 7,
      "maxBytes": 7
    }
  },
  {
    "code": "yamlParse"
  },
  {
    "code": "yamlConversion"
  },
  {
    "code": "definitionObjectRequired"
  },
  {
    "code": "yamlAliasCycle"
  },
  {
    "code": "definitionNesting",
    "params": {
      "maxLevels": 7
    }
  },
  {
    "code": "referenceAnchorUnsupported",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "referenceRemoteOrAbsolute",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "referenceEncodingInvalid",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "referenceEscapesRepository",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "pointerEncodingInvalid",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "referenceUnresolved",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "externalExample",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "externalLogo",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "descriptionImage"
  },
  {
    "code": "reservedBundleField",
    "params": {
      "field": "untouched «значение»"
    }
  },
  {
    "code": "operationReferenceBudgetOrCycle",
    "params": {
      "maxReferences": 7
    }
  },
  {
    "code": "operationReferenceUnresolved",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "protoImportBudget",
    "params": {
      "maxFiles": 7,
      "maxDepth": 7
    }
  },
  {
    "code": "protoImportMissing"
  },
  {
    "code": "protoByteBudget",
    "params": {
      "maxBytes": 7
    }
  },
  {
    "code": "protoParse"
  },
  {
    "code": "protoImportInvalid",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "protoImportEscapesRepository",
    "params": {
      "ref": "untouched «значение»"
    }
  },
  {
    "code": "protoResolve"
  },
  {
    "code": "definitionSubjectUnsupported"
  },
  {
    "code": "declaringContractCount",
    "params": {
      "count": 7
    }
  },
  {
    "code": "contractFormatUnsupported",
    "params": {
      "format": "untouched «значение»"
    }
  },
  {
    "code": "contractVersionMissing",
    "params": {
      "format": "untouched «значение»"
    }
  },
  {
    "code": "operationSelectionMissing",
    "params": {
      "method": "untouched «значение»",
      "path": "untouched «значение»"
    }
  },
  {
    "code": "operationIdAmbiguous",
    "params": {
      "operationId": "untouched «значение»",
      "count": 7
    }
  },
  {
    "code": "unknownDefinitionFailure"
  },
  {
    "code": "rendererFailure"
  },
  {
    "code": "rendererValidationFailure"
  },
  {
    "code": "selectionNotRendered"
  }
];
  for (const language of ['en', 'ru'] as const) {
    await setWikiLanguage(language);
    for (const reason of reasons) {
      const text = contractReasonText(i18n.t, reason);
      expect(text).not.toContain('knowledge.');
      expect(text).not.toContain('{{');
      expect(text).not.toBe('');
      if ('params' in reason) for (const value of Object.values(reason.params)) expect(text).toContain(String(value));
    }
  }
});

test('diagnostic summaries localize but source and technical evidence stay exact', async () => {
  const source = {path: 'contracts/service.yaml', line: 17, fullPath: '/fixture/repos/neutral/contracts/service.yaml', code: 'missing', detail: 'Original vendor evidence «не переводить»'};
  const diagnostics: ContractDiagnostic[] = [
    {...source, reason: {code: 'definitionMissing'}},
    source,
    {...source, reason: {code: 'futureReason'} as unknown as ContractReason},
  ];
  for (const language of ['en', 'ru'] as const) {
    await setWikiLanguage(language);
    for (const diagnostic of diagnostics) {
      const node = mount(createElement(ContractDiagnosticView, {diagnostic}));
      await until(() => node.querySelector('[data-testid=contract-diagnostic-summary]') !== null);
      const summary = node.querySelector('[data-testid=contract-diagnostic-summary]')!.textContent!;
      expect(summary).toContain(language === 'ru' ? 'Определение недоступно' : 'Definition unavailable');
      expect(summary).not.toContain(source.detail);
      expect(node.textContent).toContain(`${source.path}:17 (${source.fullPath})`);
      expect(node.querySelector('pre')?.textContent).toBe(source.detail);
      expect(node.querySelector('[data-testid=contract-redoc]')).toBeNull();
      root?.unmount(); root = undefined; node.remove();
    }
    const failure = mount(createElement(ContractRenderProblem, {failure: {reason: {code: 'rendererFailure'}, technicalDetail: source.detail}, path: source.path, fullPath: source.fullPath}));
    await until(() => failure.querySelector('[data-testid=contract-render-summary]') !== null);
    expect(failure.querySelector('[data-testid=contract-render-summary]')?.textContent).not.toContain(source.detail);
    expect(failure.querySelector('pre')?.textContent).toBe(source.detail);
    root?.unmount(); root = undefined; failure.remove();
  }
});

test('only structured definition problems use diagnostic presentation; legacy problems stay unchanged', async () => {
  await setWikiLanguage('ru');
  const legacy = mount(createElement(BlockView, {resolutions: {}, block: {type: 'problem', block: 'other', file: 'template.md', line: 3, message: 'Legacy message unchanged'}}));
  await until(() => legacy.textContent?.includes('Legacy message unchanged') === true);
  expect(legacy.querySelector('[data-testid=contract-diagnostic]')).toBeNull();
  root?.unmount(); root = undefined; legacy.remove();
  const node = mount(createElement(BlockView, {resolutions: {}, block: {type: 'problem', block: 'definition', file: 'template.md', line: 3, message: 'Legacy definition English', diagnostic: {path: 'template.md', line: 3, fullPath: '/fixture/template.md', code: 'shape', detail: 'Legacy definition English', reason: {code: 'declaringContractCount', params: {count: 2}}}}}));
  await until(() => node.querySelector('[data-testid=contract-diagnostic-summary]') !== null);
  expect(node.querySelector('[data-testid=contract-diagnostic-summary]')?.textContent).toContain('найдено: 2');
  expect(node.querySelector('[data-testid=contract-diagnostic-summary]')?.textContent).not.toContain('Legacy definition English');
});

test('truncation uses localized product relation labels and a safe unknown fallback', async () => {
  const relations = ['code.declares', 'code.serves', 'code.implements', 'code.calls', 'code.calls-remote', 'extension.future-related'];
  const entity: EntityRef = {id: 'neutralOperation', kind: 'code.operation', label: 'fetchRecord', href: null};
  for (const language of ['en', 'ru'] as const) {
    await setWikiLanguage(language);
    const node = mount(createElement(Operations, {rows: [entity], metadata: {[entity.id]: {contracts: [], implementedBy: [], calledBy: [], cuts: relations.map((relation) => ({relation, shown: 1, total: 501}))}}}));
    await until(() => node.querySelectorAll('td p').length === relations.length);
    expect(node.textContent).toContain(language === 'ru' ? 'объявляющие контракты' : 'declaring contracts');
    expect(node.textContent).toContain(language === 'ru' ? 'реализации' : 'implementations');
    expect(node.textContent).toContain(language === 'ru' ? 'вызывающие объекты' : 'callers');
    expect(node.textContent).toContain(language === 'ru' ? 'связанные объекты' : 'related links');
    for (const relation of relations) expect(node.textContent).not.toContain(relation);
    for (const notice of node.querySelectorAll('td p')) {expect(notice.textContent).toContain('1'); expect(notice.textContent).toContain('501');}
    root?.unmount(); root = undefined; node.remove();
  }
});


test('English and Russian diagnostic catalogues have identical reason placeholders', () => {
  const placeholders = (text: string): string[] => {
    const found: string[] = []; let from = 0;
    while (from < text.length) {
      const start = text.indexOf('{{', from); if (start < 0) break;
      const end = text.indexOf('}}', start + 2); if (end < 0) throw new Error('unclosed locale placeholder');
      found.push(text.slice(start + 2, end).trim()); from = end + 2;
    }
    return [...new Set(found)].sort();
  };
  expect(Object.keys(en.knowledge.contractReason).sort()).toEqual(Object.keys(ru.knowledge.contractReason).sort());
  for (const key of Object.keys(en.knowledge.contractReason) as (keyof typeof en.knowledge.contractReason)[]) expect(placeholders(en.knowledge.contractReason[key])).toEqual(placeholders(ru.knowledge.contractReason[key]));
});

test('description image preflight parses real images, not literal code or safe HTML', () => {
  const source = {path: 'contracts/service.yaml', line: 17, fullPath: '/fixture/repos/neutral/contracts/service.yaml'};
  for (const text of ['![record](https://invalid.example/image.png)', '![record][logo]\n\n[logo]: local.png', '<IMG SRC=local.png>', '<svg><image href="local.png" /></svg>', '<template><img src="local.png"></template>']) {
    expect(descriptionImageDiagnostic([{...source, text}])).toMatchObject({...source, code: 'reference', reason: {code: 'descriptionImage'}});
  }
  for (const text of ['`![literal](local.png)`', '```md\n![literal](local.png)\n```', '<em>Keep this text</em>', '[ordinary link](local.png)', '\\![escaped](local.png)']) expect(descriptionImageDiagnostic([{...source, text}])).toBeUndefined();
});

test('image preflight prevents every renderer mount and performs no fetch', async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(async () => {requests++; throw new Error('preflight must not fetch');}, {preconnect: originalFetch.preconnect});
  for (const format of ['openapi', 'asyncapi', 'proto'] as const) {
    const block: Extract<Block, {type: 'definition'}> = {type: 'definition', title: 'Definition', format, contract: 'contracts/service.yaml', members: [], membersTotal: 0, membersShown: 0, memberCuts: [], spec: {text: '', lines: 0}, document: {}, protobuf: {services: [], messages: []}, descriptions: [{text: '![record](image.png)', path: 'contracts/service.yaml', line: 17, fullPath: '/fixture/repos/neutral/contracts/service.yaml'}]};
    const node = mount(createElement(ContractView, {block}));
    await until(() => node.querySelector('[data-testid=contract-diagnostic]') !== null);
    expect(node.querySelector('[data-testid=contract-redoc]')).toBeNull(); expect(node.querySelector('[data-testid=contract-asyncapi]')).toBeNull(); expect(node.querySelector('[data-testid=contract-proto]')).toBeNull();
    expect(requests).toBe(0);
    root?.unmount(); root = undefined; node.remove();
  }
});


test('RendererBoundary catches an actual child error and separates original evidence', async () => {
  await setWikiLanguage('ru');
  function Broken(): never {throw new Error('Original renderer evidence «не переводить»');}
  const node = mount(createElement(RendererBoundary, {path: 'contracts/service.yaml', fullPath: '/fixture/repos/neutral/contracts/service.yaml', children: createElement(Broken)}));
  await until(() => node.querySelector('[data-testid=contract-render-summary]') !== null);
  expect(node.querySelector('[data-testid=contract-render-summary]')?.textContent).toContain('Не удалось');
  expect(node.querySelector('[data-testid=contract-render-summary]')?.textContent).not.toContain('Original renderer evidence');
  expect(node.querySelector('pre')?.textContent).toBe('Error: Original renderer evidence «не переводить»');
});

test('actual adapter callback boundaries preserve errors and selected operation identity', async () => {
  expect(redocLoadedFailure(undefined)).toBeNull();
  expect(redocLoadedFailure(new Error('Original Redoc evidence'))).toEqual({reason: {code: 'rendererFailure'}, technicalDetail: 'Original Redoc evidence'});
  expect(asyncApiEventFailure('other', 'error', 'ignored')).toBeNull();
  expect(asyncApiEventFailure('error', 'error', 'Original AsyncAPI evidence')).toEqual({reason: {code: 'rendererFailure'}, technicalDetail: 'Original AsyncAPI evidence'});
  expect(asyncApiEventFailure('error', 'error', {message: 'unchanged'})).toEqual({reason: {code: 'rendererFailure'}, technicalDetail: '{"message":"unchanged"}'});
  expect(asyncApiEventFailure('error', 'error', undefined)).toEqual({reason: {code: 'rendererFailure'}});
  const circular: {self?: unknown} = {}; circular.self = circular;
  const failure = asyncApiEventFailure('error', 'error', circular);
  expect(failure?.reason).toEqual({code: 'rendererFailure'});
  expect(failure?.technicalDetail).toContain('could not be serialized');
  expect(contractValidationFailure(undefined)).toEqual({reason: {code: 'rendererValidationFailure'}});
  const container = document.createElement('div');
  const selected = document.createElement('section'); selected.dataset['sectionId'] = 'operation/fetchRecord'; container.append(selected);
  expect(selectContractOperation(container, 'fetchRecord')).toBe(selected);
  expect(selectContractOperation(container, 'anotherOperation')).toBeNull();
  await setWikiLanguage('ru');
  const node = mount(createElement(ContractRenderProblem, {failure: contractSelectionFailure(), path: 'contracts/service.yaml', fullPath: '/fixture/repos/neutral/contracts/service.yaml'}));
  await until(() => node.querySelector('[data-testid=contract-render-summary]') !== null);
  expect(node.querySelector('[data-testid=contract-render-summary]')?.textContent).toContain('Выбранная операция');
  expect(node.querySelector('pre')).toBeNull();
});


test('AsyncAPI catalogue shows declared application flow and unavailable extraction honestly', async () => {
  const row: EntityRef = {id: 'code.channel:inventory.adjusted', label: 'inventory.adjusted', kind: 'code.channel', href: '/k/e/code.channel%3Ainventory.adjusted'};
  const owner: EntityRef = {id: 'code.contract:events.yaml', label: 'Events', kind: 'code.contract', href: '/k/e/code.contract%3Aevents.yaml'};
  const actor: EntityRef = {id: 'code.file:emit.ts', label: 'emit.ts', kind: 'code.file', href: null};
  await setWikiLanguage('en');
  const node = mount(createElement(Operations, {rows: [row], metadata: {[row.id]: {contracts: [{entity: owner, protocol: 'AsyncAPI', directions: ['subscribe', 'publish'], directionStatus: 'known', producedBy: [actor], consumedBy: []}], implementedBy: [], calledBy: [], cuts: []}}}));
  await until(() => node.textContent?.includes('Application produces messages') === true);
  expect(node.textContent).toContain('Application produces messages (Subscribe): emit.ts'); expect(node.textContent).toContain('Application consumes messages (Publish)');
  expect(node.querySelector('a')?.getAttribute('href')).toBe(owner.href);
});


test('split inline HTML retains SVG and picture context without flagging audio or literal text', () => {
  const source = {path: 'contracts/service.yaml', line: 9, fullPath: '/fixture/repos/neutral/contracts/service.yaml'};
  for (const text of ['before <svg> words <image href="image.png"/> words </svg> after', 'before <picture> words <source srcset="image.png"> words </picture> after']) expect(descriptionImageDiagnostic([{...source, text}])?.reason).toEqual({code: 'descriptionImage'});
  for (const text of ['<audio><source src="audio.ogg"></audio>', '<video><source src="video.mp4"></video>', '<!-- <img src="image.png"> -->', '`<svg><image href="image.png"/></svg>`', '````html\n<picture><source srcset="image.png"></picture>\n````']) expect(descriptionImageDiagnostic([{...source, text}])).toBeUndefined();
});
