# Tricot's mark

The mark is a woven lattice turned onto the diagonal: two threads each way, over and under where they cross, with a small square at its heart. The files here are made from the drawing the app itself uses, so they match it exactly. `npm run brand` remakes every file in this folder from the app's source (`scripts/brand-assets.mjs`), so change the source, not the files.

The mark is Tricot Studio's, like the name. Tricot's licence covers the code, not them.

## Which file to use

The mark comes in two inks. The files ending `on-light` carry the dark ink, for light backgrounds; the ones ending `on-dark` carry the light ink, for dark backgrounds. Their backgrounds are transparent.

- **The mark:** `tricot-mark-on-light.svg` and `tricot-mark-on-dark.svg`. Use the SVG wherever you can.
- **PNGs of it,** in `png/`: `tricot-mark-on-light-*.png` and `tricot-mark-on-dark-*.png`, at 64, 128, 256, 512 and 1024px.
- **Profile pictures:** `png/tricot-avatar-light-*.png` and `png/tricot-avatar-dark-*.png`, the mark on a square of the theme's background, at 512 and 1024px, for GitHub, npm, Slack and the like. Their corners are square because each of those sites rounds or circles the picture itself, and the mark stays clear of a circle crop.
- **A website's icons:** `favicon.svg` (the mark, which turns light when the browser is dark), `favicon.ico` (16, 32 and 48px, for browsers that don't read SVG), `apple-touch-icon.png` (180px), and `icon-192.png` and `icon-512.png` for a web app manifest. The square icons are the dark tile, which holds up on light and dark home screens.

  ```html
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  ```

## Space and size

Every file already leaves a margin of an eighth of the mark's height around it. Around that, keep clear at least as much again, so nothing comes closer to the mark than a quarter of its height.

The mark holds up down to 16px, as a favicon. Don't use it any smaller.

## Colours

| Colour | Hex | Use |
| --- | --- | --- |
| Ink | `#1d1828` | The mark on light backgrounds (the light theme's text). A violet-black. |
| Paper | `#edeae4` | The light background (the light theme's page). Undyed wool. |
| Light ink | `#ececea` | The mark on dark backgrounds (the dark theme's text) |
| Night | `#121211` | The dark background (the dark theme's page). A neutral near-black. |

## Palette

The mark's colours belong to a wider palette, first made for the website (its version 3) and now Tricot's own. The warm paper and the violet-black ink are the light theme's. Dark mode is a neutral near-black, with no warm or violet tint. The app's themes use the palette's paper, panel, ink, muted and rule colours, with a few steps between them ([DESIGN.md](../DESIGN.md)).

Beside the paper and the ink, each ground has a panel, a muted ink for secondary text and a rule for lines:

| Colour | Light | Dark |
| --- | --- | --- |
| Panel | `#e4e0d8` | `#1a1a19` |
| Muted | `#5d5866` | `#a6a6a0` |
| Rule | `#ccc6bc` | `#42423e` |

Then six yarns: soft fills for the website, pictures and other brand work. Each comes from one of Tricot's status colours, chalked down. A yarn fill is too light for text on the paper, so text in a yarn's colour takes its deep version on light grounds and the yarn itself on dark ones. Text on a yarn fill takes the ink, `#1d1828`, in both.

| Yarn | Fill | Deep | For |
| --- | --- | --- | --- |
| Violet | `#b8a2f4` | `#5a37c8` | The brand, and provisional decisions |
| Coral | `#f2968a` | `#a3392c` | People, and the danger red |
| Marigold | `#ecbf63` | `#7a580a` | Open decisions |
| Sky | `#9fb8ef` | `#2c55ad` | Exploring |
| Sage | `#a7cfad` | `#2b693d` | Decided |
| Fog | `#b4bdc6` | `#4a5764` | Deferred, and agents at rest |

In the app, the statuses take their tints and text from the yarns, in both themes: a status's tint is its yarn mixed into the sheet (30% in light, 9% in dark), and its text is the yarn's deep colour in light and the yarn itself in dark. Their markers, the small squares, dots and icons, keep the app's stronger status colours, since a yarn fill is too faint for them. The danger red comes from coral the same way: coral's deep in light, the coral yarn in dark, and coral mixed into the sheet for its tint. Otherwise the yarns stay out of the app's controls: there, colour means a status.

## Please don't

- Stretch, squash or rotate the mark. It is already turned 45 degrees.
- Colour it in anything but the two inks, or put the dark ink on a dark background or the light ink on a light one.
- Add shadows, outlines, gradients, glows or other effects.
- Redraw it: make the threads thicker or thinner, square off their ends, or lose the over and under where they cross.
