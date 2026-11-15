/**
 * One group of choices (madarch-64o5.127): the map's renderer switch, the settings page's language and reader role.
 * The choices are the kit's toggles, never buttons of another look; a disabled group carries the reason the kit shows
 * beside each choice (madarch-64o5.123).
 */
import type { ReactElement } from 'react';
import type { DisabledState } from './button.js';
import { Toggle } from './toggle.js';

export function SegmentedChoice({ label, testId, value, options, onChange, ...state }: {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string; readonly testId: string }[];
  readonly onChange: (value: string) => void;
} & DisabledState): ReactElement {
  // The group is a press too: a disabled choice group carries the words that say why, as the kit's button does.
  const off = state.disabled === true ? { disabled: true as const, disabledReason: state.disabledReason } : {};
  return (
    <div className="dg-seg" data-testid={testId}>
      <span className="dg-seg-label">{label}</span>
      <div className="dg-seg-options" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <Toggle
            key={option.value}
            role="radio"
            aria-checked={value === option.value}
            aria-pressed={undefined}
            pressed={value === option.value}
            onPressedChange={() => onChange(option.value)}
            {...off}
            data-testid={option.testId}
          >
            {option.label}
          </Toggle>
        ))}
      </div>
    </div>
  );
}
