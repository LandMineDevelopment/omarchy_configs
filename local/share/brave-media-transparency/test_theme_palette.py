from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from theme_palette import DEFAULT_PALETTE, ThemePaletteCache


def write_theme(path, background="#000000", foreground="#e6e6e6", accent="#ffcc66", opacity="0.5"):
    path.mkdir(parents=True, exist_ok=True)
    (path / "colors.toml").write_text(f'accent = "{accent}"\nselection = "#404040"\nselection_foreground = "#e6e6e6"\nbackground = "#262626"\n')
    (path / "ghostty.conf").write_text(f"background = {background}\nforeground = {foreground}\nbackground-opacity = {opacity}\nselection-background = #334455\nselection-foreground = #ABCDEF\n")


class ThemePaletteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="brave-theme-palette-")
        self.addCleanup(self.directory.cleanup)
        self.theme = Path(self.directory.name) / "current"
        self.cache = ThemePaletteCache(self.theme)

    def test_missing_initial_theme_has_bounded_defaults(self):
        self.assertEqual(self.cache.get(), DEFAULT_PALETTE)

    def test_ghostty_canvas_and_semantic_accent_are_distinct(self):
        write_theme(self.theme)
        palette = self.cache.get()
        self.assertEqual(palette["background"], "#000000")
        self.assertEqual(palette["accent"], "#ffcc66")
        self.assertEqual(palette["selection"], "#334455")
        self.assertEqual(palette["selectionForeground"], "#abcdef")
        self.assertEqual(palette["opacity"], 0.5)
        self.assertEqual(set(palette), set(DEFAULT_PALETTE))

    def test_unchanged_theme_does_not_parse_again_and_results_are_copies(self):
        write_theme(self.theme)
        initial = self.cache.get()
        with patch.object(self.cache, "_read_palette", side_effect=AssertionError("cache reread")):
            returned = self.cache.get()
            returned["background"] = "bad"
            self.assertEqual(self.cache.get(), initial)

    def test_generation_swap_and_missing_gap_keep_last_valid_values(self):
        write_theme(self.theme)
        old = self.cache.get()
        self.theme.rename(self.theme.with_name("old"))
        self.assertEqual(self.cache.get(), old)
        replacement = self.theme.with_name("next")
        write_theme(replacement, background="#101010", accent="#6699ff", opacity="0.7")
        replacement.rename(self.theme)
        new = self.cache.get()
        self.assertEqual((new["background"], new["accent"], new["opacity"]), ("#101010", "#6699ff", 0.7))

    def test_invalid_colors_toml_utf8_and_opacity_preserve_last_palette(self):
        write_theme(self.theme)
        initial = self.cache.get()
        for background, accent, opacity in [("red", "#6699ff", "0.5"), ("#010203", "url(evil)", "0.5"), ("#010203", "#6699ff", "nan"), ("#010203", "#6699ff", "1.1")]:
            write_theme(self.theme, background=background, accent=accent, opacity=opacity)
            self.assertEqual(self.cache.get(), initial)
        (self.theme / "colors.toml").write_bytes(b"\xff")
        self.assertEqual(self.cache.get(), initial)
        (self.theme / "colors.toml").write_text("accent = [broken")
        self.assertEqual(self.cache.get(), initial)

    def test_stable_invalid_generation_is_cached_and_valid_edit_recovers(self):
        write_theme(self.theme)
        initial = self.cache.get()
        write_theme(self.theme, accent="bad")
        self.assertEqual(self.cache.get(), initial)
        with patch.object(self.cache, "_read_palette", side_effect=AssertionError("invalid generation reread")):
            self.assertEqual(self.cache.get(), initial)
        write_theme(self.theme, accent="#010203")
        self.assertEqual(self.cache.get()["accent"], "#010203")

    def test_swap_between_file_reads_cannot_publish_mixed_palette(self):
        write_theme(self.theme)
        initial = self.cache.get()
        # Force a reread and swap directories after reading colors but before
        # reading Ghostty. The two valid files individually belong to different
        # generations, which must never become one published palette.
        write_theme(self.theme, accent="#ff0000")
        replacement = self.theme.with_name("next")
        write_theme(replacement, background="#101010", accent="#0000ff")
        original_read = Path.read_text
        swapped = False

        def read(path, *args, **kwargs):
            nonlocal swapped
            if path == self.theme / "ghostty.conf" and not swapped:
                swapped = True
                self.theme.rename(self.theme.with_name("old"))
                replacement.rename(self.theme)
            return original_read(path, *args, **kwargs)

        with patch.object(Path, "read_text", read):
            self.assertEqual(self.cache.get(), initial)
        palette = self.cache.get()
        self.assertEqual((palette["background"], palette["accent"]), ("#101010", "#0000ff"))


if __name__ == "__main__":
    unittest.main()
