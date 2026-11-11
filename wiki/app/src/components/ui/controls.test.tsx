import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';


let root: Root | undefined;
let Tabs: typeof import('./tabs.js').Tabs;
let TabsList: typeof import('./tabs.js').TabsList;
let TabsTrigger: typeof import('./tabs.js').TabsTrigger;
let TabsContent: typeof import('./tabs.js').TabsContent;
let RadioGroup: typeof import('./radio-group.js').RadioGroup;
let RadioGroupItem: typeof import('./radio-group.js').RadioGroupItem;
let Switch: typeof import('./switch.js').Switch;
let Progress: typeof import('./progress.js').Progress;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ Tabs, TabsList, TabsTrigger, TabsContent } = await import('./tabs.js'));
  ({ RadioGroup, RadioGroupItem } = await import('./radio-group.js'));
  ({ Switch } = await import('./switch.js'));
  ({ Progress } = await import('./progress.js'));
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  document.body.innerHTML = '';
});
afterAll(() => { GlobalRegistrator.unregister(); });

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return container;
}

test('tabs connect the selected trigger to its panel', async () => {
  const container = mount();
  await act(async () => { root!.render(<Tabs defaultValue="diagram"><TabsList aria-label="View"><TabsTrigger value="diagram">Diagram</TabsTrigger><TabsTrigger value="source">Source</TabsTrigger></TabsList><TabsContent value="diagram">Picture</TabsContent><TabsContent value="source">Code</TabsContent></Tabs>); });
  const triggers = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  expect(triggers[0]?.getAttribute('aria-selected')).toBe('true');
  await act(async () => { triggers[1]!.focus(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(triggers[1]?.getAttribute('aria-selected')).toBe('true');
  const panel = container.querySelector<HTMLElement>(`[id="${triggers[1]!.getAttribute('aria-controls')}"]`);
  expect(panel?.textContent).toBe('Code');
  expect(panel?.getAttribute('aria-labelledby')).toBe(triggers[1]!.id);
});

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
