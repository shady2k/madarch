# 0037. Diagrams: rendered on the server in three engines, laid out once into the graph, by flow, lanes and one order

Status: proposed
Date: 2026-11-14

Builds on 0001 (the graph is the product), 0033 (one of everything), 0034 (one graph schema;
every value an opinion), 0035 (extraction plugins), 0036 (one page mechanism; the diagram
component). Agreed with the owner on 2026-11-14 in the coordinator session; to be built after the
page foundation of madarch-64o5.71 is in use. Task: madarch-64o5.75.

## Context and problem

madarch draws its architecture and relation diagrams with three engines it keeps: Mermaid,
LikeC4 and archify (`vendor/archify`, v3.0.1). The same pictures are needed in three places: the
wiki, where they must be interactive; answers to clients and agents over HTTP and MCP; and
documents such as a README or an artifact sent to GitHub, which renders Mermaid only. A layout
that merely avoids overlaps does not make a diagram readable: the reader must see what comes from
what. The owner's words:

- «все диаграммы должны быть на сервере. Мы же потом будем эти картинки отдавать клиентам по
  запросу.»
- «А диаграммы при этом должны быть интерактивными.» — and archify is interactive by itself.
- «Mermaid нужно отдавать кодом, не рендерить его фактически. А вот остальные, Archify и LikeC4,
  мы можем их отдавать тоже в виде кода?»
- «чтобы диаграммы … хорошо бы показывали текущее состояние, чтобы по диаграмме было все понятно,
  чтобы не было пересечений.» A colleague used archify with a genetic algorithm to place the
  elements: «Мне кажется, здесь он идеально подходит.»
- «саму раскладку элементов по диаграмме можно делать один раз и записывать её в граф … только
  если диаграмма изменилась.»
- «Просто сделать так, чтобы элементы не пересекались … не решает главную проблему — визуальность,
  наглядность и согласованность. … гейтвей, потом сервисы … логично их рисовать слева направо по
  мере их использования.»

## Decision

1. **One place builds a diagram: the server.** It reads the diagram's content from the graph in
   one snapshot (focus entity, depth, an edge and its inverse merged, a kind's neighbours above
   `aggregateAbove` folded into one node with the count) and renders it. The wiki, HTTP clients
   and MCP receive the same answers; the browser only makes an answer interactive.
2. **Engines and forms.** One route and one MCP tool take the engine and the form:

   | engine | `source` | `interactive` | `svg` / `png` |
   |---|---|---|---|
   | Mermaid | the Mermaid text (GitHub and the wiki draw it) | the wiki draws the text | not produced: documents embed the text |
   | LikeC4 | the LikeC4 DSL with the stored layout | the computed view and LikeC4's interactive component | exported by the server |
   | archify | archify's JSON document | archify's self-contained interactive HTML (pan, zoom, hover, a node's passport with links to its entity page) | taken from the server's own rendering |

   Every node links to its entity's page `/e/<kind>/<id>`. `vendor/archify` stays byte-identical
   to upstream.
3. **The layout is an entity of the graph.** A layout plugin writes it as its opinion: keyed by
   the focus, the depth, the aggregation and the language (labels set the node sizes), holding the
   content digest of the diagram's nodes and edges, the node positions and the edge routes, with
   the algorithm and its parameters as evidence. A diagram whose digest matches reads its stored
   layout; a changed digest is laid out again starting from the previous layout, so one new node
   does not reshuffle the picture. An agent's correction through MCP is another opinion beside it.
   LikeC4 and archify draw from the same stored positions; Mermaid lays itself out.
4. **Readability rules, in this order of weight:**
   - **Flow.** Relations that carry work (calls, publishes, reads, writes) point left to right; a
     node's column is its place on the request path from the entry points. A relation drawn
     against the flow is a defect of the layout.
   - **Lanes.** Rows by role: clients and entry, services, asynchronous channels, data, external.
     A kind is always in its lane.
   - **One order for the whole system.** The left-to-right order is computed once for the system
     and stored in the graph; every diagram takes its part of it, so two elements keep their
     relative place on every diagram that shows both.
   - **Groups.** Elements of one container or domain stay together in a frame.
   - Then no overlaps and as few crossings as the graph allows, then short edges and few bends.
5. **The meaning comes from the catalogue, not from code.** A kind declares its lane; a relation
   kind declares whether it carries flow and in which direction. A new kind or relation finds its
   place without an engine change.
6. **Layout algorithm.** A layered start (ELK, the Sugiyama method with orthogonal routing) on the
   flow columns and lanes, refined by a genetic algorithm whose fitness is rule 4's weighted sum,
   with a fixed seed so the same content gives the same bytes. Chosen by a prototype measured on
   madarch's own diagrams: share of relations along the flow, lane violations, agreement of order
   across diagrams, crossings, overlaps and time, against LikeC4's own layout.

## Consequences

- Diagrams look the same in the wiki, in an agent's answer and in a document.
- Layout costs once per content change; a slow, careful algorithm is affordable.
- The catalogue gains `lane` on kinds and `flow` on relation kinds; the starter kinds need them.
- Not decided here: the visual style (colours per kind, legend), sequence and data-flow diagrams.
