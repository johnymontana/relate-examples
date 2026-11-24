# Example 03 draws the memory with NVL, in Relate's brand

Status: accepted · Decided: 2026-11-24 (03's D5, D9; N1–N6) · Scope: example 03

Example 03 replaces a playground whose problem was that it looked like a graph database's console.
Two decisions answer that, and they are separate: what draws the graph, and what the page looks
like.

**The graph is drawn with NVL 2.0.0**, as in examples 01 and 02 (bundled the same way, shipped with
Neo4j's permission: ADR-0009). The repository owner asked for it. `web/graph.js` turns the page's
two needs into NVL calls:

- **Grow with the conversation.** After each tool call NVL is given the difference between the
  store and what it holds, so new nodes join a layout that is already running.
- **Show how a memory was reached.** Every element on a path the reply used is `selected`, in the
  order the path was walked; what the other returned paths touch is left as it is; everything else
  is `disabled`.

An entity is a large node carrying its name. A memory is a smaller node between the entities it is
about, carrying its gist. NVL writes a caption inside its node (N1), so both are sized to hold
their text. Every relationship carries its type. The layout is `d3Force`: NVL's default spreads a
graph this small so widely that fitting it to the panel shrinks the captions away (N2). The camera
is the page's own: NVL's `fit` leaves a small graph in half the panel, and at half size again on a
high-density screen (N3, N6).

**The page looks like Relate, not like a database console.** It uses the Relate brand kit v1.0
(D9): navy, cyan, lime, blue and forest; Public Sans and IBM Plex Mono; the supplied logo, favicon
and mascot. NVL takes its colours from the same palette, read from the page's CSS, so the graph
changes with the theme.

## Considered options

- **A renderer written for the page** (SVG, with its own force layout). It was built first. It
  drew a memory as a labelled pill, animated a path with running dashes, and put every element in
  the DOM for the tests to read. It was replaced because the repository's examples draw graphs with
  NVL, and a playground for Relate should show the library its users will reach for.
- **NVL's default `forceDirected` layout**: rejected for this graph size (N2).

## Consequences

- NVL draws to a canvas, so a test cannot ask the DOM which elements are lit. The browser section
  reads NVL's own state back instead (`getNodes`, `getRelationships`: which elements it holds, which
  are selected, which disabled) and checks it against the store and the returned paths (N4). It
  checks what NVL was told, not what it painted.
- A gist longer than a few words is cut to fit its node, and the full text is in the tooltip, the
  inspector and the list.
- NVL is proprietary: its notices ship under `assets/nvl-2.0.0/`, and `THIRD_PARTY.md` and
  `site.json` record the permission. The brand's typefaces are open (SIL OFL 1.1) and ship with
  their licences. The logo, favicon and mascot are Relate's trademarks, supplied by the repository
  owner and used as the brand kit's rules say.
