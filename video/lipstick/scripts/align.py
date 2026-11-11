#!/usr/bin/env python3
"""Align each lipstick edit onto the base photo so shade swaps don't jump.

Image models re-frame slightly on every edit. Only the lips change between
shades, so SIFT features over the whole image (minus the bottom edge, where
models often leave a strip) give a reliable similarity transform.

Usage: python3 scripts/align.py public/shades/bare.png public/shades/red.png ...
Needs: pip install opencv-python-headless numpy
"""
import sys

import cv2
import numpy as np


def main(base_path, *variants):
    base = cv2.imread(base_path)
    h, w = base.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    mask[: int(h * 0.88)] = 255
    sift = cv2.SIFT_create(5000)
    grey = lambda im: cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    kb, db = sift.detectAndCompute(grey(base), mask)
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    for path in variants:
        img = cv2.imread(path)
        kv, dv = sift.detectAndCompute(grey(img), mask)
        good = [m for m, n in matcher.knnMatch(dv, db, k=2) if m.distance < 0.75 * n.distance]
        if len(good) < 12:
            print(f"  {path}: skipped ({len(good)} matches)")
            continue
        src = np.float32([kv[m.queryIdx].pt for m in good])
        dst = np.float32([kb[m.trainIdx].pt for m in good])
        m, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
        scale = float(np.hypot(m[0, 0], m[1, 0])) if m is not None else 0
        if not 0.8 < scale < 1.25:
            print(f"  {path}: skipped (implausible transform)")
            continue
        out = cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        cv2.imwrite(path, out)
        print(f"  {path}: scale {scale:.3f}, shift ({m[0, 2]:+.0f}, {m[1, 2]:+.0f}), {int(inliers.sum())}/{len(good)} inliers")


if __name__ == "__main__":
    main(*sys.argv[1:])
