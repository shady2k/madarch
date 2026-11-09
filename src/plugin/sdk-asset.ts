/**
 * The SDK's own source, as the closure builder hands it to a plugin
 * (`src/plugin-sdk.ts`). Bun's text loader embeds the file in the compiled
 * binary and reads it in a checkout, so the SDK a plugin runs with is the one
 * this build carries: there is no second copy to go stale.
 */
// @ts-expect-error Bun's text loader answers the file's text as the default export; TypeScript has no such module.
import sdkText from '../plugin-sdk.ts' with { type: 'text' };

/** The SDK's source, exactly as the file stands in this build. */
export const SDK_SOURCE: string = sdkText as string;
