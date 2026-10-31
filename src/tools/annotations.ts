// MCP tool annotations (spec `ToolAnnotations`) for every tool the server exposes.
// Required by the Claude Connectors Directory and OpenAI plugin reviews. This
// table is the single source of truth: applyToolAnnotations() stamps it onto
// the registered tools, and annotations.test.ts fails if a tool has no row.
//
// Column order: title, readOnly, destructive, idempotent, openWorld.
//   readOnly    - changes nothing (cache refreshes and credit debits count as changes)
//   destructive - deletes data, or cancels irreversibly (plain field edits are not destructive)
//   idempotent  - repeating the call with the same args has no extra effect
//   openWorld   - calls out to the web / a third party (scrapers, LLMs, image models, social platforms)

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

type Row = readonly [title: string, readOnly: boolean, destructive: boolean, idempotent: boolean, openWorld: boolean];

const T = true;
const F = false;

export const TOOL_ANNOTATION_ROWS = {
  // Account
  whoami: ['Who Am I', T, F, T, F], // echoes the OAuth claims
  list_workspaces: ['List Workspaces', T, F, T, F], // reads workspace rows
  // Sources
  list_sources: ['List Tracked Sources', T, F, T, F], // DB read
  get_source: ['Get Tracked Source', T, F, T, F], // DB read
  create_source: ['Add Tracked Source', F, F, F, F], // inserts a source row; no network call
  update_source: ['Update Tracked Source', F, F, T, F], // partial field update, same args same state
  delete_source: ['Delete Tracked Source', F, T, T, F], // deletes the source with its videos, scores and analyses
  refresh_source: ['Refresh Source Videos', F, F, F, T], // queues a scrape job that bills credits
  suggest_sources: ['Suggest Sources', F, F, F, T], // LLM call plus verification scrapes, debits credits
  dismiss_suggested_source: ['Dismiss Suggested Source', F, F, T, F], // records a dismissal
  discover: ['Discover Sources', F, F, F, T], // LLM expansion plus real TikTok probes, debits credits
  list_due_sources: ['List Overdue Sources', T, F, T, F], // reads schedules, enqueues nothing
  refresh_due_sources: ['Refresh Overdue Sources', F, F, F, T], // queues scrape jobs for overdue sources
  deepen_baselines: ['Deepen Creator Baselines', F, F, F, F], // dry run by default; dryRun=false inserts creator sources
  rescore_sources: ['Rescore Sources', F, F, T, F], // enqueues a local recompute of derived scores, no scrape
  // Videos and feed
  get_feed: ['Get Video Feed', T, F, T, F], // reads stored videos
  search_library: ['Search Video Library', T, F, T, F], // searches already-scraped videos only
  get_outlier_summary: ['Get Outlier Summary', T, F, T, F], // aggregates stored data
  get_video: ['Get Video Details', T, F, T, F], // reads video, analysis and a signed media link
  get_video_transcript: ['Get Video Transcript', T, F, T, F], // reads stored transcript
  analyze_video: ['Analyze Video', F, F, F, T], // Gemini/OpenRouter analysis, stores a result, debits credits
  fetch_videos: ['Download Videos', F, F, T, T], // queues MP4 downloads from the platform; already-stored videos skipped
  show_gallery: ['Show Outlier Gallery', T, F, T, F], // renders stored videos in the MCP App
  // Hooks
  list_hooks: ['List Hooks', T, F, T, F], // DB read
  extract_hook: ['Extract Hook', F, F, T, F], // reuses an existing vault entry for the same hook
  generate_hook_variations: ['Generate Hook Variations', F, F, T, T], // LLM call; replay returns the same batch without charging
  list_hook_variations: ['List Hook Variations', T, F, T, F], // DB read
  // Boards
  list_boards: ['List Swipe Boards', T, F, T, F], // DB read
  get_board: ['Get Swipe Board', T, F, T, F], // DB read
  create_board: ['Create Swipe Board', F, F, F, F], // inserts a board
  save_to_board: ['Save Video to Board', F, F, T, F], // upserts the entry
  export_board: ['Export Board as Markdown', T, F, T, F], // renders Markdown, writes nothing
  // Scripts, ideas, briefs
  generate_script: ['Generate Script', F, F, T, T], // LLM call; replay returns the same script without charging
  get_script: ['Get Script', T, F, T, F], // DB read
  list_scripts: ['List Scripts', T, F, T, F], // DB read
  list_ideas: ['List Idea Cards', T, F, T, F], // DB read
  get_idea_queue: ['Get Posting Queue', T, F, T, F], // DB read
  create_idea: ['Create Idea Card', F, F, F, F], // inserts an idea
  update_idea_status: ['Update Idea Status', F, F, T, F], // sets status and planned date
  create_brief: ['Create Creative Brief', F, F, F, T], // LLM call, stores a brief, debits credits
  get_brief: ['Get Creative Brief', T, F, T, F], // DB read
  list_briefs: ['List Creative Briefs', T, F, T, F], // DB read
  export_brief: ['Export Brief as Markdown', T, F, T, F], // renders Markdown, writes nothing
  // Settings, usage, studio
  get_usage: ['Get Usage and Costs', T, F, T, F], // reads ledger and logs
  get_settings: ['Get Workspace Settings', T, F, T, F], // DB read
  update_settings: ['Update Workspace Settings', F, F, T, F], // partial settings update
  get_refresh_logs: ['Get Refresh Logs', T, F, T, F], // DB read
  run_auto_analyze: ['Run Auto-Analyze', F, F, F, T], // batch AI analysis, debits credits
  get_digest: ['Get Weekly Digest', F, F, T, F], // not read-only: recomputes and caches the digest when stale
  get_scraper_spend_status: ['Get Scraper Spend Status', T, F, T, F], // reads spend and cap state
  get_apify_spend_status: ['Get Apify Spend Status (legacy)', T, F, T, F], // legacy alias of get_scraper_spend_status
  get_weekly_retro: ['Get Weekly Retro', T, F, T, F], // aggregates stored posts
  get_benchmark: ['Get Account Benchmark', T, F, T, F], // aggregates stored videos
  // Jobs
  await_job: ['Await Job', T, F, T, F], // polls job state, writes nothing
  get_job_status: ['Get Job Status', T, F, T, F], // reads job state
  // Experiments
  list_experiments: ['List Experiments', T, F, T, F], // DB read
  get_experiment: ['Get Experiment', T, F, T, F], // DB read
  create_experiment: ['Create Experiment Drafts', F, F, F, F], // inserts free drafts; nothing is rendered
  estimate_experiment: ['Estimate Experiment Cost', T, F, T, F], // prices a stage, spends nothing
  plan_experiment: ['Plan Experiment', F, F, T, T], // idempotency-keyed; runs LLM planning, spends credits
  update_experiment_variant: ['Edit Experiment Variant', F, F, T, F], // sets a draft variant brief
  generate_experiment: ['Generate Experiment Slides', F, F, T, T], // idempotency-keyed; image-model renders, spends credits
  retry_experiment: ['Retry Experiment', F, F, F, T], // re-runs failed jobs and charges them again
  revise_experiment: ['Revise Failed Experiment', F, F, T, T], // idempotency-keyed; LLM rewrites the brief
  submit_experiment_feedback: ['Submit Slide Feedback', F, F, F, T], // re-renders slides with the notes, spends credits
  cancel_experiment: ['Cancel Experiment', F, T, T, F], // terminal, cannot be resumed
  delete_experiment: ['Delete Experiments', F, T, T, F], // permanently deletes experiments and their images
  // Social posting
  list_social_accounts: ['List Social Accounts', T, F, T, F], // DB read, tokens never returned
  tag_social_account: ['Tag Social Account', F, F, T, F], // sets the tag list
  set_rotation: ['Set Posting Rotation', F, F, T, F], // upsert by rotation name
  plan_rotation: ['Plan Posting Rotation', T, F, T, F], // computes a schedule, creates nothing
  upload_social_media: ['Upload Social Media', F, F, F, T], // fetches a public URL into storage
  create_social_post: ['Create Social Post', F, F, F, T], // saves a draft or schedules a public post on connected accounts
  list_social_posts: ['List Social Posts', T, F, T, F], // DB read
  reschedule_social_post: ['Reschedule Social Post', F, F, T, T], // changes when (or whether) a post goes live on the platforms
  delete_social_post: ['Delete Social Post', F, T, T, F], // deletes draft or scheduled groups, irreversible
} as const satisfies Record<string, Row>;

export function toolAnnotations(name: string): ToolAnnotations | undefined {
  const row = (TOOL_ANNOTATION_ROWS as Record<string, Row>)[name];
  if (!row) return undefined;
  const [title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint] = row;
  return { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

type RegisteredToolLike = { update(updates: { annotations?: ToolAnnotations }): void; annotations?: ToolAnnotations };

/** Stamp the table onto every tool registered on `server` so far. Tools without a row are left alone. */
export function applyToolAnnotations<S extends McpServer>(server: S): S {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
  for (const [name, tool] of Object.entries(tools)) {
    const annotations = toolAnnotations(name);
    if (annotations) tool.update({ annotations: { ...tool.annotations, ...annotations } });
  }
  return server;
}
