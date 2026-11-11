import { describe, expect, test } from 'bun:test';
import { compareUiDebt, isUiSource, RAW_UI_ELEMENTS, readUiBaseline, renderUiBaseline, uiViolations } from '../scripts/check/architecture/ui.js';
const file = 'wiki/app/src/knowledge/fixture.tsx';
const rules = (source: string) => uiViolations(file, source).map(entry => entry.rule);

describe('UI kit architecture', () => {
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
    for (const value of ['"w-[23px]"', `{active ? 'hover:bg-[#fff]' : 'p-2'}`, '{`w-[${width}px]`}', `{cn('grid-cols-[1fr_2fr]', extra)}`]) {
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
    expect(rules(`import { Panel, Button, Stack } from '../components/ui';
      export function Page() { return <Stack><Panel><h1>Title</h1><Button>Save</Button></Panel></Stack>; }
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
