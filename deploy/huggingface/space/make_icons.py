"""Build square app icons (192, 512, maskable 512) from DeepTutor's logo."""

import sys
from pathlib import Path

from PIL import Image

BACKGROUND = (31, 30, 29, 255)  # matches the manifest's background/theme colour


def square(logo: Image.Image, size: int, padding: float) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BACKGROUND)
    inner = int(size * (1 - 2 * padding))
    art = logo.copy()
    art.thumbnail((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    return canvas


def main(source: str, out_dir: str) -> None:
    logo = Image.open(source).convert("RGBA")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    square(logo, 192, 0.08).save(out / "icon-192.png")
    square(logo, 512, 0.08).save(out / "icon-512.png")
    # Maskable icons must keep the artwork inside the central 80% safe zone.
    square(logo, 512, 0.2).save(out / "maskable-512.png")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
