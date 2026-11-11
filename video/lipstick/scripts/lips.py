#!/usr/bin/env python3
"""Find the lips by diffing the bare photo against the red one, and store the
box (normalised 0-1) in manifest.json as `lips`. Drives zooms and the lip inset.

Usage: python3 scripts/lips.py public/manifest.json public/shades/bare.png public/shades/red.png
"""
import json
import sys

import cv2
import numpy as np

manifest_path, bare_path, red_path = sys.argv[1:4]
a = cv2.imread(bare_path).astype(np.int16)
b = cv2.imread(red_path).astype(np.int16)
diff = np.abs(a - b).sum(axis=2)
mask = (diff > 60).astype(np.uint8)
mask[int(mask.shape[0] * 0.88):] = 0
mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
n, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
x, y, w, h = stats[i, :4]
H, W = mask.shape
m = json.load(open(manifest_path))
m["lips"] = {"x": x / W, "y": y / H, "w": w / W, "h": h / H}
json.dump(m, open(manifest_path, "w"), indent=2)
print("lips", m["lips"])
