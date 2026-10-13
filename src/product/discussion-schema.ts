import { Type, type Static } from 'typebox';

/** ULIDs use Crockford's base32 alphabet and the 48-bit time prefix. */
export const ULID_PATTERN = '^[0-7][0-9A-HJKMNP-TV-Z]{25}$';
const Ulid = Type.String({ pattern: ULID_PATTERN, minLength: 26, maxLength: 26 });

const PageAnchor = Type.Object({ kind: Type.Literal('page') }, { additionalProperties: false });
const SelectionAnchor = Type.Object({
  kind: Type.Literal('selection'),
  quote: Type.String({ minLength: 1 }),
  before: Type.String({ maxLength: 32, description: 'Up to 32 Unicode code points immediately before the selected quote.' }),
  after: Type.String({ maxLength: 32, description: 'Up to 32 Unicode code points immediately after the selected quote.' }),
}, { additionalProperties: false });

/** The versioned metadata shared by one comment message Markdown file. */
export const DiscussionMessage = Type.Object({
  contract: Type.Literal(1, { description: 'The discussion-message contract version; this schema publishes version 1.' }),
  author: Type.String({ minLength: 1 }),
  time: Type.String({ minLength: 1, description: 'The message creation time in ISO 8601 form.' }),
  thread: Ulid,
  anchor: Type.Union([PageAnchor, SelectionAnchor]),
  document: Type.String({ pattern: '^docs/(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))(?:[^/]+/)*[^/]+\\.md$', description: 'A product-relative Markdown document path under docs/, without dot-segment traversal.' }),
  sourceCommit: Type.String({ pattern: '^[0-9a-f]{40}$', description: 'The 40-character source commit hash.' }),
  status: Type.Union([Type.Literal('open'), Type.Literal('resolved')]),
}, {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/shady2k/madarch/schema/v1/product-discussion-message.schema.json',
  title: 'Madarch product discussion message',
  description: 'One Markdown message under comments/<thread ULID>/<message ULID>.md. Its front matter is versioned independently of generic product document fields.',
  additionalProperties: false,
});
export type DiscussionMessage = Static<typeof DiscussionMessage>;
export const DISCUSSION_MESSAGE_SCHEMA_ID = 'https://github.com/shady2k/madarch/schema/v1/product-discussion-message.schema.json';
