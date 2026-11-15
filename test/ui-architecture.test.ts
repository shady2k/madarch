import { describe, expect, test } from 'bun:test';
import { compareUiDebt, isUiSource, kitDuplicateExports, RAW_UI_ELEMENTS, readUiBaseline, renderUiBaseline, uiViolations } from '../scripts/check/architecture/ui.js';
const file = 'wiki/app/src/knowledge/fixture.tsx';
const rules = (source: string) => uiViolations(file, source).map(entry => entry.rule);

describe('UI kit architecture', () => {
  test('whole-dialog scrolling is refused with its source line, including kit surfaces', () => {
    for (const name of ['DialogContent', 'DialogPreview', 'SheetContent', 'DialogPrimitive.Content']) {
      for (const file of ['wiki/app/src/knowledge/fixture.tsx', 'wiki/app/src/components/ui/dialog.tsx']) {
        const found = uiViolations(file, `const view = (
<${name} className="flex overflow-y-auto" />);`);
        expect(found).toContainEqual(expect.objectContaining({ rule: 'dialog-whole-scroll', file, line: 2 }));
      }
    }
    expect(rules('import * as Modal from "@/components/ui/dialog.js"; const view = <Modal.DialogContent className="overflow-auto" />')).toContain('dialog-whole-scroll');
    expect(rules('import { DialogContent as Modal } from "@/components/ui/dialog.js"; const view = <Modal className={`overflow-y-auto ${extra}`} />')).toContain('dialog-whole-scroll');
    expect(rules('const surface = "overflow-y-auto"; const view = <DialogContent className={cn(surface)} />')).toContain('dialog-whole-scroll');
    expect(rules('<DialogContent><DialogHeader /><DialogBody className="overflow-y-auto" /><DialogFooter /></DialogContent>')).toEqual([]);
  });
  test('sidebar icons reject empty AST literals independent of whitespace', () => {
    for (const value of [' null ', ' undefined ', ' false ', ' true ']) {
      expect(rules(`<NavigationLink icon={${value}} />`)).toContain('sidebar-missing-icon');
    }
  });
  test('every sidebar entry requires its kit-owned icon', () => {
    for (const name of ['NavigationLink', 'NavigationGroupTrigger', 'NavigationSubheading']) {
      expect(rules(`<${name}>Label</${name}>`)).toContain('sidebar-missing-icon');
      expect(rules(`import * as Nav from "@/components/ui/navigation.js"; const view = <Nav.${name} />`)).toContain('sidebar-missing-icon');
      expect(rules(`<${name} icon={ null }>Label</${name}>`)).toContain('sidebar-missing-icon');
      expect(rules(`<${name} icon={null}>Label</${name}>`)).toContain('sidebar-missing-icon');
      expect(rules(`<${name} icon={HomeIcon}>Label</${name}>`)).toEqual([]);
    }
  });
  test('every centralized native UI tag is refused', () => {
    for (const tag of RAW_UI_ELEMENTS) expect(rules(`const node = <${tag} />`)).toContain('raw-ui-element');
  });
  test('inline style on intrinsic and kit JSX is refused', () => {
    for (const tag of ['div', 'Panel']) expect(rules(`const node = <${tag} style={{ color: 'red' }} />`)).toContain('inline-style');
  });
  test('styled-components import is refused', () => {
    expect(rules(`import styled from 'styled-components';`)).toContain('styled-components');
    expect(rules(`import { css } from 'styled-components/macro';`)).toContain('styled-components');
  });
  test('arbitrary Tailwind values in JSX strings and expressions are refused', () => {
    for (const value of ['"max-w-[70ch]"', '"max-w-prose"', '"md:max-w-lg"', '"w-[23px]"', `{active ? 'hover:bg-[#fff]' : 'p-2'}`, '{`w-[${width}px]`}', `{cn('grid-cols-[1fr_2fr]', extra)}`]) {
      expect(rules(`const node = <Panel className=${value} />`)).toContain('arbitrary-tailwind');
    }
  });
  test('local JSX function components with intrinsic className are refused', () => {
    for (const source of [
      'function Tile() { return <div className="p-2" />; }',
      'const Tile = () => <section><span className="text-sm" /></section>;',
      'const Tile = function() { return <div className="p-2" />; };',
      'const Tile = memo(forwardRef(() => <div className="p-2" />));',
      'function Tile() { return items.map(item => <div className="p-2" />); }',
    ]) expect(rules(source)).toContain('local-styled-component');
  });
  test('kit-only composition, ordinary strings, and unstyled content pass', () => {
    expect(rules(`import { Panel, Button, Stack, PageTitle } from '../components/ui';
      export function Page() { return <Stack><Panel><PageTitle>Title</PageTitle><Button>Save</Button></Panel></Stack>; }
      const example = '<button style={} className="w-[4px]" />';
      // <button style={{}} />
    `)).toEqual([]);
    expect(rules('function Tile() { const unrelated = () => <div className="p-2" />; return <Panel />; }')).toEqual([]);
  });
  test('only non-test application TSX outside the kit is checked', () => {
    for (const excluded of ['wiki/app/src/components/ui/panel.tsx', 'wiki/app/src/page.test.tsx', 'wiki/app/src/page.spec.tsx', 'wiki/app/src/__tests__/page.tsx', 'src/page.tsx']) {
      expect(isUiSource(excluded)).toBe(false);
      expect(uiViolations(excluded, '<button />')).toEqual([]);
    }
    expect(isUiSource(file)).toBe(true);
  });
  test('the kit\'s one button refuses a shape prop and a disabled press without its reason', () => {
    const button = 'import { Button, IconButton } from "../components/ui/button.js";';
    const toggle = 'import { Toggle } from "../components/ui/toggle.js";';
    for (const prop of ['variant="default"', 'size="icon"', 'className="mt-2"']) {
      expect(rules(`${button} const view = <Button ${prop}>Save</Button>;`)).toContain('button-variant');
    }
    expect(rules(`${button} const view = <IconButton label="Refresh" size="sm" />;`)).toContain('button-variant');
    expect(rules(`${toggle} const view = <Toggle pressed={false} onPressedChange={() => {}} className="x">One</Toggle>;`)).toContain('button-variant');
    for (const source of [
      `${button} const view = <Button disabled>Save</Button>;`,
      `${button} const view = <Button disabled={busy}>Save</Button>;`,
      `${button} const view = <IconButton label="Next" disabled />;`,
      `${toggle} const view = <Toggle pressed={false} onPressedChange={() => {}} disabled>One</Toggle>;`,
    ]) expect(rules(source)).toContain('button-disabled-reason');
    // An alias and a namespace resolve to the same control.
    expect(rules('import { Button as Press } from "../components/ui/button.js"; const view = <Press variant="ghost">Save</Press>;')).toContain('button-variant');
    expect(rules('import * as ui from "../components/ui/button.js"; const view = <ui.Button disabled>Save</ui.Button>;')).toContain('button-disabled-reason');
    // The kit's own files are where the look and the reason live, so they are not held to the rule.
    expect(uiViolations('wiki/app/src/components/ui/button.tsx', 'const view = <button className="px-3" />;')).toEqual([]);
    // A shaped press that is neither disabled nor shapes a kit control passes.
    expect(rules(`${button} ${toggle} const view = <><Button disabled disabledReason="Nothing to save">Save</Button><IconButton label="Next" /><Toggle pressed={false} onPressedChange={() => {}}>One</Toggle></>;`)).toEqual([]);
    expect(rules('const view = <Button variant="default" className="mt-2">Save</Button>;')).toEqual([]);
  });
  test('the raw constructs the kit covers are refused on a page', () => {
    // One component per job starts at the point of use: a page that draws its own heading, paragraph, list, link, code,
    // quote, figure or region is a second component for a job the kit already covers (madarch-64o5.130).
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'pre', 'code',
      'strong', 'em', 'b', 'i', 'small', 'blockquote', 'figure', 'figcaption', 'article', 'section', 'header', 'footer',
      'nav', 'aside', 'time', 'address', 'hr', 'q', 'cite', 'abbr', 'kbd', 'samp', 'var', 'mark', 'sub', 'sup']) {
      expect(rules(`const node = <${tag}>Text</${tag}>;`)).toContain('raw-ui-element');
    }
    // The kit's own files are where those constructs are composed, so they are not held to the rule.
    expect(uiViolations('wiki/app/src/components/ui/kit-preview.tsx', 'const view = <h2>Title</h2>;')).toEqual([]);
  });
  test('a kit name offered by two files is refused as two components for one job', () => {
    const first = 'wiki/app/src/components/ui/alpha.tsx';
    const second = 'wiki/app/src/components/ui/beta.tsx';
    const found = kitDuplicateExports(new Map([
      [second, 'export function Thing() { return null; }\nexport function Other() { return null; }'],
      [first, 'export function Thing() { return null; }'],
    ]));
    expect(found).toEqual([{ rule: 'kit-duplicate-export', file: second, subject: 'Thing', line: 1 }]);
    expect(kitDuplicateExports(new Map([[first, 'export function Thing() { return null; }'], [second, 'export function Other() { return null; }']]))).toEqual([]);
  });
  test('baseline refuses new, stale and duplicate debt and round-trips deterministically', () => {
    const found = uiViolations(file, 'const view = <button />');
    expect(compareUiDebt(found, []).added).toEqual(found);
    expect(compareUiDebt([], found).stale).toEqual(found);
    expect(compareUiDebt(found, [...found, ...found]).duplicated).toEqual(found);
    const baseline = readUiBaseline(renderUiBaseline(found));
    expect(compareUiDebt(found, baseline)).toEqual({ added: [], stale: [], duplicated: [] });
    expect(() => readUiBaseline('[{"rule":"unknown"}]')).toThrow();
  });
  test('line shifts preserve identity but additional identical violations are new', () => {
    const before = uiViolations(file, 'const view = <button />');
    expect(compareUiDebt(uiViolations(file, '\n\nconst view = <button />'), before).added).toEqual([]);
    expect(compareUiDebt(uiViolations(file, 'const view = <><button /><button /></>'), before).added).toHaveLength(1);
  });
});
