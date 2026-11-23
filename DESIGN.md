---
name: Tricot
description: A calm, live board where a person and their agents work through canvases, threads and files.
colors:
  bg: "#edeae4"
  surface: "#f8f6f2"
  surface-2: "#e4e0d8"
  border: "#dcd7ce"
  border-strong: "#ccc6bc"
  text: "#1d1828"
  muted: "#5d5866"
  faint: "#65606d"
  primary: "#1d1828"
  primary-text: "#ffffff"
  focus: "#2c58b8"
  danger: "#a3392c"
  danger-bg: "#f6d9d3"
  open: "#d08c12"
  open-bg: "#f4e6c7"
  open-ink: "#7a580a"
  exploring: "#3b6fd6"
  exploring-bg: "#dde3f1"
  exploring-ink: "#2c55ad"
  provisional: "#7a4fc9"
  provisional-bg: "#e5ddf3"
  provisional-ink: "#5a37c8"
  decided: "#2f8a57"
  decided-bg: "#e0eadd"
  decided-ink: "#2b693d"
  deferred: "#9a9a93"
  deferred-bg: "#e4e5e5"
  deferred-ink: "#4a5764"
  yarn-violet: "#b8a2f4"
  yarn-violet-deep: "#5a37c8"
  yarn-coral: "#f2968a"
  yarn-coral-deep: "#a3392c"
  yarn-marigold: "#ecbf63"
  yarn-marigold-deep: "#7a580a"
  yarn-sky: "#9fb8ef"
  yarn-sky-deep: "#2c55ad"
  yarn-sage: "#a7cfad"
  yarn-sage-deep: "#2b693d"
  yarn-fog: "#b4bdc6"
  yarn-fog-deep: "#4a5764"
typography:
  display:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  button:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.45
  code:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
  full: "999px"
spacing:
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  page: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-text}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
  button-primary-disabled:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.faint}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
  button-quiet-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  button-small:
    rounded: "{rounded.sm}"
    padding: "4px 10px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "20px"
  tab-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "3px 12px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "3px 12px"
  canvas-block:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
  canvas-note:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
---

# Design System: Tricot

## Overview

**Creative North Star: "The Quiet Control Room"**

Tricot is a room you can leave running. Agents are always live, but the room stays quiet: the chrome is warm paper and a violet-black ink in light, a neutral near-black in dark, and colour shows up only where something has a status or needs you. You should be able to glance at a board from across the desk and know which agents are listening, what changed since you looked, and what is waiting on you, without reading a word.

Quiet does not mean cold. The voice is plain, friendly, and human: sentence-case headings, everyday words ("Pages", "New thread", "Ask Claude about this page…"), people shown as tinted circles with their initial, and agents as neutral squares beside them. Density is moderate: blocks and panels have room to breathe, but a Sketchbook page with a dozen blocks still fits on one screen.

This system grew out of a deliberate pass to strip AI-generated habits from the UI: no coloured side stripes, no uppercase eyebrow labels, no unicode glyphs standing in for icons, no monospace as decoration, no glow halos. Those stay out.

**Key Characteristics:**
- In light, a warm paper page (undyed wool), lighter sheets, warm hairline borders, and a violet-black ink for text and the primary action. In dark, a neutral near-black with a light grey ink.
- Five status colours (amber, blue, violet, green, stone), each in three strengths: marker, tint, ink.
- Two attention signals only: blue for "new since you looked", amber for "needs you".
- The platform's own sans-serif at four sizes and three weights; mono only for code and commands.
- Flat surfaces with borders; shadows only on things that float.
- One drawn icon family on a 16px grid with a 1.5 stroke.
- Light and dark themes are equal citizens; every rule holds in both.

## Colors

A quiet, warm ground with five status colours used as signals, never as decoration. Values above are the light theme (`src/web/themes/light.css`); each other theme, dark among them, is a file beside it that redefines every token under `:root[data-theme='<id>']` and a line in `src/web/themes/registry.ts`.

The light theme's ground and ink come from Tricot's palette, made first for the website (its version 3): an undyed-wool paper and a violet-black ink. The app takes the palette's paper, panel, ink, muted and rule colours, and adds the steps between them it needs. The warm paper and the violet-black ink are the light theme's alone: dark mode is a neutral near-black, with no warm or violet tint. The statuses take their tints and text from the yarns (below), in both themes; their markers keep their own, stronger colours, since a yarn is too faint for a small square or dot. `brand/README.md` lists the whole palette.

### Primary
- **Ink** (`primary`, same as `text`): the primary action (*Create board*), headings, body text, and the selection ring. The UI's only "brand colour" is ink on paper.

