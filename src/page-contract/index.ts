/**
 * The page contract (decision 0036, section 9): the template file and component parameter schemas, the template
 * reader, and the page composer. The server validates a product's templates with it; the wiki app composes a page with
 * the same module, so one page shape has one implementation.
 */
export * from './schema.js';
export * from './template.js';
export * from './compose.js';
