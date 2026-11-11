#!/usr/bin/env python3
"""Align each morphed face onto the base portrait so dissolves don't jump.

Image models re-frame slightly on every edit (the head drifts a few percent
up/down or grows). The eyes, brows and nose don't change between face shapes,
so this matches SIFT features inside that band and applies the similarity
transform (scale + rotation + shift) that maps the variant onto the base.

Usage: python3 scripts/align_faces.py public/manifest.json public/base.png public/faces/*.png
Needs: pip install opencv-python-headless numpy
"""
import json
import sys

import cv2
import numpy as np


def stable_mask(shape, lm):
    """Eyes → nose band from the manifest landmarks (normalised coords)."""
    h, w = shape[:2]
    mask = np.zeros((h, w), np.uint8)
    x0 = int((lm["cheekL"]["x"] + 0.03) * w)
    x1 = int((lm["cheekR"]["x"] - 0.03) * w)
    eye_y = (lm.get("eyeL", {"y": 0.39})["y"] + lm.get("eyeR", {"y": 0.39})["y"]) / 2
    y0 = int((lm["hairline"]["y"] - 0.04) * h)  # include the hairline: also stable
    y1 = int((eye_y + 0.12) * h)
    mask[y0:y1, x0:x1] = 255
    return mask


def fill_band(img, crop_bottom):
    """Image models often leave a flat strip along the bottom edge. Paint it
    over with the last clean row before warping, or a shift pulls it into view."""
    if crop_bottom <= 0:
        return img
    y = int(img.shape[0] * (1 - crop_bottom)) - 4
    img[y:] = img[y - 1 : y]
    return img


def main(manifest_path, base_path, *variants, crop_bottom=0.09):
    lm = json.load(open(manifest_path))["landmarks"]
    base = cv2.imread(base_path)
    h, w = base.shape[:2]
    sift = cv2.SIFT_create(4000)
    grey = lambda im: cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    kb, db = sift.detectAndCompute(grey(base), stable_mask(base.shape, lm))
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    for path in variants:
        img = fill_band(cv2.imread(path), crop_bottom)
        # search a wider window in the variant: it may have drifted
        wide = cv2.dilate(stable_mask(img.shape, lm), np.ones((int(h * 0.12), int(w * 0.12)), np.uint8))
        kv, dv = sift.detectAndCompute(grey(img), wide)
        good = [m for m, n in matcher.knnMatch(dv, db, k=2) if m.distance < 0.75 * n.distance]
        if len(good) < 12:
            print(f"  {path}: skipped ({len(good)} matches)")
            continue
        src = np.float32([kv[m.queryIdx].pt for m in good])
        dst = np.float32([kb[m.trainIdx].pt for m in good])
        m, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
        scale = float(np.hypot(m[0, 0], m[1, 0]))
        if m is None or not 0.8 < scale < 1.25:
            print(f"  {path}: skipped (implausible transform)")
            continue
        out = cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        cv2.imwrite(path, out)
        print(f"  {path}: scale {scale:.3f}, shift ({m[0, 2]:+.0f}, {m[1, 2]:+.0f}), {int(inliers.sum())}/{len(good)} inliers")


if __name__ == "__main__":
    main(*sys.argv[1:])
