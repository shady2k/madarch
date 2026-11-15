/**
 * One choice from a short list, as the kit's Select: a trigger with the list's
 * own keyboard behaviour and surfaces. The caller keeps the field's label, so a
 * form reads its words once and the control carries the value and the test id.
 * Radix refuses an item with an empty value; the wrapper gives "none" a name and
 * maps it back to the empty string the callers use.
 */
import type { ReactElement } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js';

export function ChoiceSelect({ value, options, onChange, disabled = false, className, testId, id, placeholder }: {
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly testId?: string;
  readonly id?: string;
  readonly placeholder?: string;
}): ReactElement {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={className} data-testid={testId} id={id}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
