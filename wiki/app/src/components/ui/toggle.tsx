/**
 * The kit's toggle (madarch-64o5.127): a choice among options — the diagram's renderer switch, «Выбрать/Выбран» — in
 * the button's one look, one height and one type size, with the pressed state on the active ground. It is a choice, not
 * an action, so it is never drawn as a button of another look. A disabled toggle carries its reason like a button
 * (madarch-64o5.123).
 */
import { forwardRef, useId, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import * as TogglePrimitive from '@radix-ui/react-toggle';
import type { DisabledState } from './button.js';

export type ToggleProps = Omit<ComponentProps<typeof TogglePrimitive.Root>, 'className' | 'disabled' | 'pressed' | 'onPressedChange' | 'children'> & DisabledState & {
  readonly pressed: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly children: ReactNode;
};

const CHOICE = 'ui-toggle h-9 inline-flex shrink-0 select-none items-center justify-center gap-2 rounded-[var(--radius-control)] border border-line bg-chrome px-3 [font-size:var(--fs-control)] font-normal text-ink outline-none transition-colors duration-150 motion-reduce:transition-none enabled:hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page data-[state=on]:border-ink data-[state=on]:bg-[var(--surface-active)] data-[state=on]:font-medium disabled:cursor-not-allowed disabled:bg-[var(--surface-hover)] disabled:text-muted';

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle({ children, pressed, onPressedChange, disabled, disabledReason, ...props }, ref): ReactElement {
  const reasonId = useId();
  const reason = disabled === true ? disabledReason : undefined;
  return (
    // A disabled choice says why beside it, exactly as a disabled button does (madarch-64o5.123).
    <span className="ui-choice inline-flex min-w-0 items-center gap-2">
      <TogglePrimitive.Root
        ref={ref}
        {...props}
        {...(reason === undefined ? {} : { 'aria-describedby': reasonId })}
        pressed={pressed}
        onPressedChange={onPressedChange}
        disabled={disabled}
        className={CHOICE}
      >
        {children}
      </TogglePrimitive.Root>
      {reason === undefined || reason === '' ? null : <span id={reasonId} className="text-small text-muted">{reason}</span>}
    </span>
  );
});