### Status
The tokens keep the names of the statuses they were first drawn for. The board uses each for what it shows now:
- **Waiting Amber** (`open`, `open-bg`, `open-ink`): everything that is waiting on you or about to run out: an agent's request for permission, a connection that needs signing in again, an agent that is working or not checking, a meter near its limit.
- **Exploring Blue** (`exploring`, `exploring-bg`, `exploring-ink`): the canvas's own accent: the connection line between blocks, the undo toast, what a drop will add, a diff's hunk header, and a paired piece that changed.
- **Provisional Violet** (`provisional`, `provisional-bg`, `provisional-ink`): the Legal lens's chip, and the keyword tint in diffs and code.
- **Decided Green** (`decided`, `decided-bg`, `decided-ink`): an agent that is listening, a switch that is on, a line a diff adds, ticked boxes in a note's task list, and a request that is done.
- **Deferred Stone** (`deferred`, `deferred-bg`, `deferred-ink`): the General lens's chip and a connection at rest; a warm grey marker with fog's tint and text, so it reads as status without competing.

Each status's tint (`-bg`) is its yarn mixed into the sheet (`surface`): 30% in light, 9% in dark, where a stronger mix would take the faint ink under 4.5:1. Its ink (`-ink`) is the yarn's deep colour in light and the yarn itself in dark. Open takes marigold, exploring sky, provisional violet, decided sage and deferred fog. Every ink keeps 4.5:1 on its tint, the sheet and the sunk sheet. The markers (`open`, `exploring`…) are not yarns: they stay the stronger colours above.
- **Signal Red** (`danger`, `danger-bg`): errors, delete buttons, a connection that is broken, and the lines a diff removes. From coral: the red is coral's deep in light and the coral yarn in dark, both text and marker, and its tint is coral mixed into the sheet like the status tints. A delete button fills with it and takes `primary-text` (white in light, the near-black in dark).
- **Where work stands** (`status-to-do`, `status-in-progress`, `status-in-review`, `status-blocked`, `status-done`, each with its `-bg` and `-ink`, in `styles/base.css`): one map from where a piece of work stands to the colours above, which Home's Work and yarn read and so does every card a part lists there. To do is stone (hollow for what is set aside for later), in progress blue, in review violet, blocked red and done green. A thread takes the status nearest its own: at work is in progress, waiting on you is in review, not started is to do. Its square and strand take the status's colour, and the words that say it waits on you keep the amber.

### Neutral
- **Paper** (`bg`): the page and the canvas floor. The palette's paper in light; a neutral near-black in dark.
- **Sheet** (`surface`): panels, top bar, canvas blocks, inputs. A lighter warm sheet in light; a neutral step above the page in dark.
- **Sunk Sheet** (`surface-2`): hover fills, tab track, code, table headers. The palette's panel in light; a neutral step above the sheet in dark.
- **Hairline** (`border`) and **Firm Hairline** (`border-strong`): every in-page edge; the firm one for inputs, buttons, hover, and dashed "add" affordances. The firm one is the palette's rule in light.
- **Muted Ink** (`muted`) and **Faint Ink** (`faint`): secondary text and meta (timestamps, counts, hints). Faint is the lightest text allowed and still meets 4.5:1.
- **Focus Blue** (`focus`): keyboard focus rings, text selection, and "new since you looked" dots and badges.

### Brand palette: the yarns
Six soft yarns, each a status hue chalked down, are the brand's accents: for the website, pictures and other brand work, and in the app only as the statuses' tints and text, never its controls. Each has a deep version for text on light grounds; on the near-black text takes the yarn itself, and text on a yarn fill takes the ink in both.
- **Violet** (`yarn-violet`, `yarn-violet-deep`): the brand, and the Legal lens.
- **Coral** (`yarn-coral`, `yarn-coral-deep`): people.
- **Marigold** (`yarn-marigold`, `yarn-marigold-deep`): the amber.
- **Sky** (`yarn-sky`, `yarn-sky-deep`): the blue.
- **Sage** (`yarn-sage`, `yarn-sage-deep`): the green.
- **Fog** (`yarn-fog`, `yarn-fog-deep`): the stone, and agents at rest.

### Named Rules
**The Meaning-Only Rule.** Colour appears only where it carries a status or an attention signal. Chrome, headings, and controls stay paper and ink.

**The Three Strengths Rule.** Every status colour comes as a marker (squares, icons, edges), a tint (backgrounds), and an ink (text). Text on a tint always uses the ink, never the marker; the marker alone fails contrast.

**The Two Signals Rule.** Blue means "changed since you looked"; amber means "waiting on you". Never swap them or introduce a third attention colour.

## Typography

**Body Font:** the platform UI sans-serif (`ui-sans-serif`, SF Pro on macOS, Segoe UI on Windows, then Inter, Roboto, sans-serif)
**Mono Font:** `ui-monospace` (SF Mono, Menlo, Consolas)

