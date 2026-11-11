# Face shapes — Remotion short

An original 9:16 explainer in the "face shapes visualized" format (inspired by
an 18x outlier in the *faceless maxxing* workspace, video
`85b57203-35b1-42a3-b855-be590a1c5d75`). The script, base model, music and
design are new; the only thing borrowed is the format.

**Structure (~42s):** a hook, then 7 face shapes. On each shape the AI
model's face itself **morphs** into that shape (round → his face becomes
round), a dotted outline traces it, and a "same shape as" chip shows a
celebrity example. Then a reveal of the model's real shape (square), and a
"which one are you?" grid with comment bubbles as the CTA.

## Pipeline

All AI calls go through **OpenRouter** (`OPENROUTER_API_KEY`):

| Step | Model | Output |
|---|---|---|
| Base face (fictional man) | `google/gemini-2.5-flash-image` | `public/base.png` |
| Face landmarks | `google/gemini-2.5-flash` (vision) | `manifest.landmarks` |
| Face morphs (same man, 6 shapes) | `google/gemini-3-pro-image`, then `scripts/align_faces.py` | `public/faces/<shape>.png` |
| Celebrity headshots | Pinterest search → vision model picks a frontal shot and returns a crop box | `public/celebs/<shape>.jpg` |
| Voiceover | `openai/gpt-audio-mini` (voice `onyx`) | `public/vo/*.wav` |
| Music bed | `google/lyria-3-clip-preview` | `public/music.mp3` |

```bash
npm install
pip install opencv-python-headless   # face alignment
npm run assets            # build/refresh everything in public/
npm run studio            # preview in Remotion Studio
npm run render            # → out/face-shapes.mp4
```

The asset step is idempotent: it only regenerates what is missing or changed.
Force a step with `node scripts/build-assets.mjs --force=base|landmarks|celebs|celeb:<id>|vo|music|all`.
Env knobs: `FS_IMAGE_MODEL`, `FS_MORPH_MODEL`, `FS_VISION_MODEL`, `FS_TTS_MODEL`, `FS_MUSIC_MODEL`,
`FS_VOICE`, `FS_VO_TEMPO` (default 1.15), `FS_SKIP_MUSIC=1`.

In a sandbox without Remotion's own browser, point it at a local headless shell:
`REMOTION_BROWSER_EXECUTABLE=/path/to/chrome-headless-shell npm run render`.

## Cost

Every OpenRouter call's cost is logged to `manifest.costLog` and totalled at
the end of `npm run assets`. A full build from scratch is about **$1.20**:
6 face morphs on Gemini 3 Pro Image (~$0.14 each, the bulk), the rest
(base face, landmarks, headshot picks, voiceover, music) about $0.30.
The cheaper `google/gemini-2.5-flash-image` (~$0.04) barely changes face
outlines, so it isn't the morph default.

## Editing

Everything editable lives in `content.json`: the title, voice lines, the
celebrity for each shape, how each face should be reshaped (`morph`),
comment bubbles, and the CTA. Change a celebrity
name, rerun `npm run assets`, and only that thumbnail is re-fetched.

The vision model's landmark detection is approximate.
`baseFace.landmarkOverrides` pins the four points the outlines use
(`hairline`, `chin`, `cheekL`, `cheekR`, in 0–1 image coords).
`baseFace.cropBottom` trims the strip image models often leave at the bottom.

## Rights

`public/` is gitignored on purpose. The celebrity photos are third-party
images pulled from Pinterest (the source pin is recorded in
`public/manifest.json`) and are never committed. Before publishing, swap in
images you have rights to, such as licensed or Creative Commons shots. Using
real people's likenesses in an ad or a sponsored post needs their permission.
