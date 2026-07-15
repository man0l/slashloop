---
description: Check Apify spend against the monthly cap.
allowed-tools: mcp__plugin_slashloop_slashloop__get_apify_spend_status, mcp__plugin_slashloop_slashloop__get_usage
---
Call the `get_apify_spend_status` MCP tool and report, in plain language: current
monthly spend, the cap, percent used, and whether the cap has been breached. If
usage is over ~80%, warn that live TikTok refreshes may soon be refused.
