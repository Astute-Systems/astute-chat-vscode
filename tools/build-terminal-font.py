#!/usr/bin/env python3
"""Builds Astute Vector Mono, the terminal font, from upstream Orbitron.

Terminals place text on a fixed grid, and Orbitron is proportional, so every cell
would be as wide as a W. This fits each glyph to one cell instead.

Orbitron is a Reserved Font Name, so this modified version must not use that name.

Needs fontTools. To rebuild, download the source and run:

  curl -L -o Orbitron.ttf "https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/orbitron/Orbitron%5Bwght%5D.ttf"
  python3 tools/build-terminal-font.py Orbitron.ttf media/fonts
"""
import os
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FAMILY = "Astute Vector Mono"
SLUG = "AstuteVectorMono"
CELL = 700
PAD = 50
NOTE = "Modified from Orbitron by Astute Systems: glyphs are fitted to one cell for terminals, and a caret is added."


def fit(font, name, glyph_set):
    """Centres a glyph in the cell, narrowing it only if it doesn't fit."""
    bounds = BoundsPen(glyph_set)
    glyph_set[name].draw(bounds)
    pen = TTGlyphPen(None)
    if bounds.bounds:
        left, _, right, _ = bounds.bounds
        width = right - left
        scale = min(1, (CELL - 2 * PAD) / width) if width else 1
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recording)
        recording.replay(TransformPen(pen, (scale, 0, 0, 1, (CELL - width * scale) / 2 - left * scale, 0)))
    return pen.glyph()


def caret(stroke):
    """Orbitron has no ^, which terminals show often, as in ^C and HEAD^."""
    pen = TTGlyphPen(None)
    left, right, top, bottom, middle = 130, CELL - 130, 720, 430, CELL / 2
    pen.moveTo((left, bottom))
    pen.lineTo((middle - stroke / 2, top))
    pen.lineTo((middle + stroke / 2, top))
    pen.lineTo((right, bottom))
    pen.lineTo((right - stroke, bottom))
    pen.lineTo((middle, top - stroke))
    pen.lineTo((left + stroke, bottom))
    pen.closePath()
    return pen.glyph()


def build(source, weight, style, output):
    font = instancer.instantiateVariableFont(TTFont(source), {"wght": weight})
    font.recalcTimestamp = False
    glyph_set = font.getGlyphSet()
    glyphs = {name: fit(font, name, glyph_set) for name in font.getGlyphOrder()}
    glyf = font["glyf"]
    for name, glyph in glyphs.items():
        glyf[name] = glyph

    font.setGlyphOrder(font.getGlyphOrder() + ["asciicircum"])
    glyf.glyphOrder = font.getGlyphOrder()
    glyf["asciicircum"] = caret(130 if weight >= 700 else 80)
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[0x5E] = "asciicircum"

    for name in font.getGlyphOrder():
        glyph = glyf[name]
        glyph.recalcBounds(glyf)
        font["hmtx"][name] = (CELL, glyph.xMin if glyph.numberOfContours else 0)

    for table in ("GPOS", "GSUB", "GDEF", "kern", "DSIG", "STAT", "HVAR", "MVAR", "avar", "gasp", "prep", "fpgm", "cvt "):
        if table in font:
            del font[table]
    font["post"].isFixedPitch = 1
    font["OS/2"].panose.bProportion = 9
    font["OS/2"].xAvgCharWidth = CELL
    font["OS/2"].usWeightClass = weight
    font["hhea"].advanceWidthMax = CELL

    names = font["name"]
    names.names = [record for record in names.names if record.nameID in (0, 5, 13, 14)]
    for name_id, value in {1: FAMILY, 2: style, 3: f"{FAMILY} {style}", 4: f"{FAMILY} {style}", 6: f"{SLUG}-{style}", 10: NOTE}.items():
        names.setName(value, name_id, 3, 1, 0x409)
        names.setName(value, name_id, 1, 0, 0)
    font.save(output)


def main():
    source, folder = sys.argv[1], sys.argv[2]
    for weight, style in ((400, "Regular"), (700, "Bold")):
        output = os.path.join(folder, f"{SLUG}-{style}.ttf")
        build(source, weight, style, output)
        font = TTFont(output)
        widths = {width for width, _ in font["hmtx"].metrics.values()}
        missing = [chr(code) for code in range(0x20, 0x7F) if code not in font.getBestCmap()]
        family = font["name"].getDebugName(1)
        if widths != {CELL} or missing or "Orbitron" in family:
            sys.exit(f"{output} is wrong: widths {widths}, missing {missing}, family {family}")
        print(output, len(font.getGlyphOrder()), "glyphs", os.path.getsize(output), "bytes")


if __name__ == "__main__":
    main()
