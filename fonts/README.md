# Bundled fonts

Twelve open-licence families, Regular and Bold, used identically by the browser
(`@font-face` from `/fonts/`) and by Pillow on the server. Always reference a font by
**file name** (`Inter-Regular.ttf`), never by family name (CLAUDE.md).

| Family | Files | Licence |
|---|---|---|
| Inter | `Inter-Regular.ttf`, `Inter-Bold.ttf` | OFL (`LICENSES/Inter.txt`) |
| Roboto | `Roboto-*.ttf` | OFL (`LICENSES/Roboto.txt`) |
| Open Sans | `OpenSans-*.ttf` | OFL |
| Source Sans 3 | `SourceSans3-*.ttf` | OFL |
| Lato | `Lato-*.ttf` | OFL |
| Montserrat | `Montserrat-*.ttf` | OFL |
| Poppins | `Poppins-*.ttf` | OFL |
| Raleway | `Raleway-*.ttf` | OFL |
| Nunito | `Nunito-*.ttf` | OFL |
| Fira Sans | `FiraSans-*.ttf` | OFL |
| IBM Plex Sans | `IBMPlexSans-*.ttf` | OFL |
| JetBrains Mono | `JetBrainsMono-*.ttf` | OFL |

The TTFs are the static instances served by the Google Fonts CSS API for the
`latin, latin-ext, greek, cyrillic` subsets (Lato and Poppins only ship Latin upstream).
They were fetched with the throw-away script described in the milestone-1 notes; to
refresh, request `https://fonts.googleapis.com/css?family=<Family>:400,700&subset=latin,latin-ext,greek,cyrillic`
with a legacy user agent (`Mozilla/4.0`) and download the `truetype` URLs.