**Character:** The system's own face, used plainly. It reads as a native tool rather than a branded product, which keeps attention on the work. Hierarchy comes from size and weight steps, never from case or tracking tricks.

### Hierarchy
- **Display** (600, 28px, 1.2, -0.02em): the Projects page's headline only.
- **Headline** (600, 20px): single-purpose screens such as the name gate.
- **Title** (600, 16px, 1.35): the board name in the top bar.
- **Heading** (600, 14px): section headings in panels and thread titles. Projects panel headings step up to 15px.
- **Body** (400, 14px, 1.5): default text, buttons (at 500), inputs, and note text on the canvas. Goals and prose cap at about 72ch.
- **Body small** (400, 13px, 1.45): comments, other canvas blocks' content.
- **Conversation** (400, 15px, 1.6, a measure of about 70 characters): thread messages, wherever a conversation is drawn (Home, a thread opened there, the thread panel). The viewer's own messages are compact bubbles on the right (the sunk sheet, 14px corners with the one at the foot of the tail at 4px, 15px at 1.5) with no name, their time under the last of a turn; an agent's reply is prose on the left under its mark and name, its first paragraph at 500; another person's reads on the left under their name, as an agent's does. A turn's messages sit 6px apart, turns 24px.
- **Label** (500, 12px): counts, meta lines, small buttons' secondary text, actor names.
- **Caption** (500, 11px): tags, block kinds, tab counts.
- **Code** (400, mono, about 12px or 0.88em inline): MCP commands, ids, links, Mermaid source.

