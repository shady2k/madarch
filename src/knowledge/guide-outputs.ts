/**
 * The two guide outputs the starter set declares, as page ids. The one graph has
 * no guide writer yet: a guide page stands as a page with a gap, never as an
 * artifact read from a second store.
 */
export const GUIDE_OUTPUTS = {
  'administrator-guide': { id: 'administrator-guide:main' },
  'user-guide': { id: 'user-guide:main' },
} as const;

export type GuideKind = keyof typeof GUIDE_OUTPUTS;
export type GuideLocale = 'en' | 'ru';
