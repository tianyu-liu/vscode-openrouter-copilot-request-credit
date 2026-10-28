# OpenRouter brand assets

The OpenRouter name and marks belong to OpenRouter, Inc. The extension is an independent integration;
use of the mark does not imply endorsement. These assets are excluded from this repository's MIT license.

Bundled official sources:

- [Ink glyph](https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-ink.svg)
  ([local copy](media/glyph-ink.svg)), `#03080A`, for light themes.
- [Cloud glyph](https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-cloud.svg)
  ([local copy](media/glyph-cloud.svg)), `#FCFCFE`, for dark themes.

The [brand page](https://openrouter.ai/brand/) offers the marks as “ready to use” and instructs:
“Please don’t stretch, recolor, or remix the marks.” Checked 2026-10-28. The page and downloadable logo
archive do not provide a separate open-source license. [Terms of Service, section 12](https://openrouter.ai/terms)
reserve ownership and rights except where expressly authorized by OpenRouter. The public brand guidance
is the basis for this identifying use; it is not an MIT or other open-source license grant for the logos.

VS Code's status bar accepts icon fonts rather than SVG/PNG image paths. [openrouter-icons.woff](media/openrouter-icons.woff)
encodes the original cubic paths at their original aspect ratio, with COLR/CPAL palettes preserving both
official colors. The extension switches glyphs immediately when the light/dark theme changes, including
the corresponding high-contrast themes. No remote assets are loaded at runtime.

To regenerate the checked-in font, install `fonttools` in a Python environment and run
`python scripts/build-status-icons.py`. Normal TypeScript builds and packaging need no Python tooling.
