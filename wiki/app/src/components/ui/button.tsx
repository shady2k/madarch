/**
 * The kit's one button (madarch-64o5.127): one look, one height, one padding, one type size, and no variants, sizes or
 * class overrides. An action that needs another shape is another kit control — `IconButton` for a square press in a
 * toolbar, `Toggle` for a choice among options — never a button of another look.
 *
 * A disabled action carries its reason (madarch-64o5.123): the type requires `disabledReason` whenever `disabled` can be
 * true, and the kit shows it beside the button and names it as the button's accessible description.
 */
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';

/** A press is either enabled, or disabled with the words that say why. */
export type DisabledState =
  | { readonly disabled?: false; readonly disabledReason?: never }
  | { readonly disabled: boolean; readonly disabledReason: string };

type ControlAttributes = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'disabled'>;

export type ButtonProps = ControlAttributes & DisabledState & { readonly children: ReactNode };
export type IconButtonProps = ControlAttributes & DisabledState & {
  /** The press's accessible name: an icon alone tells a screen reader nothing. */
  readonly label: string;
  readonly children: ReactNode;
};

/** The one button look: the chrome ground, the line border, the control radius and the small type. */
const ACTION = 'ui-button inline-flex h-9 shrink-0 select-none items-center justify-center gap-2 rounded-[var(--radius-control)] border border-line bg-chrome [font-size:var(--fs-control)] font-normal text-ink no-underline outline-none transition-colors duration-150 motion-reduce:transition-none enabled:hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page disabled:cursor-not-allowed disabled:bg-[var(--surface-hover)] disabled:text-muted';
/** The words press's padding, and the icon press's square: one look, one height, one type size. */
const WORDS = 'px-3';
const ICON = 'size-9 p-0';

type ActionProps = ControlAttributes & {
  readonly square: boolean;
  readonly label?: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
};

const Action = forwardRef<HTMLButtonElement, ActionProps>(function Action({ square, label, children, disabled, disabledReason, ...props }, ref): ReactElement {
  const reasonId = useId();
  const reason = disabled === true ? disabledReason : undefined;
  return (
    // The reason stands beside the press, and the press's accessible description is the same words: a person who
    // cannot see the control still hears why it is off. It is the press's sibling, so the press is still announced by
    // its own label, never by its reason.
    <span className="ui-action inline-flex min-w-0 items-center gap-2">
      <button
        ref={ref}
        type="button"
        {...props}
        {...(label === undefined ? {} : { 'aria-label': label })}
        {...(reason === undefined || reason === '' ? {} : { 'aria-describedby': reasonId })}
        disabled={disabled}
        className={`${ACTION} ${square ? ICON : WORDS}`}
      >
        {children}
      </button>
      {reason === undefined || reason === '' ? null : <span id={reasonId} className="text-small text-muted">{reason}</span>}
    </span>
  );
});

/** The one press: words inside, the kit's look outside. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ disabled, disabledReason, children, ...props }, ref): ReactElement {
  return <Action ref={ref} square={false} disabled={disabled} disabledReason={disabledReason} {...props}>{children}</Action>;
});

/** The square press of a toolbar: an icon, its accessible name, and the button's own look and height. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ disabled, disabledReason, label, children, ...props }, ref): ReactElement {
  return <Action ref={ref} square label={label} disabled={disabled} disabledReason={disabledReason} {...props}>{children}</Action>;
});
