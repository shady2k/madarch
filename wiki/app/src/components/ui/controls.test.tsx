import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';


let root: Root | undefined;
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
let RadioGroup: typeof import('./radio-group.js').RadioGroup;
let RadioGroupItem: typeof import('./radio-group.js').RadioGroupItem;
let Switch: typeof import('./switch.js').Switch;
let Progress: typeof import('./progress.js').Progress;
let kit: typeof import('./select.js');
beforeAll(async () => {
  GlobalRegistrator.register();
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ({ RadioGroup, RadioGroupItem } = await import('./radio-group.js'));
  ({ Switch } = await import('./switch.js'));
  ({ Progress } = await import('./progress.js'));
  kit = await import('./select.js');
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  document.body.innerHTML = '';
});
afterAll(() => {
  if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  GlobalRegistrator.unregister();
});

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return container;
}

test('radio and switch expose checked state; progress exposes bounds', async () => {
  const container = mount();
  await act(async () => { root!.render(<><RadioGroup defaultValue="en" aria-label="Language"><RadioGroupItem value="en" aria-label="English" /><RadioGroupItem value="ru" aria-label="Russian" /></RadioGroup><Switch aria-label="Grounds" /><Progress value={25} max={50} aria-label="Published" /></>); });
  const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  await act(async () => { radios[1]!.click(); });
  expect(radios[0]?.getAttribute('aria-checked')).toBe('false');
  expect(radios[1]?.getAttribute('aria-checked')).toBe('true');
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => { toggle.click(); });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  const progress = container.querySelector('[role="progressbar"]')!;
  expect(progress.getAttribute('aria-valuenow')).toBe('25');
  expect(progress.getAttribute('aria-valuemax')).toBe('50');
});


test('invalid fields retain accessible names and error descriptions', async () => {
  const { Input } = await import('./input.js');
  const { Textarea } = await import('./textarea.js');
  const container = mount();
  await act(async () => { root!.render(<><p id="required">Required</p><Input aria-label="Name" aria-invalid="true" aria-describedby="required" /><Textarea aria-label="Description" aria-invalid="true" aria-describedby="required" /><RadioGroup aria-label="Language" aria-invalid="true"><RadioGroupItem value="en" aria-label="English" /></RadioGroup><Switch aria-label="Grounds" aria-invalid="true" /></>); });
  const invalid = container.querySelectorAll('[aria-invalid="true"]');
  expect(invalid.length).toBe(4);
  for (const field of invalid) expect(field.getAttribute('aria-label')).not.toBeNull();
  expect(container.querySelector('input')?.getAttribute('aria-describedby')).toBe('required');
  expect(container.querySelector('textarea')?.getAttribute('aria-describedby')).toBe('required');
});

test('a Select whose first choice is empty opens, selects it and reports the empty value (madarch-64o5.82)', async () => {
  // Radix refuses an empty item's value, and four menus offer "none" that way; the kit maps '' to a private value and
  // back, so a caller can always name the empty choice.
  const chosen: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const { createElement } = await import('react');
  await act(async () => {
    root!.render(createElement(kit.Select, { defaultValue: '', onValueChange: (next: string) => { chosen.push(next); } },
      createElement(kit.SelectTrigger, { 'aria-label': 'agent' }, createElement(kit.SelectValue, {})),
      createElement(kit.SelectContent, {},
        createElement(kit.SelectItem, { value: '' }, 'None'),
        createElement(kit.SelectItem, { value: 'claude-code' }, 'Claude Code'),
      )));
  });
  const trigger = host.querySelector('[role="combobox"]') as HTMLElement;
  expect(trigger).not.toBeNull();
  // The empty default stands as the chosen item, not as a missing value.
  expect(trigger.textContent).toContain('None');
  await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); });
  const options = [...document.querySelectorAll('[role="option"]')];
  expect(options.map((one) => one.textContent)).toEqual(['None', 'Claude Code']);
  const other = options.find((one) => one.textContent === 'Claude Code')!;
  await act(async () => { other.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); });
  expect(chosen).toEqual(['claude-code']);
  // And back to the empty choice: a caller hears `''`, the value four menus name "none" with.
  await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); });
  const none = [...document.querySelectorAll('[role="option"]')].find((one) => one.textContent === 'None')!;
  await act(async () => { none.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); });
  expect(chosen).toEqual(['claude-code', '']);
});
