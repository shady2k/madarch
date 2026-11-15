/**
 * A surface that paints a scheme colour names the foreground it is read on (madarch-64o5.136). A class pair that paints
 * the page without the page's ink makes the text unreadable in dark; an ink surface without the page's colour is dark text
 * on dark ink in light. These are the two pairs the shell and the graph surfaces carry.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge } from './badge.js';
import { GraphBox } from './graph.js';
import { ShellTab, ShellToolbar } from './shell.js';

test('a surface that paints the page names the page\'s ink', () => {
  const toolbar = renderToStaticMarkup(<ShellToolbar />);
  expect(toolbar).toContain('bg-page');
  expect(toolbar).toContain('text-ink');
  const tab = renderToStaticMarkup(<ShellTab active={true} />);
  expect(tab).toContain('bg-page');
  expect(tab).toContain('text-ink');
});

test('an ink surface names the page as its text, and a page surface names the ink', () => {
  const solid = renderToStaticMarkup(<Badge variant="solid">Open</Badge>);
  expect(solid).toContain('bg-ink');
  expect(solid).toContain('text-page');
  const box = renderToStaticMarkup(<GraphBox width={20} height={20} active={false}>a</GraphBox>);
  expect(box).toContain('bg-page');
  expect(box).toContain('text-ink');
});
