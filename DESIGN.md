---
name: Tricot
description: A calm, live board where a person and their agents make decisions together.
colors:
  bg: "#f6f6f4"
  surface: "#ffffff"
  surface-2: "#efefec"
  border: "#e5e5e1"
  border-strong: "#d0d0cb"
  text: "#1a1a18"
  muted: "#5c5c57"
  faint: "#6d6d67"
  primary: "#1a1a18"
  primary-text: "#ffffff"
  focus: "#2c58b8"
  danger: "#b03a26"
  danger-bg: "#fbe7e2"
  open: "#d08c12"
  open-bg: "#fbf1dc"
  open-ink: "#8a5a0c"
  exploring: "#3b6fd6"
  exploring-bg: "#e7eefb"
  exploring-ink: "#2c58b8"
  provisional: "#7a4fc9"
  provisional-bg: "#efe9fb"
  provisional-ink: "#6440b0"
  decided: "#2f8a57"
  decided-bg: "#e2f2e8"
  decided-ink: "#1f6e43"
  deferred: "#9a9a93"
  deferred-bg: "#efefec"
  deferred-ink: "#62625c"
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
  card-decision:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "12px 14px 10px"
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
  tag-blocking:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "1px 6px"
  tag-recommended:
    backgroundColor: "{colors.open-bg}"
    textColor: "{colors.open-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "1px 6px"
  tag-chosen:
    backgroundColor: "{colors.decided-bg}"
    textColor: "{colors.decided-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "1px 6px"
  tag-agent:
    backgroundColor: "{colors.provisional-bg}"
    textColor: "{colors.provisional-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "1px 6px"
  option-letter:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    size: "18px"
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

Tricot is a room you can leave running. Decisions, tasks, and agents are always live, but the room stays quiet: the chrome is plain neutral grey and white, and colour shows up only where something has a status or needs you. You should be able to glance at a board from across the desk and know what is waiting on you, what agents are exploring, and what is settled, without reading a word.

Quiet does not mean cold. The voice is plain, friendly, and human: sentence-case headings, everyday words ("Needs you", "Decide for now", "Still holds"), people shown as tinted circles with their initial, and agents as neutral squares beside them. Density is moderate: cards and panels have room to breathe, but a board with a dozen decisions still fits on one screen.

This system grew out of a deliberate pass to strip AI-generated habits from the UI: no coloured side stripes, no uppercase eyebrow labels, no unicode glyphs standing in for icons, no monospace as decoration, no glow halos. Those stay out.

**Key Characteristics:**
- Neutral paper-grey page, white sheets, hairline borders; near-black ink for text and the primary action.
- Five status colours (amber, blue, violet, green, stone), each in three strengths: marker, tint, ink.
- Two attention signals only: blue for "new since you looked", amber for "needs you".
- The platform's own sans-serif at four sizes and three weights; mono only for code and commands.
- Flat surfaces with borders; shadows only on things that float.
- One drawn icon family on a 16px grid with a 1.5 stroke.
- Light and dark themes are equal citizens; every rule holds in both.

## Colors

A plain neutral ground with five status colours used as signals, never as decoration. Values above are the light theme (`src/web/themes/light.css`); each other theme, dark among them, is a file beside it that redefines every token under `:root[data-theme='<id>']` and a line in `src/web/themes/registry.ts`.

### Primary
- **Ink** (`primary`, same as `text`): the primary action (*Decide*, *Create board*, *Post*), headings, body text, and the selected-option ring. The UI's only "brand colour" is ink on paper.

