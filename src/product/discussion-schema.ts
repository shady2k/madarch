import { Type, type Static } from 'typebox';

/** ULIDs use Crockford's base32 alphabet and the 48-bit time prefix. */
export const ULID_PATTERN = '^[0-7][0-9A-HJKMNP-TV-Z]{25}$';
const Ulid = Type.String({ pattern: ULID_PATTERN, minLength: 26, maxLength: 26 });

/** Portable syntax guard: JSON Schema format is annotation-only unless a consumer enables assertions. */
export const ISO_DATE_TIME_PATTERN = '^(?:[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)-02-29)[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:(?:[0-5][0-9]|60)(?:\\.[0-9]+)?(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])(?![\\s\\S])';

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
  time: Type.String({ pattern: ISO_DATE_TIME_PATTERN, format: 'date-time', description: 'The message creation time in ISO 8601 date-time form with an explicit UTC offset.' }),
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
