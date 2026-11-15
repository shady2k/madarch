import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';


let root: Root | undefined;
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
let RadioGroup: typeof import('./radio-group.js').RadioGroup;
let RadioGroupItem: typeof import('./radio-group.js').RadioGroupItem;
let Progress: typeof import('./progress.js').Progress;
let Button: typeof import('./button.js').Button;
let IconButton: typeof import('./button.js').IconButton;
let Toggle: typeof import('./toggle.js').Toggle;
beforeAll(async () => {
  GlobalRegistrator.register();
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ({ RadioGroup, RadioGroupItem } = await import('./radio-group.js'));
  ({ Progress } = await import('./progress.js'));
  ({ Button, IconButton } = await import('./button.js'));
  ({ Toggle } = await import('./toggle.js'));
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

test('the radio group exposes the chosen option; progress exposes its bounds', async () => {
  const container = mount();
  await act(async () => { root!.render(<><RadioGroup defaultValue="en" aria-label="Language"><RadioGroupItem value="en" aria-label="English" /><RadioGroupItem value="ru" aria-label="Russian" /></RadioGroup><Progress value={25} max={50} aria-label="Published" /></>); });
  const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  await act(async () => { radios[1]!.click(); });
  expect(radios[0]?.getAttribute('aria-checked')).toBe('false');
  expect(radios[1]?.getAttribute('aria-checked')).toBe('true');
  const radio = container.querySelector<HTMLButtonElement>('[role="radio"]')!;
  expect(radio.getAttribute('role')).toBe('radio');
  const progress = container.querySelector('[role="progressbar"]')!;
  expect(progress.getAttribute('aria-valuenow')).toBe('25');
  expect(progress.getAttribute('aria-valuemax')).toBe('50');
});


test('a disabled press shows its reason beside it and names it as its accessible description', async () => {
  const container = mount();
  await act(async () => {
    root!.render(<>
      <Button disabled disabledReason="Nothing is chosen">Save</Button>
      <IconButton label="Refresh" disabled disabledReason="A reload is running"><svg aria-hidden="true" width="16" height="16" /></IconButton>
      <Toggle pressed={false} onPressedChange={() => undefined} disabled disabledReason="The list is being read">One</Toggle>
      <Button>Open</Button>
    </>);
  });
  const presses = [...container.querySelectorAll<HTMLButtonElement>('button')];
  expect(presses).toHaveLength(4);
  for (const [at, reason] of [[0, 'Nothing is chosen'], [1, 'A reload is running'], [2, 'The list is being read']] as const) {
    const press = presses[at]!;
    expect(press.disabled).toBe(true);
    const described = press.getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    expect(container.querySelector(`#${CSS.escape(described!)}`)?.textContent).toBe(reason);
    // Outside the button: the reason is a sibling, so the press is still announced by its own words.
    expect(press.textContent).not.toContain(reason);
  }
  expect(presses[3]!.getAttribute('aria-describedby')).toBeNull();
  expect(presses.every((press) => press.parentElement?.className.includes('inline-flex'))).toBe(true);
});

test('invalid fields retain accessible names and error descriptions', async () => {
  const { Input } = await import('./input.js');
  const { Textarea } = await import('./textarea.js');
  const container = mount();
  await act(async () => { root!.render(<><p id="required">Required</p><Input aria-label="Name" aria-invalid="true" aria-describedby="required" /><Textarea aria-label="Description" aria-invalid="true" aria-describedby="required" /><RadioGroup aria-label="Language" aria-invalid="true"><RadioGroupItem value="en" aria-label="English" /></RadioGroup></>); });
  const invalid = container.querySelectorAll('[aria-invalid="true"]');
  expect(invalid.length).toBe(3);
  for (const field of invalid) expect(field.getAttribute('aria-label')).not.toBeNull();
  expect(container.querySelector('input')?.getAttribute('aria-describedby')).toBe('required');
  expect(container.querySelector('textarea')?.getAttribute('aria-describedby')).toBe('required');
});