### Status
- **Waiting Amber** (`open`, `open-bg`, `open-ink`): open decisions and lanes, and everything that "needs you": the inbox badge, the needs-you card wash, stale tasks, recommended options.
- **Exploring Blue** (`exploring`, `exploring-bg`, `exploring-ink`): decisions where agents are gathering evidence. The canvas connection line uses it too.
- **Provisional Violet** (`provisional`, `provisional-bg`, `provisional-ink`): proceed-but-cheap-to-change decisions, and the *agent's call* tag.
- **Decided Green** (`decided`, `decided-bg`, `decided-ink`): binding decisions, the chosen option, ticked task boxes, the live indicator, and the "+" on pros.
- **Deferred Stone** (`deferred`, `deferred-bg`, `deferred-ink`): parked decisions; a warm grey so it reads as status without competing.
- **Signal Red** (`danger`, `danger-bg`): blocking questions, errors, and the "−" on cons.

### Neutral
- **Paper** (`bg`): the page and the canvas floor.
- **Sheet** (`surface`): cards, panels, top bar, canvas blocks, inputs.
- **Sunk Sheet** (`surface-2`): hover fills, tab track, code, option letters, table headers.
- **Hairline** (`border`) and **Firm Hairline** (`border-strong`): every in-page edge; the firm one for inputs, buttons, hover, and dashed "add" affordances.
- **Muted Ink** (`muted`) and **Faint Ink** (`faint`): secondary text and meta (timestamps, counts, hints). Faint is the lightest text allowed and still meets 4.5:1.
- **Focus Blue** (`focus`): keyboard focus rings, text selection, and "new since you looked" dots and badges.

### Named Rules
**The Meaning-Only Rule.** Colour appears only where it carries a status or an attention signal. Chrome, headings, and controls stay neutral.

**The Three Strengths Rule.** Every status colour comes as a marker (squares, icons, edges), a tint (backgrounds), and an ink (text). Text on a tint always uses the ink, never the marker; the marker alone fails contrast.

**The Two Signals Rule.** Blue means "changed since you looked"; amber means "waiting on you". Never swap them or introduce a third attention colour.

## Typography

**Body Font:** the platform UI sans-serif (`ui-sans-serif`, SF Pro on macOS, Segoe UI on Windows, then Inter, Roboto, sans-serif)
**Mono Font:** `ui-monospace` (SF Mono, Menlo, Consolas)

**Character:** The system's own face, used plainly. It reads as a native tool rather than a branded product, which keeps attention on the decisions. Hierarchy comes from size and weight steps, never from case or tracking tricks.

### Hierarchy
- **Display** (600, 28px, 1.2, -0.02em): the home page headline only.
- **Headline** (600, 20px): single-purpose screens such as the name gate.
- **Title** (600, 16px, 1.35): the board name and the open decision's question in the top bar.
- **Heading** (600, 14px): section headings in panels (*Context*, *Options*, *Discussion*), lane titles, card questions. Home panel headings step up to 15px.
- **Body** (400, 14px, 1.5): default text, buttons (at 500), inputs, decision context, and note text on the canvas. Goals and prose cap at about 72ch.
- **Body small** (400, 13px, 1.45): option lists on cards, activity, findings, comments, other canvas blocks' content.
- **Label** (500, 12px): counts, meta lines, small buttons' secondary text, actor names.
- **Caption** (500, 11px): tags, option letters, block kinds, tab counts.
- **Code** (400, mono, about 12px or 0.88em inline): MCP commands, ids, links, Mermaid source.

### Rendered Markdown
Notes, a decision's context, a task's detail and comments share one reading system (`.md` in `styles.css`), sized in em of the text around it so a 14px note and a 13px comment keep the same proportions.
- **Reading:** notes and panel sections read at 1.6 line height; paragraphs are 0.75em apart, and a line that leads into a list, table or code sits closer to it. Prose stops at about 75 characters (34em) however wide the block; tables, code and pictures may use the full width.
- **Headings:** the roles above, in em: h1 is the Headline (20px in a note), h2 the Title (16px), h3 the Heading (14px), h4 13px; all 600, ink, balanced. The space above a heading is three to five times the space below it. Under a panel's own section heading they stop at 15px; in comments, findings and thread messages they stay at the text's size.
- **Lists:** bullets in faint ink, numbers in muted; items 0.3em apart. A task list's box hangs in the margin on the first line, so long items and the items under them line up with its words; a done item turns muted, not struck through.
- **Quiet details:** strong is 600; links keep the ink with a thin underline at 40% that darkens on hover (blue stays the "new" signal); inline code and code blocks sit on the sunk sheet at the code size; a quote is muted text with a 2px firm-hairline rule, neutral, the quote's mark rather than a status stripe; a rule is one hairline; a picture fits the width with a hairline edge.
- **Tables:** 13px in a note with tabular figures, hairline grid, sunk-sheet header row; each column keeps at least 6em, and past that the table scrolls in its own box rather than crushing.

