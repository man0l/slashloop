// Experiment deletion — shared by the REST API (api/experiments.ts DELETE)
// and the MCP delete_experiment tool (src/tools/experiments.ts), so both
// refuse active experiments and cascade the retained R2 images identically.
import { ExperimentError } from './schema.js';
import { load, remove } from './store.js';
import { deleteObjects, thumbBucket } from '../lib/storage.js';
import type { Experiment } from './schema.js';

const isRunning = (e: Experiment) => e.status === 'planning' || e.status === 'generating';
/** Retained slide images live under the retained prefix; they go with the record. */
const ownedPaths = (e: Experiment) =>
  [...e.tasks.map(t => t.path), ...e.variants.flatMap(v => v.slides.map(s => s.path))].filter((p): p is string => !!p);

/** Single delete: throws 409 active_experiment / 404 experiment_not_found. */
export async function deleteExperiment(workspaceId: string, id: string): Promise<{ deleted: true }> {
  const e = await load(workspaceId, id);
  if (isRunning(e)) throw new ExperimentError(409, 'active_experiment', 'Cancel the experiment before deleting it.');
  const paths = ownedPaths(e);
  const deleted = await remove(workspaceId, id);
  if (!deleted) throw new ExperimentError(404, 'experiment_not_found');
  if (paths.length) await deleteObjects(thumbBucket(), paths).catch(() => 0);
  return { deleted: true };
}

export type BulkDeleteFailure = { id: string; code: string; message?: string };

/**
 * Bulk delete: best-effort per id — running experiments are refused, the
 * rest cascade (document row + retained R2 images) exactly like the single
 * delete. Partial outcomes are reported, never thrown as one.
 */
export async function deleteExperiments(workspaceId: string, ids: string[]): Promise<{ deleted: number; failed: BulkDeleteFailure[] }> {
  const deleted: string[] = [];
  const failed: BulkDeleteFailure[] = [];
  const paths: string[] = [];
  for (const delId of ids) {
    try {
      const del = await load(workspaceId, delId);
      if (isRunning(del)) { failed.push({ id: delId, code: 'active_experiment', message: 'Cancel the experiment before deleting it.' }); continue; }
      const own = ownedPaths(del);
      if (await remove(workspaceId, delId)) { deleted.push(delId); paths.push(...own); }
      else failed.push({ id: delId, code: 'experiment_not_found' });
    } catch (err) {
      failed.push(err instanceof ExperimentError
        ? { id: delId, code: err.code, message: err.message }
        : { id: delId, code: 'experiment_request_failed', message: err instanceof Error ? err.message : undefined });
    }
  }
  if (paths.length) await deleteObjects(thumbBucket(), paths).catch(() => 0);
  return { deleted: deleted.length, failed };
}
