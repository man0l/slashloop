# Lipstick theory — Remotion short

An original 9:16 explainer on the "red lipstick" research (inspired by an
outlier in the *faceless maxxing* workspace, video
`d454c322-bc02-4b0e-a031-d3dc6e4a3b98`). The topic and findings come from
published research; the script, model, footage choices and design are new.
No branding, film clips or real people's faces from the source video are used.

**Beats (~39s):** the same AI woman in 4 lipsticks ("which one gets approached
first?") → red, with the field study citation → the bar experiment (bar
b-roll, shades cycling on her lips) → result: red got more approaches, sooner
→ "not every red wins": true red vs orange-red vs cameo red on her → "your pick
> their pick" → which shade are you wearing? (comment bubbles).

## Sources (claims in the script)

- Guéguen, N. (2012). *Does red lipstick really attract men? An evaluation in a
  bar.* International Journal of Psychological Studies, 4(2). Red was
  approached more often and sooner than pink, brown or no lipstick.
- Tian et al. (2023), Frontiers in Neuroscience,
  doi:10.3389/fnins.2023.1280270. Men rated true red as more attractive than
  orange-red or cameo red.

No numbers are shown on screen: only the rankings the papers report.

## Pipeline

All AI calls go through **OpenRouter** (`OPENROUTER_API_KEY`):

| Step | Model / source | Output |
|---|---|---|
| Fictional model, bare lips | `google/gemini-2.5-flash-image` | `public/shades/bare.png` |
| Lipstick edits (pink, brown, true red, orange-red, cameo) | same, then `scripts/align.py` | `public/shades/*.png` |
| Lip position | `scripts/lips.py` (bare vs red diff) | `manifest.lips` |
| Voiceover (with a length guard) | `openai/gpt-audio-mini`, voice `shimmer` | `public/vo/*.wav` |
| Music bed | `google/lyria-3-clip-preview` | `public/music.mp3` |
| SFX (pop, whoosh, tick) | synthesised with ffmpeg | `public/sfx/*.wav` |
| B-roll | [Mixkit](https://mixkit.co/license/#videoFree) free stock (URLs in `content.json`) | `public/stock/*.mp4` |

```bash
npm install
pip install opencv-python-headless   # alignment + lip detection
npm run assets            # ≈ $0.28 of OpenRouter calls from scratch
npm run studio            # preview
npm run render            # → out/lipstick.mp4
```

Force a step with `node scripts/build-assets.mjs --force=model|shades|vo|music|sfx|stock|all`.
Env knobs: `LS_IMAGE_MODEL`, `LS_TTS_MODEL`, `LS_MUSIC_MODEL`, `LS_VOICE`,
`LS_VO_TEMPO` (default 1.12), `LS_SKIP_MUSIC=1`. For a sandbox without
Remotion's own browser: `REMOTION_BROWSER_EXECUTABLE=/path/to/chrome-headless-shell`.

All copy lives in `content.json` (voice lines, on-screen caption overrides,
shades and swatches, citations, comment bubbles, stock clip URLs).
