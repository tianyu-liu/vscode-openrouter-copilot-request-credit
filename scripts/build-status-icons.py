"""Build the bundled status-bar font. Requires fonttools; normal builds use the checked-in WOFF."""

from pathlib import Path
import xml.etree.ElementTree as ET

from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path


def main():
    media = Path(__file__).resolve().parent.parent / "media"
    glyphs = {".notdef": None}
    colors = []
    for variant in ("ink", "cloud"):
        svg = ET.parse(media / f"glyph-{variant}.svg").getroot()
        path = svg.find("{http://www.w3.org/2000/svg}path")
        if path is None or svg.attrib["viewBox"] != "0 0 1024 730":
            raise ValueError(f"Unexpected {variant} SVG geometry")
        glyphs[variant] = path.attrib["d"]
        color = path.attrib["fill"].removeprefix("#")
        colors.append(tuple(int(color[i:i + 2], 16) / 255 for i in (0, 2, 4)) + (1.0,))

    font = FontBuilder(1024, isTTF=False)
    font.setupGlyphOrder(list(glyphs))
    font.setupCharacterMap({0xE001: "ink", 0xE002: "cloud"})
    outlines = {}
    for name, path in glyphs.items():
        pen = T2CharStringPen(1024, None)
        if path:
            # Uniform scale; center the original 1024 x 730 shape in a square em.
            parse_path(path, TransformPen(pen, (1, 0, 0, -1, 0, 749)))
        outlines[name] = pen.getCharString()

    font.setupCFF("OpenRouterRC", {"FullName": "OpenRouter RC", "FamilyName": "OpenRouter RC"}, outlines, {})
    font.setupHorizontalMetrics({name: (1024, 0) for name in glyphs})
    font.setupHorizontalHeader(ascent=896, descent=-128)
    font.setupNameTable({
        "familyName": "OpenRouter RC",
        "styleName": "Regular",
        "uniqueFontIdentifier": "OpenRouter RC status icons",
        "fullName": "OpenRouter RC",
        "psName": "OpenRouterRC",
        "version": "Version 1.0",
        "copyright": "OpenRouter marks belong to OpenRouter, Inc. See THIRD_PARTY_NOTICES.md.",
        "licenseInfoURL": "https://openrouter.ai/brand/",
    })
    font.setupOS2(sTypoAscender=896, sTypoDescender=-128, usWinAscent=896, usWinDescent=128)
    font.setupPost()
    # Fixed brand colors survive VS Code's foreground styling; no recoloring of the mark.
    font.font["COLR"] = buildCOLR({"ink": [("ink", 0)], "cloud": [("cloud", 1)]}, version=0)
    font.font["CPAL"] = buildCPAL([colors])
    font.font.recalcTimestamp = False
    font.font["head"].created = font.font["head"].modified = 2082844800
    font.font.flavor = "woff"
    font.save(media / "openrouter-icons.woff")


if __name__ == "__main__":
    main()
