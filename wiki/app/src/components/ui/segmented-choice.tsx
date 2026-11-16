import type { ReactElement } from 'react';
import { ToggleGroup, ToggleGroupItem } from './toggle-group.js';

/**
 * One group of the map's controls: its label and a segmented choice, never
 * breaking inside the group. The choice is the kit's ToggleGroup — Radix's
 * single-selection toggle group, which carries the group's name, the roving
 * focus and the pressed state — rather than a radio group rebuilt on buttons.
 */
export function SegmentedChoice({ label, testId, value, options, onChange, disabled = false }: {
  label: string;
  testId: string;
  value: string;
  options: readonly { value: string; label: string; testId: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className="dg-seg" data-testid={testId}>
      <span className="dg-seg-label" aria-hidden="true">{label}</span>
      <ToggleGroup
        type="single"
        value={value}
        aria-label={label}
        className="dg-seg-options"
        onValueChange={(next) => { if (next !== '') onChange(next); }}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} disabled={disabled} data-testid={option.testId}>{option.label}</ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
