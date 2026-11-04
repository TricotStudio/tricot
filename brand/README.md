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
| Ink | `#1a1a18` | The mark on light backgrounds (the light theme's text) |
| Paper | `#f6f6f4` | The light background (the light theme's page) |
| Light ink | `#ececea` | The mark on dark backgrounds (the dark theme's text) |
| Night | `#121211` | The dark background (the dark theme's page) |

## Please don't

- Stretch, squash or rotate the mark. It is already turned 45 degrees.
- Colour it in anything but the two inks, or put the dark ink on a dark background or the light ink on a light one.
- Add shadows, outlines, gradients, glows or other effects.
- Redraw it: make the threads thicker or thinner, square off their ends, or lose the over and under where they cross.
