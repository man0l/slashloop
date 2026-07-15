---
description: Check Apify spend against the monthly cap.
agent: build
---
Call `slashloop_get_apify_spend_status` and report, in plain language: current monthly spend,
the cap, percent used, and whether the cap has been breached. If usage is over ~80%, warn that
live TikTok refreshes may soon be refused.
