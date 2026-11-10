/**
 * The Files page's measures and colours (madarch-j9ao.1): what a cell's area and
 * colour stand for, the ramp of each continuous measure, and the colour of each
 * language. One module answers for the map, its legend and the table's cells, so
 * a file has one colour everywhere on the page.
 *
 * The hues are the wiki's own: graphite structure, the existing warmth for
 * change, and muted pairs that hold in the light and the dark scheme.
 */
import type { FilesMapColour, FilesMapFile, FilesMapWindow } from './types.js';

/** The index of a window in a file's `heat`. */
export const WINDOW_INDEX: Record<FilesMapWindow, 0 | 1 | 2 | 3> = { '30d': 0, '90d': 1, '1y': 2, all: 3 };

/** The window a heat value counts, as the page names it. */
export const WINDOWS: readonly FilesMapWindow[] = ['30d', '90d', '1y', 'all'];

/** Commits touching the file in the window. */
export function heatOf(file: FilesMapFile, window: FilesMapWindow): number {
  return file.heat[WINDOW_INDEX[window]] ?? 0;
}

/** The days since the last change the graph holds; null when no commit touched the file. */
export function ageDaysOf(file: FilesMapFile, now: number): number | null {
  if (file.last === null) return null;
  const at = Date.parse(file.last);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now - at) / 86_400_000));
}

/** The number a colour measure gives a file, or null when it has none (no change, no author). */
export function measureOf(file: FilesMapFile, colour: FilesMapColour, window: FilesMapWindow, now: number): number | null {
  switch (colour) {
    case 'heat': return heatOf(file, window);
    case 'age': return ageDaysOf(file, now);
    case 'authors': return file.authors.length;
    case 'language': return null;
  }
}

/** The greatest of a measure over the files: the top of its ramp. */
export function maxMeasure(files: readonly FilesMapFile[], colour: FilesMapColour, window: FilesMapWindow, now: number): number {
  let max = 0;
  for (const file of files) {
    const value = measureOf(file, colour, window, now);
    if (value !== null && value > max) max = value;
  }
  return max;
}

/** A ramp from the quietest value to the strongest, as ECharts reads a colour range. */
export interface Ramp {
  colors: readonly string[];
  /** The colour a value of no measure is drawn in (a file no commit touched), so it is never confused with the top. */
  none: string;
}

/**
 * The ramps of the continuous measures. Heat keeps the wiki's warmth (the old
 * treemap's cold-to-hot pair); age runs from warm for a fresh change to graphite
 * for an old one; authors deepen from the quiet surface to a green the design
 * keeps beside its amber. Each holds in the light and the dark scheme.
 */
export const RAMPS: Record<Exclude<FilesMapColour, 'language'>, { light: Ramp; dark: Ramp }> = {
  heat: {
    light: { colors: ['#f3efe6', '#e0c28a', '#c98a2e', '#8c5a14'], none: '#f7f7f8' },
    dark: { colors: ['#3a3831', '#6b5530', '#a8772a', '#d9a347'], none: '#303030' },
  },
  age: {
    light: { colors: ['#c98a2e', '#b8b0a0', '#9a9a9a', '#6e7178'], none: '#f7f7f8' },
    dark: { colors: ['#d9a347', '#8a8478', '#8f9199', '#b6b6b6'], none: '#303030' },
  },
  authors: {
    light: { colors: ['#eef3f2', '#b9d2cd', '#7faeA6', '#4f7f79'], none: '#f7f7f8' },
    dark: { colors: ['#303735', '#4d6a66', '#6fa79f', '#a8d0c9'], none: '#303030' },
  },
};

/**
 * The colours of languages, in the order of the legend: a muted twelve-hue set
 * whose neighbouring hues stay apart, so two languages never read as one. A file
 * the claims leave ambiguous is drawn as "other" and takes the last, neutral
 * entry.
 */
export const LANGUAGE_COLOURS: readonly string[] = [
  '#7a9e7e', '#b08a5a', '#7f8fb3', '#a87c8f', '#6f9a9a', '#a0906a',
  '#8d7fb0', '#b0745f', '#6f8f6a', '#9a8fa8', '#5f8fa8', '#a3895f',
];

/** The language a file is drawn by: the one its open opinions name, or none when they name several or none. */
export function drawnLanguage(file: FilesMapFile): string | null {
  return file.language;
}

/**
 * The language values a file's open opinions name, as a reader reads them: `unknown` is the same thing as no
 * language, so it is the reader's word for the other, and the values are distinct and in code-point order. A value is
 * never dropped: a file two opinions disagree about lists both.
 */
export function languageWords(file: FilesMapFile, other: string): string[] {
  const words = new Set<string>();
  for (const opinion of file.languages) words.add(opinion.language === 'unknown' ? other : opinion.language);
  return [...words].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Every language value with the opinion that stated it, one per line: `TypeScript — linguist@9.5.0`. */
export function languageSources(file: FilesMapFile, other: string): string[] {
  return file.languages.map((opinion) => `${opinion.language === 'unknown' ? other : opinion.language} — ${opinion.saidBy}`);
}

/** A count of bytes as a reader reads it. */
export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A count as a reader reads it: 1 882 files, 214 332 lines. */
export function countText(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

/** A number of lines as a reader reads it, in millions when it is large: 1.2M. */
export function linesText(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return countText(value);
}
