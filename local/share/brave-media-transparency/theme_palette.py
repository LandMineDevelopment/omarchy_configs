"""Read the active Omarchy/Ghostty palette without watching or changing it."""
import math
from pathlib import Path
import re
import tomllib


DEFAULT_PALETTE = {
    "background": "#000000",
    "foreground": "#e6e6e6",
    "accent": "#ffcc66",
    "selection": "#404040",
    "selectionForeground": "#e6e6e6",
    "opacity": 0.5,
}
_RGB = re.compile(r"#[0-9a-fA-F]{6}\Z")
_MAX_FILE_SIZE = 65536


def _rgb(value):
    if not isinstance(value, str) or not _RGB.fullmatch(value):
        raise ValueError("invalid theme RGB color")
    return value.lower()


def _identity(path):
    info = path.stat()
    return info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size


class ThemePaletteCache:
    """Keep the last coherent palette across theme swaps and invalid files."""

    def __init__(self, theme_dir=None):
        self.theme_dir = Path(theme_dir) if theme_dir is not None else Path.home() / ".local/state/omarchy/current/theme"
        self._fingerprint = None
        self._palette = dict(DEFAULT_PALETTE)

    def _generation(self):
        paths = (self.theme_dir, self.theme_dir / "colors.toml", self.theme_dir / "ghostty.conf")
        identities = tuple(_identity(path) for path in paths)
        if any(identity[3] > _MAX_FILE_SIZE for identity in identities[1:]):
            raise ValueError("theme file too large")
        return identities

    def _read_palette(self):
        colors = tomllib.loads((self.theme_dir / "colors.toml").read_text(encoding="utf-8"))
        ghostty = {}
        for line in (self.theme_dir / "ghostty.conf").read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator:
                ghostty[key.strip()] = value.strip().strip('"')
        # Ghostty is the canvas reference; the semantic accent is Omarchy's.
        palette = {
            "background": _rgb(ghostty["background"]),
            "foreground": _rgb(ghostty["foreground"]),
            "accent": _rgb(colors["accent"]),
            "selection": _rgb(ghostty.get("selection-background", colors.get("selection", DEFAULT_PALETTE["selection"]))),
            "selectionForeground": _rgb(ghostty.get("selection-foreground", colors.get("selection_foreground", DEFAULT_PALETTE["selectionForeground"]))),
            "opacity": float(ghostty.get("background-opacity", DEFAULT_PALETTE["opacity"])),
        }
        if not math.isfinite(palette["opacity"]) or not 0 <= palette["opacity"] <= 1:
            raise ValueError("invalid terminal opacity")
        return palette

    def get(self):
        try:
            before = self._generation()
            if before == self._fingerprint:
                return dict(self._palette)
            try:
                palette = self._read_palette()
            except (OSError, UnicodeError, ValueError, KeyError, TypeError):
                # Cache a stable invalid generation too, avoiding repeated TOML
                # parsing on every media heartbeat while retaining good colors.
                if self._generation() == before:
                    self._fingerprint = before
                return dict(self._palette)
            if self._generation() == before:
                self._palette = palette
                self._fingerprint = before
        except (OSError, ValueError):
            # Omarchy removes current before moving the fully generated next
            # directory into place. A missing path is an expected short gap.
            pass
        return dict(self._palette)
