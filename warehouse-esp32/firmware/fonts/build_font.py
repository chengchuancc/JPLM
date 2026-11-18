#!/usr/bin/env python3
"""Build the firmware's RGB565-compatible 4-bit glyph masks from Noto Sans SC."""

import argparse
import struct
import unicodedata
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageFont


def rasterize(font, character):
    mask, (x, y) = font.getmask2(character, mode="L", anchor="ls")
    advance = round(font.getlength(character))
    if not all(mask.size):
        return 0, 0, advance, 0, 0, b""
    image = Image.frombytes("L", mask.size, bytes(mask))
    box = image.getbbox()
    if box is None:
        return 0, 0, advance, 0, 0, b""
    image = image.crop(box)
    grey = [(value + 8) // 17 for value in image.tobytes()]
    if len(grey) % 2:
        grey.append(0)
    bitmap = bytes(high << 4 | low for high, low in zip(grey[::2], grey[1::2]))
    return image.width, image.height, advance, x + box[0], y + box[1], bitmap


def build(source):
    with TTFont(source, lazy=True) as font:
        supported = sorted(
            code for code in font.getBestCmap()
            if code >= 32 and unicodedata.category(chr(code)) not in {"Cc", "Cf", "Cn", "Cs"}
        )
    numeric = list(range(32, 127))
    faces = [(16, 700, supported), (20, 750, numeric), (26, 750, numeric)]
    tables = bytearray()
    bitmap = bytearray()
    header = bytearray()
    glyph_size = struct.calcsize("<IIBBBbb3x")
    header_size = len(faces) * struct.calcsize("<II")
    bitmap_start = header_size + sum(len(codes) for _, _, codes in faces) * glyph_size
    for size, weight, codes in faces:
        font = ImageFont.truetype(source, size, layout_engine=ImageFont.Layout.BASIC)
        font.set_variation_by_axes([weight])
        header += struct.pack("<II", len(codes), header_size + len(tables))
        for code in codes:
            width, height, advance, x, y, pixels = rasterize(font, chr(code))
            tables += struct.pack("<IIBBBbb3x", code, bitmap_start + len(bitmap),
                                  width, height, advance, x, y)
            bitmap += pixels
    return header + tables + bitmap, len(supported)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("terminal-font.dat"))
    arguments = parser.parse_args()
    data, count = build(arguments.source)
    arguments.output.write_bytes(data)
    print(f"{arguments.output}: {count:,} body glyphs, {len(data):,} bytes")
