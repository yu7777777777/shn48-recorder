"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { run } = require("../lib/cli");

test("real renderer preserves complete portrait and landscape images, centers them and uses image colors on blurred sides", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-layout-"));
  try {
    const script = String.raw`
import json, sys, subprocess
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps
root, renderer = Path(sys.argv[1]), sys.argv[2]
reports = []
for label, size in [('portrait', (200, 400)), ('landscape', (400, 300))]:
    w, h = size
    pixels = np.zeros((h, w, 3), dtype=np.uint8)
    pixels[:, :w//2] = (230, 70, 50)
    pixels[:, w//2:] = (40, 110, 220)
    pixels[:h//8] = (230, 210, 60)
    pixels[-h//8:] = (80, 200, 120)
    source = Image.fromarray(pixels); original = root / (label + '.png'); source.save(original)
    expected = ImageOps.contain(source, (960, 540), method=Image.Resampling.LANCZOS)
    x, y = (960-expected.width)//2, (540-expected.height)//2
    results = []
    for style in ('plain', 'template'):
        output = root / (label + '-' + style + '.jpg')
        job = root / 'job.json'
        job.write_text(json.dumps(dict(mode='render', style=style, input=str(original), output=str(output), memberName='TEST NAME', title='TEXT MUST NOT APPEAR', theme='light')))
        subprocess.run([sys.executable, renderer, str(job)], check=True, capture_output=True)
        result = Image.open(output); assert result.size == (960, 540)
        center = np.asarray(result.crop((x, y, x+expected.width, y+expected.height))).astype(float)
        error = np.abs(center-np.asarray(expected).astype(float)).mean()
        assert error < 4, (label, style, error)
        sides = np.asarray(result).astype(float)
        assert sides[270, 20, 0] > sides[270, 20, 2] + 60
        assert sides[270, 939, 2] > sides[270, 939, 0] + 60
        assert sides[:50, :x].std() > 10
        results.append(output.read_bytes())
    assert results[0] == results[1], 'legacy template metadata must not add text or a color panel'
    reports.append(label)
print(json.dumps(dict(passed=reports)))
`;
    const result = await run(process.env.COVER_PYTHON_BIN || "/opt/cover-venv/bin/python", ["-c", script, root, path.join(__dirname, "../modules/recorder/cover-render.py")]);
    assert.deepEqual(JSON.parse(result.stdout).passed, ["portrait", "landscape"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
