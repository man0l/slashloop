# Hook slides (slide 1): gpt-image-2 prompts

These are hook slides for 5 different items from `../looksmaxxing-tier-slideshow-matrix.md`:

| File | Matrix item | Hook text | Visual |
|---|---|---|---|
| 01-psl-where-do-you-rank | #1 PSL tiers | WHERE DO YOU ACTUALLY RANK? / PSL tiers explained | Top-tier face, single portrait |
| 02-eyes-decide-your-tier | #2 Eye area | YOUR EYES DECIDE YOUR TIER | Tight portrait, hunter eyes |
| 03-same-guy-different-body-fat | #4 Body fat | SAME GUY. DIFFERENT BODY FAT. | Split: 8% BF vs 28% BF |
| 04-sleep-on-your-face | #8 Sleep | THIS IS WHAT YOUR SLEEP DOES TO YOUR FACE | Handsome face, 4-hour-sleep tired eyes |
| 05-full-routine-vs-no-routine | #13 Routine adherence | SAME FACE. WHICH ONE ARE YOU? | Split: full routine vs no routine |

To generate them (needs `OPENAI_API_KEY` with credits; output is 1024x1536 at high quality):

```bash
cd docs/content/hook-slides
python3 -I -c "import json,subprocess,sys; p=json.load(open('prompts.json')); [x.wait() for x in [subprocess.Popen([sys.executable,'-I','gen.py',k,v,k+'.png']) for k,v in p.items()]]"
```

To generate them through OpenRouter's `meta/muse-image` instead (needs `OPENROUTER_API_KEY`):

```bash
python3 -I -c "import json,subprocess,sys; p=json.load(open('prompts.json')); [x.wait() for x in [subprocess.Popen([sys.executable,'-I','gen_muse.py',k,v,k]) for k,v in p.items()]]"
```
