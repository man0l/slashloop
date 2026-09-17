import { ExperimentError, type Experiment } from './schema.js';

export const DOCUMENT_BYTES = 1_800_000;
export const HISTORY_BYTES = 128_000;
export const HISTORY_ENTRIES = 16;
const resultReserve = { analysis: 210_000, report: 1_200_000, briefs: 1_200_000, slide: 16_000 };

export function encodeExperiment(e: Experiment): string {
  let count = 0;
  let bytes = 0;
  for (const variant of e.variants) {
    const retained: typeof variant.history = [];
    for (const entry of variant.history.slice(-HISTORY_ENTRIES).reverse()) {
      const size = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      if (count >= HISTORY_ENTRIES || bytes + size > HISTORY_BYTES) break;
      retained.unshift(entry); count++; bytes += size;
    }
    variant.history = retained;
  }
  // A running receipt reserves room for the bounded provider result before
  // credit is debited; cancellation must preserve that same headroom.
  const reserve = e.tasks.reduce((total, task) => total + (task.status === 'running' ? resultReserve[task.kind] : 0), 0);
  const json = JSON.stringify(e);
  if (Buffer.byteLength(json, 'utf8') + reserve > DOCUMENT_BYTES) {
    throw new ExperimentError(413, 'experiment_document_limit', 'Experiment is too large to safely save further results. Use fewer references or smaller briefs.');
  }
  return json;
}
