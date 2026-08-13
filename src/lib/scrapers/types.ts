// ---------------------------------------------------------------------------
// Scraper adapter contract.
//
// One interface, several implementations, chosen at runtime by SCRAPER_PROVIDER
// (see ./index.ts). Everything above this layer — refresh, sources-service,
// suggestions, media, analysis — talks to THIS shape and never to a vendor.
//
// The contract is deliberately the one the Apify integration already grew into
// (receipts, notices, pro-rata cost), because those fields encode expensive
// lessons: a dataset receipt is what stops a retry re-buying a scrape, and a
// notice is how a "successful" empty scrape is told apart from a dead handle.
// A provider that has no equivalent returns null/[] rather than forcing every
// caller to branch on which provider is live.
// ---------------------------------------------------------------------------

import type { NormalizedVideo } from '../../normalizers.js';

export type SourceType = 'creator' | 'keyword' | 'hashtag';
export type Platform = 'tiktok' | 'reels' | 'shorts';

export interface ScrapeOptions {
  workspaceId: string;
  /** Every workspace this ONE run is made for; cost/quota is split pro-rata. */
  costShareWorkspaceIds?: string[];
  sourceType: SourceType;
  query: string;
  limit: number;
  /** Creator scrapes: only return posts on/after this instant (incremental refresh). */
  postedAfter?: Date;
  /** What this scrape is for — recorded on the UsageLog row. */
  refId?: string;
  /**
   * A dataset this caller already paid for. Providers that can re-read a prior
   * result (Apify) return it for free; providers that cannot ignore it.
   */
  resumeDatasetId?: string;
}

export interface ScrapeResult {
  items: NormalizedVideo[];
  /** What was recorded as spent for this call, in cents (0 when free/resumed). */
  costCents: number;
  rawCount: number;
  /** Provider receipt, when the provider has one. Null otherwise. */
  actorRunId: string | null;
  datasetId: string | null;
  /** True when no new billable work was done (a re-read of a paid result). */
  resumed: boolean;
  /** Human-readable reasons the run returned no usable videos. */
  notices: string[];
  /** Which adapter actually produced this result (fallback makes this vary). */
  provider?: string;
  /** Bytes moved over the network, when the adapter meters itself. */
  bytesUsed?: number;
}

export interface DownloadOptions {
  workspaceId: string;
  /** Watch URL (https://www.tiktok.com/@user/video/ID). */
  videoUrl: string;
  /** Local path to write the MP4 to. */
  outputPath: string;
}

export interface DownloadResult {
  costCents: number;
  sizeBytes: number;
  /** The URL the binary was actually fetched from. */
  cdnUrl: string;
  actorRunId: string | null;
  provider?: string;
  bytesUsed?: number;
}

export interface ScraperAdapter {
  /** Stable id, matching the SCRAPER_PROVIDER value that selects it. */
  readonly name: string;
  /** Platforms this adapter can scrape. */
  supports(platform: string): boolean;
  /** True when the adapter has everything it needs (keys, proxy URL, ...). */
  isConfigured(): boolean;
  /** Why it is not configured — surfaced in the error when selection fails. */
  configurationHint(): string;
  scrape(opts: ScrapeOptions & { platform: string }): Promise<ScrapeResult>;
  /** Fetch one video's MP4 to disk. */
  downloadVideo(opts: DownloadOptions): Promise<DownloadResult>;
}

/** Thrown when the selected provider cannot serve the request at all. */
export class ScraperUnavailableError extends Error {
  constructor(public readonly provider: string, reason: string) {
    super(`Scraper "${provider}" unavailable: ${reason}`);
    this.name = 'ScraperUnavailableError';
  }
}