### Named Rules
**The Sentence Case Rule.** Every heading, label, tag, and button is sentence case at normal tracking. No uppercase eyebrows above headings, ever.

**The Three Weights Rule.** 400 for reading, 500 for controls and labels, 600 for headings and emphasis. Nothing else.

**The Mono Is For Code Rule.** Monospace marks things you could paste: commands, ids, paths, source. Names, numbers, and letters use the sans with tabular figures.

## Layout

The app has three working layouts, all with a 24px side gutter on desktop and 16px below 900px.

- **Home:** a centred column (max 1080px) with the boards list beside a 340px side column for *New board* and *Connect an agent*, separated by a 32px gap; 48px top padding.
- **Board:** a top bar, a one-line attention bar (*Needs you* plus counts and the view tabs), then status lanes as equal columns (min 250px, 14px gap) that scroll sideways. An optional 300px activity rail sits on the right.
- **Decision and task view:** the canvas fills the room; the structured panel is fixed at 440px on the right, with a sticky action footer.

Spacing follows a 4px base (4, 6, 8, 12, 16, 24, 32, 48). Tight groups (a card's meta row, an option's head) use 6–8px; separate groups (sections in a panel) use 20–24px.

Below 900px everything stacks into one column: lanes run vertically, the activity rail moves under the board, the canvas takes 70vh with the decision panel beneath it, and the top bar wraps.

## Elevation & Depth

Depth is borders-first. Everything that sits in the page (cards, panels, options, tables, comments, the top bar) is a flat white sheet with a 1px hairline on the paper ground. Shadows are reserved for layers that float over other content: the connect popover, the inbox panel, the canvas toolbar, canvas blocks, node toolbars, and link labels. Hover deepens a border (`border` to `border-strong`) rather than lifting the element.

### Shadow Vocabulary
- **Hairline lift** (`--shadow-sm`: `0 1px 2px` at 5%): small floating chips such as link labels and the active tab thumb.
- **Float** (`--shadow`: `0 1px 2px` + `0 4px 12px`, 5–6%): canvas blocks, the canvas toolbar, node toolbars, error toasts.
- **Overlay** (`--shadow-lg`: `0 12px 32px` at 14%): popovers and the inbox panel.

### Named Rules
**The Borders First Rule.** In-page surfaces are flat with a hairline border. If it doesn't float above other content, it doesn't get a shadow.

**The No Halo Rule.** Shadows always have an offset and a blur. A zero-offset coloured ring is allowed only as a functional state (selection, a highlighted canvas block), never as a glow.

## Shapes

Soft but not round: corners are gently curved and nest concentrically, so an inner element is always tighter than its container.

- **4px** (`rounded.xs`): tags, option letters, pins, agent marks, inline code.
- **6px** (`rounded.sm`): buttons, inputs, tabs, small toolbars, relation chips.
- **10px** (`rounded.md`): cards, panels, options, canvas blocks, comments, banners.
- **14px** (`rounded.lg`): canvas groups and the name-gate card, which hold 10px children.
- **Full**: human avatars (circles), link labels on the canvas, the user chip, and the inbox count badge.

Status is drawn as a **2px-rounded square** (7–8px), echoing the four-square brand mark. It is the only status shape: lanes, counts, status labels, relation chips.

### Named Rules
**The No Stripes Rule.** No coloured left or right borders on cards, chips, callouts, or list items. Status is a square marker or a tint, never a stripe.

## Components

