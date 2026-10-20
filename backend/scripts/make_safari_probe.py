"""Write a self-contained HTML page that measures the render contract's strings in whatever
browser opens it (#72: can Safari, which has no canvas ``textRendering``, measure text within
SPEC § 9's 0.5 px of Pillow by some technique?).

The page embeds the bundled fonts (base64) and every ``texts`` entry of
tests/fixtures/render/vectors.json, so it needs no server: copy it to the machine with the
browser under test and open it. It measures each string four ways and shows, per technique,
the worst deviation from Pillow, how many strings exceed 0.5 px, and the ten worst outliers,
plus a JSON block to paste back. Nothing here is used by the app.

Usage: ``make safari-probe [OUT=path]``, default frontend/dist/safari-probe.html.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import REPO_ROOT

VECTORS = REPO_ROOT / "tests" / "fixtures" / "render" / "vectors.json"
FONTS_DIR = REPO_ROOT / "fonts"
DEFAULT_OUT = REPO_ROOT / "frontend" / "dist" / "safari-probe.html"
TOLERANCE = 0.5  # SPEC § 9
SCALE = 20  # the "measure big, scale down" technique

PAGE = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AstroCaption text-measurement probe</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; max-width: 960px; color: #222; }
  table { border-collapse: collapse; margin: 12px 0 24px; }
  th, td { border: 1px solid #ccc; padding: 4px 10px; text-align: left; font-variant-numeric: tabular-nums; }
  th { background: #f3f3f3; }
  td.ok { background: #e6f6e6; } td.bad { background: #fbe3e3; }
  textarea { width: 100%; height: 160px; font: 12px ui-monospace, monospace; }
  .outliers td { font-size: 12px; }
  #stage { position: absolute; left: -10000px; top: 0; white-space: pre; text-rendering: geometricPrecision; }
  code { background: #f3f3f3; padding: 0 4px; }
</style>
<h1>AstroCaption text-measurement probe (#72)</h1>
<p>Measures __COUNT__ strings in __NFONTS__ bundled fonts and compares each width with Pillow's
(<code>tests/fixtures/render/vectors.json</code>). The editor's contract is every string within
<strong>__TOLERANCE__ px</strong>. A technique whose "over tolerance" column reads 0 would do for this browser.</p>
<p id="status">Loading fonts…</p>
<div id="report"></div>
<span id="stage"></span>
<script id="data" type="application/json">__DATA__</script>
<script>
(async () => {
  const data = JSON.parse(document.getElementById('data').textContent)
  const status = document.getElementById('status')
  const family = (file) => file.replace(/\\.ttf$/i, '')
  for (const [file, b64] of Object.entries(data.fonts)) {
    const face = new FontFace(family(file), `url(data:font/ttf;base64,${b64})`)
    await face.load()
    document.fonts.add(face)
  }
  await document.fonts.ready
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const hasTextRendering = 'textRendering' in CanvasRenderingContext2D.prototype
  const stage = document.getElementById('stage')
  const shorthand = (size, file) => `${size}px "${family(file)}"`

  const techniques = {
    'canvas measureText, default rendering': (file, size, text) => {
      if (hasTextRendering) ctx.textRendering = 'auto'
      ctx.font = shorthand(size, file)
      return ctx.measureText(text).width
    },
    ['canvas measureText at ' + data.scale + '× size, scaled down']: (file, size, text) => {
      if (hasTextRendering) ctx.textRendering = 'auto'
      ctx.font = shorthand(size * data.scale, file)
      return ctx.measureText(text).width / data.scale
    },
    'DOM Range width, CSS text-rendering: geometricPrecision': (file, size, text) => {
      stage.style.font = shorthand(size, file)
      stage.textContent = text
      const range = document.createRange()
      range.selectNodeContents(stage)
      return range.getBoundingClientRect().width
    },
  }
  if (hasTextRendering) {
    techniques['canvas measureText, textRendering = geometricPrecision (the editor today)'] = (file, size, text) => {
      ctx.textRendering = 'geometricPrecision'
      ctx.font = shorthand(size, file)
      return ctx.measureText(text).width
    }
  }

  const results = {}
  for (const [name, measure] of Object.entries(techniques)) {
    status.textContent = `Measuring: ${name}…`
    await new Promise((r) => setTimeout(r, 0))
    const deltas = data.texts.map(([file, size, text, pillow]) => {
      const width = measure(file, size, text)
      return { file, size, text, pillow, width, delta: Math.abs(width - pillow) }
    })
    deltas.sort((a, b) => b.delta - a.delta)
    results[name] = {
      worst: deltas[0].delta,
      over: deltas.filter((d) => d.delta > data.tolerance).length,
      outliers: deltas.slice(0, 10),
    }
  }
  status.textContent = `Done. ${navigator.userAgent}`

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  let html = `<p>canvas <code>textRendering</code> supported: <strong>${hasTextRendering}</strong></p>`
  html += '<table><tr><th>Technique</th><th>Worst deviation (px)</th><th>Over tolerance</th></tr>'
  for (const [name, r] of Object.entries(results)) {
    const cls = r.over === 0 ? 'ok' : 'bad'
    html += `<tr><td>${esc(name)}</td><td class="${cls}">${r.worst.toFixed(3)}</td><td class="${cls}">${r.over} / ${data.texts.length}</td></tr>`
  }
  html += '</table>'
  for (const [name, r] of Object.entries(results)) {
    html += `<h3>${esc(name)}: ten worst</h3><table class="outliers"><tr><th>Font</th><th>Size</th><th>Text</th><th>Pillow</th><th>Measured</th><th>Δ</th></tr>`
    for (const o of r.outliers) {
      html += `<tr><td>${esc(o.file)}</td><td>${o.size}</td><td>${esc(o.text)}</td><td>${o.pillow.toFixed(3)}</td><td>${o.width.toFixed(3)}</td><td>${o.delta.toFixed(3)}</td></tr>`
    }
    html += '</table>'
  }
  const summary = {
    userAgent: navigator.userAgent,
    canvasTextRendering: hasTextRendering,
    tolerance: data.tolerance,
    strings: data.texts.length,
    techniques: Object.fromEntries(
      Object.entries(results).map(([name, r]) => [
        name,
        { worst: +r.worst.toFixed(4), over: r.over, outliers: r.outliers.slice(0, 5).map((o) => [o.file, o.size, o.text, +o.width.toFixed(3), o.pillow]) },
      ]),
    ),
  }
  html += '<h3>Paste this back</h3><textarea readonly>' + esc(JSON.stringify(summary, null, 1)) + '</textarea>'
  document.getElementById('report').innerHTML = html
})().catch((err) => {
  document.getElementById('status').textContent = 'Probe failed: ' + err
})
</script>
</html>
"""


def build_page() -> str:
    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
    texts = vectors["texts"]
    files = sorted({entry[0] for entry in texts})
    fonts = {f: base64.b64encode((FONTS_DIR / f).read_bytes()).decode("ascii") for f in files}
    data = json.dumps({"fonts": fonts, "texts": texts, "tolerance": TOLERANCE, "scale": SCALE})
    # The JSON sits in a <script> element: a "</script>" inside it would end the element early.
    data = data.replace("</", "<\\/")
    return (
        PAGE.replace("__DATA__", data)
        .replace("__COUNT__", str(len(texts)))
        .replace("__NFONTS__", str(len(files)))
        .replace("__TOLERANCE__", str(TOLERANCE))
    )


def main(argv: list[str]) -> None:
    out = Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build_page(), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1_000_000:.1f} MB)")


if __name__ == "__main__":
    main(sys.argv)
