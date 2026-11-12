import type { ReactElement } from 'react';
import { Button } from './button.js';

/** One group of the map's controls: its label and a segmented choice, never breaking inside the group. */
export function SegmentedChoice({ label, testId, value, options, onChange }: {
  label: string;
  testId: string;
  value: string;
  options: readonly { value: string; label: string; testId: string }[];
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <div className="dg-seg" data-testid={testId}>
      <span className="dg-seg-label">{label}</span>
      <div className="dg-seg-options" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <Button variant="ghost" size="content"
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className="dg-seg-option"
            data-state={value === option.value ? 'on' : 'off'}
            onClick={() => onChange(option.value)}
            data-testid={option.testId}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