Plain, friendly, quiet controls: they look like the platform's own, and only the primary action is solid.

### Buttons
- **Shape:** gently curved (6px), 1px border, inline icon with a 6px gap.
- **Primary:** solid ink with white text (7px 14px). One per area: *Decide*, *Create board*, *Post*. Hover drops to 88% opacity.
- **Secondary:** white sheet, firm hairline, ink text; hover fills with sunk sheet.
- **Quiet:** no fill or border, muted text; hover fills with sunk sheet and darkens to ink. Used for *Defer*, *Reopen*, *Hide activity*, *Back*.
- **Small:** 4px 10px at 13px, same variants.
- **Disabled:** primary turns into a sunk sheet with faint text; others drop to 45% opacity.
- **Focus:** 2px focus-blue outline, 1px offset, on every interactive element.

### Status markers and counts
- **Style:** an 8px square marker in the status colour, followed by neutral text ("2 open", "1 to confirm"). Blocking counts and stale counts switch their text to the danger or amber ink.
- **Status label:** the same marker with 13px/500 text in ink, used beside a decision number.

### Meters
- **Style:** a 6px bar with 2px corners: the sunk sheet as its track, filled in muted ink, with its words beside it in muted text and tabular figures ("26% used · resets in 1h 26m"). Used for an agent's plan usage in its panel.
- **Near a limit:** from 80% the fill takes the amber marker and the words the amber ink, as anything that needs you; from 95% the danger red. Below that a meter stays neutral, whatever it measures.

### Tags
- **Style:** 11px/500 sentence-case text on a status tint with its ink, 4px corners, 1px 6px padding (*blocking*, *recommended*, *chosen*, *agent's call*, *stale*). Icons inside tags use the same ink.

### Cards / Containers
- **Decision card:** white sheet, hairline border, 10px corners, 12px 14px padding. Meta row (number, tags, creator), the question in heading weight, then options or the chosen answer, then a faint footer. Hover deepens the border. A card changed by someone else flashes a lane-colour wash that settles over 1.8s; a card waiting on you takes a soft amber wash.
- **Panel:** white sheet, hairline, 10px corners, 20px padding, 14px internal gap.
- **Banner:** a status tint with ink text, 10px corners, 12px 14px padding; used for the decision's current state.

### Inputs / Fields
- **Style:** white sheet, firm hairline, 6px corners, 8px 10px padding, inherited 14px type; placeholders in faint ink.
- **Focus:** 2px focus-blue outline.
- **Error:** a 13px danger-coloured line under the field naming the problem.

### Navigation
- **Top bar:** white, hairline bottom border, brand mark or back button on the left; live indicator, inbox, theme toggle, and user chip on the right.
- **Tabs:** a sunk-sheet track holding text tabs; the active tab is a white thumb with a hairline lift. Counts sit in faint caption type.

### Option card (signature)
The heart of a decision. A selectable radio card: option letter chip, label in heading weight, tags, description, pros (+ in green ink) and cons (− in red), plus findings. Selected: ink border with a 1px ink ring and an inverted letter chip. Chosen: decided-green border. Nothing is preselected, not even the recommendation.

### Canvas block (signature)
A floating white block on the dotted paper canvas: a header row (faint block kind, title, pin chip, author mark) over a scrollable body. Selected: ink ring. Highlighted from a hovered option: an amber ring. New since you looked: blue-tinted border and a small *new* badge.

### Icons
One family, drawn inline as SVG on a 16px grid with a 1.5 stroke, round caps and joins, sized at 1em. Current set: arrows, plus, x, check, bell, star (filled), partly, sun, moon.

## Do's and Don'ts

### Do:
- **Do** use the status marker square for status everywhere, and the tint with its ink for tags and banners.
- **Do** keep chrome neutral; let colour mean status or attention only.
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
- **Don't** add shadows to in-page surfaces, or glow halos to anything.
- **Don't** put status-marker colours directly on text; use the matching ink.
- **Don't** preselect or visually push the recommended option.