### Rendered Markdown
Notes and comments share one reading system (`.md` in `styles.css`), sized in em of the text around it so a 14px note and a 13px comment keep the same proportions.
- **Reading:** notes and panel sections read at 1.6 line height; paragraphs are 0.75em apart, and a line that leads into a list, table or code sits closer to it. Prose fills what holds it (a note as wide as it was made, a panel, a comment, a file's preview) and stops only on a very wide space, at about 120 characters (54em), so a line never runs the width of a large screen; tables, code and pictures may use the full width.
- **Headings:** the roles above, in em: h1 is the Headline (20px in a note), h2 the Title (16px), h3 the Heading (14px), h4 13px; all 600, ink, balanced. The space above a heading is three to five times the space below it. Under a panel's own section heading they stop at 15px; in comments and thread messages they stay at the text's size.
- **Lists:** bullets in faint ink, numbers in muted; items 0.3em apart. A task list's box hangs in the margin on the first line, so long items and the items under them line up with its words; a done item turns muted, not struck through.
- **Quiet details:** strong is 600; links keep the ink with a thin underline at 40% that darkens on hover (blue stays the "new" signal); inline code and code blocks sit on the sunk sheet at the code size; a quote is muted text with a 2px firm-hairline rule, neutral, the quote's mark rather than a status stripe; a rule is one hairline; a picture fits the width with a hairline edge.
- **Tables:** 13px in a note with tabular figures, hairline grid, sunk-sheet header row; each column keeps at least 6em, and past that the table scrolls in its own box rather than crushing.

### Named Rules
**The Sentence Case Rule.** Every heading, label, tag, and button is sentence case at normal tracking. No uppercase eyebrows above headings, ever.

**The Three Weights Rule.** 400 for reading, 500 for controls and labels, 600 for headings and emphasis. Nothing else.

**The Mono Is For Code Rule.** Monospace marks things you could paste: commands, ids, paths, source. Names, numbers, and letters use the sans with tabular figures.

## Layout

The app has three working layouts, all with a 24px side gutter on desktop and 16px below 900px.

- **Projects:** a centred column (max 1080px) with the projects list and, at its foot, how to connect an agent; 48px top padding.
- **Board:** a top bar, then the view tabs (the Sketchbook, and the project's Files as a quiet folder before them), and the page's canvas filling the room beneath.
- **Thread panel:** a thread opens in a panel at the right of the canvas, up to 440px (40% of the window at most), with the chat bar at its foot. Its "← Threads" turns the whole panel into the threads list (the conversation as one row, then the work), a page of its own rather than a popover over the thread; a row turns it back.

Spacing follows a 4px base (4, 6, 8, 12, 16, 24, 32, 48). Tight groups (a block's header row, a message's byline) use 6–8px; separate groups (sections in a panel) use 20–24px.

Below 900px the threads list fills the width above the chat bar and the top bar wraps.

## Elevation & Depth

Depth is borders-first. Everything that sits in the page (panels, tables, comments, the top bar) is a flat sheet with a 1px hairline on the paper ground. Shadows are reserved for layers that float over other content: the connect popover, the threads list, the canvas toolbar, canvas blocks, node toolbars, and link labels. Hover deepens a border (`border` to `border-strong`) rather than lifting the element.

### Shadow Vocabulary
- **Hairline lift** (`--shadow-sm`: `0 1px 2px` at 5%): small floating chips such as link labels and the active tab thumb.
- **Float** (`--shadow`: `0 1px 2px` + `0 4px 12px`, 5–6%): canvas blocks, the canvas toolbar, node toolbars, error toasts, and Home's sheet and its bar, which lie over the cloth.
- **Overlay** (`--shadow-lg`: `0 12px 32px` at 14%): popovers and the threads list.

### Named Rules
**The Borders First Rule.** In-page surfaces are flat with a hairline border. If it doesn't float above other content, it doesn't get a shadow.

**The No Halo Rule.** Shadows always have an offset and a blur. A zero-offset coloured ring is allowed only as a functional state (selection, a highlighted canvas block), never as a glow.

## Shapes

Soft but not round: corners are gently curved and nest concentrically, so an inner element is always tighter than its container.

- **4px** (`rounded.xs`): tags, pins, agent marks, inline code.
- **6px** (`rounded.sm`): buttons, inputs, tabs, small toolbars, relation chips.
- **10px** (`rounded.md`): panels, canvas blocks, comments, banners.
- **14px** (`rounded.lg`): canvas groups and the name-gate card, which hold 10px children.
- **Full**: human avatars (circles), link labels on the canvas, the user chip, and count badges.

Status is drawn as a **2px-rounded square** (7–8px), echoing the four-square brand mark. It is the only status shape: agent states, counts, status labels, relation chips.

### Named Rules
**The No Stripes Rule.** No coloured left or right borders on cards, chips, callouts, or list items. Status is a square marker or a tint, never a stripe.

## Components

Plain, friendly, quiet controls: they look like the platform's own, and only the primary action is solid.

### Buttons
- **Shape:** gently curved (6px), 1px border, inline icon with a 6px gap.
- **Primary:** solid ink with white text (7px 14px). One per area: *Create board*. Hover drops to 88% opacity.
- **Secondary:** sheet, firm hairline, ink text; hover fills with sunk sheet.
- **Quiet:** no fill or border, muted text; hover fills with sunk sheet and darkens to ink. Used for *Back* and *Cancel*.
- **Small:** 4px 10px at 13px, same variants.
- **Disabled:** primary turns into a sunk sheet with faint text; others drop to 45% opacity.
- **Focus:** 2px focus-blue outline, 1px offset, on every interactive element.

### Status markers and counts
- **Style:** an 8px square marker in the status colour, followed by neutral text ("2 threads", "1 waiting on you"). A count that waits on you or that failed switches its text to the amber or danger ink.
- **Status label:** the same marker with 13px/500 text in ink, used for an agent's state (*listening*, *working*).

### Meters
- **Style:** a 6px bar with 2px corners: the sunk sheet as its track, filled in muted ink, with its words beside it in muted text and tabular figures ("26% used · resets in 1h 26m"). Used for an agent's plan usage in its panel.
- **Near a limit:** from 80% the fill takes the amber marker and the words the amber ink, as anything that needs you; from 95% the danger red. Below that a meter stays neutral, whatever it measures.

### Tags
- **Style:** 11px/500 sentence-case text on a status tint with its ink, 4px corners, 1px 6px padding (a diff's *new* and *renamed*, a lens). Icons inside tags use the same ink.

### Cards / Containers
- **Panel:** sheet, hairline, 10px corners, 20px padding, 14px internal gap.
- **Banner:** a status tint with ink text, 10px corners, 12px 14px padding; used for a notice about the board, such as that it is archived.

### Inputs / Fields
- **Style:** sheet, firm hairline, 6px corners, 8px 10px padding, inherited 14px type; placeholders in faint ink.
- **Focus:** 2px focus-blue outline.
- **Error:** a 13px danger-coloured line under the field naming the problem.

### Navigation
- **Top bar:** sheet, hairline bottom border, brand mark or back button on the left; live indicator, search, notification bell, and user chip on the right.
- **Tabs:** a sunk-sheet track holding text tabs; the active tab is a sheet thumb with a hairline lift. Counts sit in faint caption type.
- **The chat bar's threads button:** the ball of yarn drawn small, with the count of work waiting on you, at the floating bar's left end on every view but Home, whose own bar has none as its ball tops the yarn. Between them it is a quiet handoff, nothing crossing the screen. Going to Home, the small ball folds into the bar and the field closes over its place, in one sweep with the drawing tools when coming from a Sketchbook page; meanwhile Home's big ball fades in at the top of the yarn, with a hint of a turn settling just past and back, and the whole yarn arrives with it, drawn down from the ball through what is in view: the strands under the ball, then the conversation's strand and every thread's with their knit-offs, knots, stitches and the time along them, its count knotted on last, in about half a second. Leaving Home for a view with the floating bar, the small ball's place opens and the ball rises in, settling just past and back, while the big ball leaves with Home. Its place opens or closes in the drawing tools' motion and in step with them. Nothing moves on a page opening, from or to a docked bar, or into a thread open on Home. With reduced motion it is there or not at once.

### Pin chip (signature)
A small chip at the foot of a block that names the part pinned and counts its comments: a blue tint with its ink, 4px corners. Clicking it opens the thread; hovering shows an ✕ that unpins it.

### Canvas block (signature)
A floating sheet on the canvas's cloth, Home's knitted ground knitted on the canvas so it pans and zooms with the blocks (`src/web/canvas/cloth.tsx`): Home's 10 by 8px stitch at zoom 1, growing to twice that by zoom 2; zoomed out it is knitted larger at each halving and zoomed in past 2 smaller, so its stitch stays about 8 to 13px wide below zoom 1 and at most about 25px above, the next size fading in over the middle of each halving. The block: a header row (faint block kind, title, pin chip, author mark) over a scrollable body. Selected: ink ring. New since you looked: blue-tinted border and a small *new* badge.

### What a message made (pictures of its blocks)
Under the message that made them, blocks show as pictures of themselves (`src/web/threads/threadWork.tsx`, `src/web/canvas/blocks/preview.tsx`): tiles of the canvas block's sheet (`surface`, a hairline, 10px corners), each a 16:10 frame over the block's name, in a quiet 12px line under a hairline. Each kind draws its own picture (its `Preview`): a picture fills the frame when it is near the frame's shape and shows whole when it is much taller or wider; a note's first lines and a table's first rows at 11 to 11.5px, fading out at the frame's foot (and a wide table at its right edge); a diagram or a chart drawn small and whole; code from its highlighted lines, in their tint; a diff's totals and files; a link's mark, title and site. Nothing in a picture is live: it is drawn inside a link, takes no pointer or focus, and is drawn only once it comes near the screen. As many sit side by side as the message has room for, at least 150px each and three at most (one in a phone's column, two in the thread panel, three on Home), none wider than 240px (320px alone) and the row no wider than the prose above it; under them, quietly, the page they are on when they share one, and *+N more*, which unfolds the rest into rows (*Show fewer* folds them). Pointing at one deepens its border and its name's ink. A block of a kind with no picture, a removed one and a comment stay the one-line cards they were.

### Shapes and drawings
What people sketch on a canvas: a rectangle (the canvas's 10px corners), an ellipse or a diamond, a text label, a free arrow, a pen's strokes. Each is drawn whole, with no sheet, header or shadow of a block; selected, a 1px ink ring 4px out from its edge. Their colours are the content palette, the chart's series (gray, blue, orange, green, yellow, pink, violet, red): a line in the colour, thin, medium or thick (1.5, 3 or 5px), and a 16% tint of it on the sheet, gray being ink alone. A label's words are S, M or L and may be bold (700); a pen's strokes are 2, 4 or 8px. Content colour, not status: a red shape means what its author meant, nothing more. The tools sit in a capsule of their own on the floating chat bar's left, shown only while a canvas that can be drawn on is: Select, Shape (with a corner mark that it holds more), Text, Pen. The capsule has the bar's height, sheet, 14px corners and lift, with an 8px gap between them, so drawing and talking read as two jobs on one baseline, and the pair is as wide as the bar alone. The capsule comes and goes with that canvas in motion, to and from every view (Home's own bar too, which stands where the floating bar does), as the bar does when it docks: the bar draws back from the left as the capsule slides out from under it and settles, its tools rising in one after another; leaving, the tools fold away from the bar's side one after another, then the bar closes over the capsule, slow to start and quickening, and lands just past its place and back (on a phone the capsule drops in behind the bar). With reduced motion it is there or not at once. On a window 600px wide or less the capsule sits 8px above the bar's right end, as the field would have no room beside it, clear of the canvas's zoom controls on the left. While a tool with options is on (a shape, the arrow, Text or the Pen; not Select), a tray of the capsule's sheet with 12px corners rises 8px over the capsule from its left end (its right end on a phone) with that tool's options, used for what it draws next and kept for each tool in the browser: the palette as 16px dots, ringed in ink when picked, then after a hairline rule the tool's own as the tools' round buttons, filled when picked (a shape's three lines, a label's S, M and L and B, the pen's three widths as dots); the arrow takes no colour and has its three lines alone, drawn 1.5, 3 or 5px with a head a little larger as the line is heavier, as a link has no colour and a free arrow is coloured once drawn. It rises in and sinks away with the tool, another tool's row comes up in its place, and it makes way while the Shape menu is open. A selected shape or drawing offers the same in its toolbar. What is being drawn shows dashed in exploring blue, the canvas's own accent; a pen's stroke in its colour and width. An arrow dragged over a block it would link to rings that block in exploring blue, 2px and 4px out; let go anywhere else, it is a free arrow: a link's line and head across its box, in its colour or a link's muted ink when gray, its words on a chip of the sheet halfway along, and only its line (14px wide to the pointer) and words take hold of it until it is selected, so what lies under its box can still be clicked.

### Work under way (following a coordinator)
When a coordinator hands work out (`src/core/roles.ts`), the person follows it without hunting. **The dock follows**: while it shows the thread they asked in, it moves to the thread their message went to, with a quiet "← Back to …" crumb above the title; anywhere else, a chip in the exploring tint over the chat bar says "Sent to … · Follow", with its own ×. **A row of pills** sits just over the floating bar, centred and in the bar's own sheet, one per thread an agent owns whose work isn't done: those waiting on the person first, in the open status's tint and saying *needs you*; the rest with a dot that pulses in the open colour while the owner or its subagents have a live step there. Done threads leave the row. In a thread's head, the owner's chip names it and where its work stands (neutral at work, open tint waiting, decided tint done); the coordinator's word under a message ("Open “…” →") links to where it went. The row takes no pointer itself, so the canvas between pills stays reachable, and the pulse stops for reduced motion.

### The answer peeking over the bar
A quick question asked from the floating bar stays in the board's conversation, so the dock opens no thread for it: its answer **peeks over the bar** (`src/web/threads/askPeek.tsx`), a compact card in the threads list's sheet (hairline border, the bar's 14px corners, the overlay lift), as wide as the bar and stacked over the row of pills. Its head says where the exchange lives, *In the conversation · asked on Checkout flow*, after a small swatch of the conversation's plied strand (warp and weft in diagonal bands, as on its row in the threads list), with *Open on Home →* and a quiet ✕. Under it the exchange reads as every conversation does, a size smaller: the ask's bubble with the line that says the agent is on it, then the answer as prose, scrolling inside the card past about 420px. Sent on, the coordinator's word links to where it went; taken on as work, a quiet foot on the sunk sheet says so, with *Open →*. It rises 8px from the bar as it comes, and stays still for reduced motion.

### Relays (what the work needs of the person, in Home's conversation)
When work a coordinator handed out needs the person, Home's conversation brings it to them, so they can stay there (`src/web/threads/relays.ts`, `relayCard.tsx`). Only three moments are relayed: an agent's question to them, a thread's work done with its summary, and a card a part says is blocked. **A relay is a card from its thread, never the coordinator speaking**: no author's badge, led by the thread's name, which opens it, its border in the colour of where the thread stands (`--status-*`) rather than a stripe, and its strand stitched into its left edge on the yarn. Its size follows how much it needs them: a question in full, up to six lines, with *Reply* and *Open thread*; blocked in two lines; done in one. **Reply aims the one bar** at the thread for a single message: the bar's chip with a reply arrow and the thread's name, *Answer Claude in this thread…*, and a ring in the thread's colour on the card and the bar; sending, Esc or the chip's ✕ lets go. Answered, there or in the thread, the card folds onto the paper as one line: where the thread stands now, unless it is done, which the thread's own card says, and *You answered: “…”*. What came while they were away is one card under *Since you were last here*: what needs them first, then what was answered, then what was done, a line each, and *Reply* on a row opens it in place.

### Home's cloth and sheet
A board's Home is one knitted piece in three surfaces (`src/web/threads/timeline.css`, `src/web/styles/cloth.css`). **The cloth** is its ground: the paper (`bg`) knitted over in a breath of the ink (`knit-ink`: 3% in light, 2.2% in dark, where light ink shows more), a small stockinette stitch (columns of V's, 10 by 8px) you see when you look for it, drawn as a mask so the token colours it, and never behind text. **The sheet** lies on it: one sheet of paper (`surface`) with a hairline, 14px top corners, the Float shadow and the theme's top highlight, holding the conversation's head, its messages and the bar at its foot, and running on past the window's foot. The conversation's own strand runs down its left edge as its selvedge, the ball on its top corner where the strand starts and the head level with the ball; the threads' strands knit off into the sheet, and the times sit just outside on the cloth. Cards on the sheet are pieces of it a step in (22% of the sunk sheet into the sheet), outlined, and inside it the paper behind what Home paints over (a strand's second ply, the ring round the ball's count) is the sheet. The sheet is centred in the room Work leaves, as it is with the yarn three lanes wide, so the column stands still whatever the yarn holds and the cloth either side is even; on a narrower window it keeps the times' room at the left and the column narrows. **Work** is docked at the right, the whole height of Home, flush to the edge and the tabs' rule, on its own flat tint (80% of the sunk sheet into the paper), its edge a hairline; its head is level with the conversation's, and a row lit there is a touch of ink. **A day**, and where the viewer was last here, is a band of stitches across the column, two rows of a finer V in columns of the conversation's violet and coral (where the viewer was last here, in the focus blue), fading out at the column's edges, as tall as the line it replaced, with its name in 12px semibold. A thread open on Home lies on the same sheet: its head is the sheet's top band, ruled off across it, with *Conversation* as a quiet line over the title, both on the column's edge.

### Work, folding and unfolding
Work, on the right of a board's Home, is docked there the whole height of Home and folds into a slim rail, docked the same, and unfolds from it again, and it moves in the dock's family, at the dock's pace and on its curves (`src/web/threads/workMotion.ts`, `timeline.css`). **Unfolding**, Work grows out of its rail: the rail widens to the left, as the bar docks; the rail's count and word fade as it sets off, and the panel's head, then its groups one after another, rise in as it lands, as the tools rise in their capsule. **Folding**, by its button or Esc, the groups fold away first, from the foot up, the head last; then the panel closes back into the rail, slow to start and quickening, and lands just past its place and back, as the bar closes over the tools, the rail's count and word rising in as it lands. The rail's button and the panel's are drawn at the same place, so the button stays still through both, under the pointer that pressed it. Work's tint and edge keep their size while it changes width, the panel uncovered rather than stretched, and inside it only pictures move. The conversation moves over with it, at its pace and on its curve, as the room Work leaves changes: on a frame only the main pane's margin changes, and its column keeps its width where the window has room, so no line in it is broken anew. Below 900px, where Work sits under the conversation, and in a browser without view transitions, the panel uncovers itself from the rail with its head and groups rising the same, and folds at once when they have gone. With reduced motion it is open or folded at once, and a visit finds it as it was left, still.

### Time along the yarn
Home's yarn carries time in the viewer's own clock, in words of its own drawing at the left of the conversation's strand, where nothing else is drawn (`src/web/threads/yarn.tsx`): when things happened, never how long ago. **The hour** sits by the stitch of the first message said in it, once where the hour turns: *3 PM* where the clock runs to twelve, *15:00* elsewhere, as the rows' clock says it. A day's first message has its own, under the day's divider, which stays as it is. Messages hours apart get one mark, the later hour, never a ladder of empty hours; messages minutes apart get none, as each message's head already says its time; a mark closer than 28px to the last is left out, and so is one whose hour a thread's time at its message or just above already says. **When a thread's work was done** sits beside its knot, to the minute (*9:01 PM*). The knot is tied in the day it was done, before the next day's divider, so the dividers say its day; one whose rows around it are of another day says its day too (*Sat 9:01 PM*). **When a thread started** sits beside where it knits off, to the minute, even while it waits to be taken on (when it was sent on), with its day where the message it knits off at is of another; a strand that started before what is shown has none, its lane running in from the top. Pointing at the strand says when its work ran, with its day where it is not today: *done · 8:40 – 9:01 PM (21m)*, the length quiet in brackets; for work not done, *needs you · started 8:40 PM*; not started, *not started · since 8:40 PM*. The yarn's times are captions (11px, 500, tabular figures) whose period (*PM*) is a size smaller after a thin space, ending 11px left of the strand's centre so they read as one column: the hours in faint ink, as a message's time is, and a thread's times in its strand's ink (blue at work, violet needing you, stone not started, green done), as its knot is green. Each keeps 14px clear of the others, a knot's first, then a start's. On a window too narrow to centre the sheet, the conversation keeps 28px on the yarn's left for them (`--yarn-room`). They sit on the cloth outside the sheet, each with a halo of the cloth's colour that clears the stitches under it, scroll with the yarn and pass out of sight under the band the strands unwind over at the top, as the strands do: nothing is pinned. A thread's times fade with its strand when another is lit; the hours stay. A thread open on Home has none, as its messages say how long ago rather than the hour.

### Home's conversation in the terminal
The chat in the Tricot tab of `tricot claude` is Home's conversation, drawn in a terminal's terms (`src/cli/switcher/homeView.ts`): what was said under who said it and the time in the person's clock, a rule with the day between days and an alert-coloured one at *Since you were last here*; under an ask sent on, an indented card line (↳ the thread's title, *sent on to Claude*, then a square and where its work stands, the title giving way first); a relay led by a square in where its thread stands and the thread's name in bold, its words dim but for *Claude asks you*, in the alert colour, and the question in full under it; what came while they were away under one bold head, by group, a line each. **The yarn is a narrow column at the left**: the conversation's strand in a dim line with a stitch (•) at each message, and a lane a column each for the threads agents own, two columns apart, in the status colour of where each stands (24-bit where the terminal draws it, the nearest of the 256 elsewhere), which knits off at the card (├─╮, under any lane between), stitches into its relays and is tied off with a knot (●) in the done colour. A stream under sixty columns, or with more lanes than a quarter of it holds, keeps one column of marks instead (├╴ at a knit, • at a relay, ● at a knot); a terminal that draws no colour (`NO_COLOR`) draws it all in ASCII, each lane's character saying where its work stands (| ! :), and the squares go, the words saying it. No tints and no stripes: the squares and the strands carry status, as on the page.

### The peek (what an agent is working on)
"Working" alone leaves the person blind, so what an agent is doing shows without asking: under each agent in the header's live card, right away, its plan, what it and its helpers are doing and the files it changed, in the peek's sections set tighter, the card at its full width. Where an agent's work is one line, that line opens the peek: the line under a message an agent is at (its words become a quiet button, dotted underline on hover), and the pill of a thread at work over the chat bar (a waiting pill still opens its thread). It is a card in the popover sheet, 380px wide, over its opener, or under it when there is more room there, never off the screen. From the top: who and for how long, with an *at work* chip carrying the live dot while a step is live; **its plan** as a checklist with a thin bar in the decided colour (done items struck and faint, the one being done bold inside an open-colour ring, the next ones plain, a window of eight around the current one); **right now**, a line each for the agent and its helpers, each helper's kind in an exploring-tint chip and the agent's own in a neutral one, or **lately**, its last steps, when none is live; and at the foot the files it changed this turn and Open thread. It changes nothing, closes on a click away or Escape, and says why it is empty (no live steps from that agent yet) rather than showing nothing. The pills of threads at work show the plan's count beside their title (*2/5*).

### Icons
One family, drawn inline as SVG on a 16px grid with a 1.5 stroke, round caps and joins, sized at 1em. The set is `ICONS` in `src/web/shared/components.tsx`.

## Editing and asking an agent

One way to work on a thing, yourself or with an agent, everywhere it can be done. The Files view (`src/web/files/`) is the first to follow it in full.

1. **Reading is the default.** A thing opens as it reads: drawn where the board can draw it (a Markdown file, a diagram, a table), else as its text.
2. **Edit where it is shown.** Double-click a thing to edit it; a double-click on a drawing opens its source at what was double-clicked. A text source is edited in place, with no Edit mode to switch to. A shape's words, too: a double-click opens them, and a shape just drawn opens them at once.
3. **Typing is kept.** Esc leaves editing and keeps what was typed; throwing it away is an explicit *Discard*. A one-line rename is the exception: Esc puts the old name back. A file on disk stays unsaved, marked *Edited* (with the amber dot) until ⌘S saves it.
4. **An agent works on a part.** Select it and ask: *Ask <agent>*, or *Comment* for people. A view has one *Pair* button, which opens already paired with the agent it offers.
5. **A person's edit never silently overwrites a newer version.** Saving checks the version it was typed on; if it changed, a band says so and offers *Keep mine*, *Copy mine, then take theirs* or *Take theirs*.

Where the page doesn't follow it yet, to bring in line:
- On the canvas, Esc cancels a long edit (a note, a diagram, a scene) instead of keeping it.
- A double-click on an image's picture or a website's preview opens it instead of editing it; a code block's path is edited with a single click.
- In a block's full view, pointing at a part asks only once Pair is on; the Google Doc editor and the canvas ask without it.
- Four prompts ask about a part, each with its own words: `PinPrompt`, `PairAskPrompt`, `SiteAskPrompt` and `DocAskPrompt` (*Comment* or *Add a note*).
- The reading mode of a full view is *Read*, *View* or *Browse*, by kind.

## Do's and Don'ts

### Do:
- **Do** use the status marker square for status everywhere, and the tint with its ink for tags and banners.
- **Do** keep chrome to paper and ink; let colour mean status or attention only.
- **Do** use blue for "new since you looked" and amber for "needs you", nothing else.
- **Do** write headings and labels in sentence case, in plain words.
- **Do** keep to 400/500/600 weights and the type sizes above, with tabular figures for numbers.
- **Do** draw new icons in the existing SVG family (16px grid, 1.5 stroke) in `src/web/shared/components.tsx`.
- **Do** check every new surface in both light and dark themes against WCAG 2.2 AA, with visible keyboard focus.
- **Do** honour `prefers-reduced-motion`; keep transitions to 0.12s colour and border changes.

### Don't:
- **Don't** put coloured stripes on the sides of cards, chips, or callouts.
- **Don't** use uppercase, letter-spaced eyebrow labels above headings.
- **Don't** use unicode glyphs or emoji as icons (✦ ★ → ← ×).
- **Don't** use monospace for names, numbers, or letters; it is for code.
- **Don't** add shadows to in-page surfaces (Home's sheet, laid over its cloth, is the one that lifts), or glow halos to anything.
- **Don't** put status-marker colours directly on text; use the matching ink.
