Critique the proposed page against only the supplied source-backed claims, registry entry, and code map. Return only JSON matching this shape, with no markdown fencing, no commentary and no fields beyond these:

{"findings":["<one concrete finding, a plain string>"]}

Example answer:

{"findings":["segments[1] cites source src-1a2b3c4d5e6f7081 that no named claim covers"]}

Each finding is one plain string naming the concrete problem and where it sits. Flag unsupported prose segments, missing source links, facts presented as assumptions or assumptions presented as facts, and missing registered kind coverage. An empty findings list means accepted. Do not rewrite the page.
