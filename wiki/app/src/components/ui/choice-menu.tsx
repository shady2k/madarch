/**
 * A filter's choice control (madarch-64o5.88, the owner's review of the logs page): the kit's menu, not the browser's
 * select — the trigger shows the current choice in a kit button, and the menu lists every choice as a radio item, so the
 * control is drawn, themed and keyboard-driven by the kit. `label` is the control's own name (its accessible name and the
 * menu's title); `options` are the choices, in the caller's order; `value` is the chosen one.
 */
import type { ReactElement } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { Button } from './button.js';
import { cn } from '@/lib/utils.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from './dropdown-menu.js';
import { Text } from './typography.js';

export interface ChoiceMenuOption {
  readonly value: string;
  readonly label: string;
}

export interface ChoiceMenuProps {
  /** The control's name, drawn in the menu and used as its accessible name. */
  readonly label: string;
  readonly value: string;
  readonly options: readonly ChoiceMenuOption[];
  readonly onChange: (value: string) => void;
  readonly testId?: string;
  /** The trigger's own width and margins, for the page that places it. */
  readonly className?: string;
  readonly disabledReason?: string | null;
  /** Whether the menu stands open, for the kit's own review of its state. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function ChoiceMenu({ label, value, options, onChange, testId, className, disabledReason, open, onOpenChange }: ChoiceMenuProps): ReactElement {
  const current = options.find((option) => option.value === value) ?? options[0];
  const disabled = disabledReason != null;
  return (
    <DropdownMenu {...(open === undefined ? {} : { open })} {...(onOpenChange === undefined ? {} : { onOpenChange })}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="default" size="default" disabled={disabled} disabledReason={disabledReason ?? ''} className={cn('w-full min-w-0 justify-between gap-2', className ?? 'sm:w-48')} aria-label={`${label}: ${current?.label ?? ''}`} data-testid={testId}>
          <Text className="min-w-0 truncate">{current?.label ?? ''}</Text>
          <ChevronDownIcon aria-hidden="true" size={15} className="shrink-0 text-muted" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-auto">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} data-testid={testId === undefined ? undefined : `${testId}-${option.value}`}>{option.label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
