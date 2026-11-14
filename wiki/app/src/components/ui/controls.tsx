/** The app's controls: a button, a text field, a select and the tabs a page groups sections as. */
import type { ReactElement, ReactNode } from 'react';

export function Button({ children, onClick, disabled, kind = 'quiet', pressed }: { readonly children: ReactNode; readonly onClick?: () => void; readonly disabled?: boolean; readonly kind?: 'quiet' | 'primary'; readonly pressed?: boolean }): ReactElement {
  const tone = kind === 'primary' ? 'bg-ink text-page' : 'bg-chrome text-ink';
  return (
    <button type="button" disabled={disabled === true} aria-pressed={pressed} className={`rounded border border-line px-3 py-1 text-small ${tone} disabled:opacity-50`} onClick={onClick}>
      {children}
    </button>
  );
}

export function TextInput({ value, placeholder, onInput, onSubmit, label }: { readonly value: string; readonly placeholder?: string; readonly onInput: (value: string) => void; readonly onSubmit?: () => void; readonly label: string }): ReactElement {
  return (
    <input
      type="search"
      aria-label={label}
      value={value}
      placeholder={placeholder}
      className="w-full rounded border border-line bg-page px-2 py-1 text-small text-ink"
      onChange={(event) => onInput(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onSubmit !== undefined) onSubmit();
      }}
    />
  );
}

export function Select({ value, options, onChange, label }: { readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[]; readonly onChange: (value: string) => void; readonly label: string }): ReactElement {
  return (
    <select aria-label={label} value={value} className="rounded border border-line bg-page px-2 py-1 text-small text-ink" onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

export function Field({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-small text-secondary">
      {label}
      {children}
    </label>
  );
}

export function Tabs({ tabs, active, onSelect }: { readonly tabs: readonly { readonly id: string; readonly label: string }[]; readonly active: string; readonly onSelect: (id: string) => void }): ReactElement {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-line pb-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={`rounded-t px-3 py-1 text-small ${tab.id === active ? 'bg-chrome font-medium text-ink' : 'text-secondary'}`}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
