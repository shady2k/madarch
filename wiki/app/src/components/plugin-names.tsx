
/** A plugin's name for a reader: its declaration's label in the reader's language, else its id in code style. */
import { Fragment, type ReactElement } from 'react';
import { InlineCode } from './ui/inline-content.js';
import { Text } from './ui/typography.js';
import type { FillPlanView } from './command.js';

export function PluginNames({ names, plan, language }: {
  readonly names: readonly string[];
  readonly plan: FillPlanView | undefined;
  readonly language: string;
}): ReactElement {
  return (
    <>
      {names.map((name, at) => {
        const labels = plan?.plugins?.find((plugin) => plugin.name === name)?.labels;
        const label = labels?.[language] ?? labels?.['en'];
        return (
          <Fragment key={name}>
            {at > 0 ? <Text>, </Text> : null}
            {label === undefined || label === '' ? <InlineCode>{name}</InlineCode> : <Text>{label}</Text>}
          </Fragment>
        );
      })}
    </>
  );
}
