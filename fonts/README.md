# Bundled fonts

Twelve open-licence families, Regular and Bold, used identically by the browser
(`@font-face` from `/fonts/`) and by Pillow on the server. Always reference a font by
**file name** (`Inter-Regular.ttf`), never by family name (CLAUDE.md).

Every family covers Latin, Latin Extended and Greek (Cyrillic too, though nothing depends on
it): labels carry Bayer letters (θ1 Ori C), the middle dot between aliases and the odd
apostrophe (Mairan's Nebula), and a font that lacks a glyph makes the export and the preview
disagree. `backend/tests/test_fonts.py` checks every file.

| Family | Files | Licence |
|---|---|---|
| Inter | `Inter-Regular.ttf`, `Inter-Bold.ttf` | OFL (`LICENSES/Inter.txt`) |
| Roboto | `Roboto-*.ttf` | OFL (`LICENSES/Roboto.txt`) |
| Open Sans | `OpenSans-*.ttf` | OFL |
| Source Sans 3 | `SourceSans3-*.ttf` | OFL |
| Fira Sans | `FiraSans-*.ttf` | OFL |
| IBM Plex Sans | `IBMPlexSans-*.ttf` | OFL |
| JetBrains Mono | `JetBrainsMono-*.ttf` | OFL |
| Ubuntu | `Ubuntu-*.ttf` | Ubuntu Font Licence 1.0 (`LICENSES/Ubuntu.txt`) |
| Manrope | `Manrope-*.ttf` | OFL |
| Roboto Condensed | `RobotoCondensed-*.ttf` | OFL |
| Play | `Play-*.ttf` | OFL |
| Source Serif 4 | `SourceSerif4-*.ttf` | OFL |

The TTFs are the static instances the Google Fonts CSS API serves to a legacy user agent for
the `latin, latin-ext, greek, cyrillic` subsets. `make fonts` refreshes them and the licence
texts; the family list lives in `backend/scripts/fetch_fonts.py`. Restart the app afterwards:
the running server caches the font list.

Lato, Montserrat, Nunito, Poppins and Raleway were bundled until milestone 3 and dropped
because their Google Fonts builds have no Greek glyphs.
