---
name: slashloop-social
description: Schedule posts to connected social accounts (TikTok, YouTube, Instagram, Threads, Pinterest) and plan a week of posts across tagged account lanes with a rotation. Use before create_social_post when more than one account or more than one video a day is involved.
---

# Slashloop social posting and lane rotation

Social tools act on the signed-in user's connected accounts and are not
workspace-scoped. OAuth connecting happens in the web app, never over MCP.

## Single posts

1. `list_social_accounts` — account ids, `status` (`active`, `reconnect_needed`,
   `disabled`), plus `tags`, `lane`, `primary`.
2. `upload_social_media` for any media not already on a durable public URL.
3. `create_social_post` — omit `publishAt` to save a draft. A scheduled post
   publishes on real accounts, so **confirm caption, media, accounts and time
   with the user first**.
4. `list_social_posts`, `reschedule_social_post`, `delete_social_post` to review
   and change them.

## Lanes and rotation

A **lane** is a group of accounts that post the same video at the same minute
(e.g. a persona's Instagram, YouTube and Pinterest). Lanes are set with tags:

- `tag_social_account({ integrationId, tags })` replaces an account's tags.
  Vocabulary: `lane:<name>` (one per account) and `primary` (one per lane; the
  lead account, needs a lane tag). Only the connecting user, or the owner of a
  workspace the account is shared through, may tag (`not_owner` otherwise).
  Other errors: `invalid_tag`, `primary_needs_lane`, `lane_has_primary`.
  Untagged accounts are never planned.
- `set_rotation({ name, lanes, anchorMonday, periodDays?, timezone? })` saves
  an ordered lane list. `anchorMonday` is a `YYYY-MM-DD` Monday that starts week
  0 (default 7-day period, `America/New_York`). Video `v` of a day goes to
  `lanes[(v - 1 - week) mod L]`, so each week every lane takes a different video
  slot. Read `warnings` — a lane nobody is tagged into, or without a primary,
  hands its videos to the next lane.
- `plan_rotation({ rotation, from, days, slots })` is **read-only**. `slots` are
  the local `HH:MM` post times (their count is videos per day, slot i is video
  i+1). It returns `rows` (one per account per video, with `lane`, `role`
  `primary`/`repost`, and a shared UTC `publishAt` per lane) and `problems`.

**Call `plan_rotation` before scheduling a week.** Surface `problems` to the
user: a lane whose primary is `reconnect_needed`/`disabled` passes its video to
the next lane with a healthy primary, skipped accounts need a reconnect in the
web app, and a duplicate connection of the same platform account posts once.
After the user confirms the plan, call `create_social_post` once per row:

```
create_social_post({ integrationIds: [row.integrationId], publishAt: row.publishAt,
                     content, media })
```

Use the same content and media for every row of the same `date` + `video`. The
planner never creates posts; do not re-time rows, as lane members are meant to
publish in the same minute.
