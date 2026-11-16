/**
 * A moment a reader picks (madarch-64o5.88, the owner's review of the logs page): the browser's `datetime-local` draws
 * `mm/dd/yyyy, --:-- --` in the browser's own language, so the kit's field is a button that shows the moment in the
 * reader's words and a dialog that picks it — a month's days, then the hour, the minute and the second as the kit's own
 * inputs. The panel is exported on its own so the kit page can show the open state without a click.
 */
import { useState, type ReactElement } from 'react';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from './button.js';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from './dialog.js';
import { Input } from './input.js';
import { Metadata, Stack, Text } from './typography.js';

/** The words the field draws; the page that uses it keeps the reader's language. */
export interface DateTimeLabels {
  readonly none: string;
  readonly title: string;
  readonly clear: string;
  readonly done: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  readonly previous: string;
  readonly next: string;
  readonly close: string;
}

/** The parts of a moment, in the reader's own clock (local time). */
export interface DateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The moment an ISO text names, or now: a field with no value starts from the reader's now. */
function partsOf(value: string): DateTimeParts {
  const held = value === '' ? new Date() : new Date(value);
  const at = Number.isNaN(held.getTime()) ? new Date() : held;
  return { year: at.getFullYear(), month: at.getMonth(), day: at.getDate(), hour: at.getHours(), minute: at.getMinutes(), second: at.getSeconds() };
}

/** A moment in the reader's words: the day, the month, the year and the time with its hours and minutes. */
export function formatDateTime(value: string, locale: string): string {
  if (value === '') return '';
  const held = new Date(value);
  if (Number.isNaN(held.getTime())) return '';
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(held);
}

/** The days a month holds, and the weekday its first day stands on (Monday first). */
function monthGrid(year: number, month: number): { readonly offset: number; readonly days: number } {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  return { offset, days: new Date(year, month + 1, 0).getDate() };
}

/** The panel of a moment: its month's days, then the hour, minute and second, with the two buttons that end it. */
export function DateTimePanel({ value, locale, labels, onCommit, onClear }: {
  readonly value: string;
  readonly locale: string;
  readonly labels: DateTimeLabels;
  readonly onCommit: (value: string) => void;
  readonly onClear?: () => void;
}): ReactElement {
  const [parts, setParts] = useState<DateTimeParts>(() => partsOf(value));
  const [month, setMonth] = useState(() => ({ year: parts.year, month: parts.month }));
  const grid = monthGrid(month.year, month.month);
  const days = Array.from({ length: grid.offset + grid.days }, (_, index) => (index < grid.offset ? null : index - grid.offset + 1));
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(2024, 0, 1 + index)));
  const shift = (delta: number): void => {
    const at = new Date(month.year, month.month + delta, 1);
    setMonth({ year: at.getFullYear(), month: at.getMonth() });
  };
  const choose = (day: number): void => { setParts({ ...parts, year: month.year, month: month.month, day }); };
  const number = (field: 'hour' | 'minute' | 'second', max: number, text: string): void => {
    const held = Number(text);
    if (!Number.isInteger(held) || held < 0 || held > max) return;
    setParts({ ...parts, [field]: held });
  };
  const commit = (): void => {
    const at = new Date(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
    onCommit(Number.isNaN(at.getTime()) ? '' : at.toISOString());
  };
  return (
    <Stack className="grid gap-3" data-testid="date-time-panel">
      <Stack className="flex items-center justify-between gap-2">
        <Button size="icon-sm" variant="ghost" aria-label={labels.previous} onClick={() => { shift(-1); }}><ChevronLeftIcon aria-hidden="true" size={15} /></Button>
        <Text className="text-small font-medium" data-testid="date-time-month">{new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(month.year, month.month, 1))}</Text>
        <Button size="icon-sm" variant="ghost" aria-label={labels.next} onClick={() => { shift(1); }}><ChevronRightIcon aria-hidden="true" size={15} /></Button>
      </Stack>
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label={labels.title} data-testid="date-time-days">
        {weekdays.map((word, index) => <Metadata key={`weekday-${String(index)}`} className="py-1 text-center text-[12px] uppercase text-muted">{word}</Metadata>)}
        {days.map((day, index) => (day === null
          ? <span key={`empty-${String(index)}`} aria-hidden="true" />
          : (
            <Button
              key={`day-${String(day)}`}
              size="icon-sm"
              variant={parts.day === day && parts.month === month.month && parts.year === month.year ? 'default' : 'ghost'}
              aria-label={new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(month.year, month.month, day))}
              aria-pressed={parts.day === day && parts.month === month.month && parts.year === month.year}
              onClick={() => { choose(day); }}
            >{day}</Button>
          )))}
      </div>
      <Stack className="flex items-end gap-2">
        {(['hour', 'minute', 'second'] as const).map((field) => (
          <label key={field} className="grid gap-1 text-small text-secondary">
            {labels[field]}
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={field === 'hour' ? 23 : 59}
              value={String(parts[field]).padStart(2, '0')}
              onInput={(event) => { number(field, field === 'hour' ? 23 : 59, event.currentTarget.value); }}
              data-testid={`date-time-${field}`}
              className="w-20"
            />
          </label>
        ))}
      </Stack>
      <Stack className="flex justify-end gap-2">
        {onClear === undefined ? null : <Button size="default" variant="ghost" onClick={onClear} data-testid="date-time-clear">{labels.clear}</Button>}
        <Button size="default" variant="default" onClick={commit} data-testid="date-time-done">{labels.done}</Button>
      </Stack>
    </Stack>
  );
}

export interface DateTimeFieldProps {
  /** The field's name, its accessible name and the dialog's title. */
  readonly label: string;
  /** The moment as ISO 8601, or '' for none. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly locale: string;
  readonly labels: DateTimeLabels;
  readonly testId?: string;
}

export function DateTimeField({ label, value, onChange, locale, labels, testId }: DateTimeFieldProps): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" size="default" className="w-full min-w-0 justify-start gap-2 sm:w-48" aria-label={`${label}: ${value === '' ? labels.none : formatDateTime(value, locale)}`} data-testid={testId}>
          <CalendarIcon aria-hidden="true" size={15} className="shrink-0 text-muted" />
          <Text className="min-w-0 truncate">{value === '' ? labels.none : formatDateTime(value, locale)}</Text>
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={labels.close} data-testid={testId === undefined ? undefined : `${testId}-dialog`}>
        <DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>{labels.title}</DialogDescription></DialogHeader>
        <DialogBody>
          <DateTimePanel
            value={value}
            locale={locale}
            labels={labels}
            onCommit={(next) => { onChange(next); setOpen(false); }}
            onClear={() => { onChange(''); setOpen(false); }}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
