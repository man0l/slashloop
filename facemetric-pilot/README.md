# facemetric-pilot

Remotion pilot: faceless "face-analysis" reels (1080x1920, 30 fps) in the @facemetricai style, driven entirely by
JSON scripts in `scripts/`. Status: **Phase 1 (calibration, R01 only)**. The full guide (how to add a reel, the beat
catalogue with screenshots) is written at the end of the pilot.

```bash
npm i
echo "OPENROUTER_API_KEY=..." > .env
npx tsx tools/gen-stills.ts R01   # stills + vision QA      -> assets/R01/*.jpg, qa.json
npx tsx tools/landmarks.ts R01    # named landmarks          -> assets/R01/*.landmarks.json
npx tsx tools/tts.ts R01          # one MP3 per beat         -> assets/R01/vo/, timing.json
npx tsx tools/render.ts R01       # out/R01.mp4, out/R01-sheet.png, row in out/render-log.md
npx remotion studio --no-open     # Review/R01-debug shows the landmark dots
```
