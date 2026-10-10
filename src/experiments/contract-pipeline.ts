import type { Video } from '@prisma/client';
import { experimentSourceKeys, isPhotoPost } from '../lib/media.js';
import { publicUrl, thumbBucket, thumbPath } from '../lib/storage.js';
import { universalLocks } from './source-format.js';
import {
  CONTRACT_SYSTEM, ContractError, QA_SYSTEM, RawQa, captionEditPrompt, chooseReferenceUse, compileQaPrompt, compileSlidePrompt,
  contractPromptPayload, normalizeContract, pickFramesByArc, qaVerdict, slideRole, tagLocks,
  type ContractInput, type ResolvedContract,
} from './resolved-contract.js';
import { contractView, proposalsFromContract, slideWorkFor } from './contract-flow.js';
import { validateVariants, type Experiment, type Task } from './schema.js';
import { SafeFailure, SlideMeter, logAiCost, type ExecuteContext, type Prepared, type RenderDeps } from './providers.js';
import { storySlideCount } from './slide-count.js';

/** One source image the contract, the renderer and QA all index the same way. */
export interface SourceFrame { index: number; videoId: string; slideIndex: number | null; path: string; url: string; kind: 'slide' | 'thumb' }

export const MAX_CONTRACT_FRAMES = 8;

function evenlySampled<T>(xs: readonly T[], k: number): T[] {
  if (xs.length <= k) return [...xs];
  if (k <= 1) return [xs[0]!];
  return Array.from({ length: k }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (k - 1))]!);
}

/** True when the persisted slide count was reached by subtracting this deck's closing CTA slide.
 *  That slide is not story: it must not be offered to the contract, the renderer or QA. */
export function droppedSourceCta(e: Pick<Experiment, 'slideCount' | 'instructions'>, slideKeys: number): boolean {
  if (e.instructions.preserveSourceCtaSlide === true || slideKeys < 2) return false;
  return storySlideCount(slideKeys, true) === e.slideCount && storySlideCount(slideKeys, false) !== e.slideCount;
}

/** Ready inputs, in order, flattened to at most MAX_CONTRACT_FRAMES. Same ordering at the contract call, the render and QA. */
export function listSourceFrames(e: Pick<Experiment, 'inputs' | 'workspaceId' | 'slideCount' | 'instructions'>, videos: Video[]): SourceFrame[] {
  const ready = e.inputs.filter(i => i.status === 'ready');
  const perSource = Math.max(1, Math.floor(MAX_CONTRACT_FRAMES / Math.max(1, ready.length)));
  const out: Array<Omit<SourceFrame, 'index'>> = [];
  for (const input of ready) {
    const video = videos.find(v => v.id === input.videoId);
    if (!video) throw new SafeFailure('reference_source_not_found');
    const allKeys = experimentSourceKeys(video.rawJson);
    const keys = droppedSourceCta(e, allKeys.length) ? allKeys.slice(0, -1) : allKeys;
    if (!keys.length) {
      if (isPhotoPost(video)) throw new SafeFailure('reference_slides_unavailable');
      const path = thumbPath(e.workspaceId, video.id);
      out.push({ videoId: video.id, slideIndex: null, path, url: publicUrl(thumbBucket(), path), kind: 'thumb' });
      continue;
    }
    const okPrefix = (key: string) => ['slides', 'recreate'].some(dir => {
      const prefix = `${e.workspaceId}/${video.id}/${dir}/`;
      return key.startsWith(prefix) && /^\d+\.jpg$/.test(key.slice(prefix.length));
    });
    if (keys.some(k => !okPrefix(k))) throw new SafeFailure('invalid_reference_key');
    const picked = evenlySampled(keys.map((path, slideIndex) => ({ path, slideIndex })), perSource);
    for (const p of picked) out.push({ videoId: video.id, slideIndex: p.slideIndex, path: p.path, url: publicUrl(thumbBucket(), p.path), kind: 'slide' });
  }
  return out.slice(0, MAX_CONTRACT_FRAMES).map((f, index) => ({ ...f, index }));
}

const direction = (e: Pick<Experiment, 'instructions'>) => (e.instructions.direction || e.instructions.goal || '').trim();

const need = <T>(x: T | undefined, code: string): T => { if (x === undefined || x === null) throw new SafeFailure(code); return x; };

const jpeg = (b: Buffer, label?: string) => ({ mimeType: 'image/jpeg', dataBase64: b.toString('base64'), ...(label ? { label } : {}) });

async function readFrames(render: RenderDeps, frames: SourceFrame[]): Promise<Buffer[]> {
  const read = need(render.readReference, 'render_deps_incomplete');
  return Promise.all(frames.map(async f => {
    const b = await read({ bucket: thumbBucket(), path: f.path });
    if (!b) throw new SafeFailure('reference_frame_unreadable');
    return b;
  }));
}

async function sourcesOf(e: Experiment, render: RenderDeps): Promise<Video[]> {
  return render.findSources(e.workspaceId, e.inputs.filter(i => i.status === 'ready').map(i => i.videoId));
}

// ---- briefs: one contract call replaces brief candidates + judge -------------------

export async function prepareContractBriefs(e: Experiment, render: RenderDeps): Promise<Prepared> {
  const contractCall = need(render.generateContract, 'render_deps_incomplete');
  const variable = e.instructions.variables[0];
  if (!variable) throw new SafeFailure('no_variable');
  const frames = listSourceFrames(e, await sourcesOf(e, render));
  const bytes = await readFrames(render, frames);
  return {
    execute: async () => {
      const input: ContractInput = {
        direction: direction(e), locks: tagLocks(e.instructions.lockedConstraints, universalLocks()),
        sourceDefaults: e.instructions.sourceDefaults ?? [], slideCount: e.slideCount, frameCount: frames.length, variable,
      };
      const sources = e.inputs.filter(i => i.status === 'ready').map((i, ix) => ({
        source: `s${ix}`, observations: i.evidence.slice(0, 6).map(v => v.observation).join(' | ').slice(0, 1200),
      }));
      const meter = new SlideMeter();
      let raw: unknown;
      try {
        raw = await contractCall({
          system: CONTRACT_SYSTEM, user: contractPromptPayload(input, { sources }),
          images: bytes.map((b, i) => jpeg(b, `Source frame ${i}:`)), meter: meter.sink,
        });
      } finally { meter.flush(e.workspaceId, `${e.id}#contract`, render.recordAiCost ?? logAiCost); }
      let contract: ResolvedContract;
      try { contract = normalizeContract(raw, input); }
      catch (err) { if (err instanceof ContractError) throw new SafeFailure(err.code); throw err; }
      const { proposals, notices } = proposalsFromContract(e, contract);
      validateVariants(e, proposals);
      return { proposals, contract, slideCount: e.slideCount, notices, calls: { contract: 1 } };
    },
  };
}

// ---- slides ------------------------------------------------------------------------

const FILTERED = /moderat|content.?(polic|filter)|safety|blocked|refus/i;

function renderFailure(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const flat = message.replace(/\s+/g, ' ');
  if (err instanceof SafeFailure) throw err;
  if (/in_flight_budget_exhausted/i.test(flat) && !/insufficient credits/i.test(flat)) throw new SafeFailure(`in_flight_budget retry_after=${/retry_after=(\d+)/i.exec(flat)?.[1] ?? 20}`);
  if (/\b402\b|insufficient credits/i.test(flat)) throw new SafeFailure('credits_exhausted_402');
  if (/\b429\b|rate.?limit/i.test(flat)) throw new SafeFailure(`rate_limited_429 retry_after=${/retry_after=(\d+)/i.exec(flat)?.[1] ?? 30}`);
  throw new SafeFailure(`render_failed[${flat.slice(0, 120)}]`);
}

export async function prepareContractSlide(e: Experiment, t: Task, render: RenderDeps): Promise<Prepared> {
  const v = e.variants.find(x => x.id === t.target);
  if (!v?.frozenBrief) throw new SafeFailure('missing_frozen_brief');
  const index = t.index ?? 0;
  if (!v.frozenBrief.slides[index]) throw new SafeFailure('invalid_slide');
  const view = contractView(e, v.frozenBrief);
  const path = `experiments/retained/${e.workspaceId}/${e.id}/${v.id}/r${v.revision}/${t.id}.jpg`;
  const upload = async (body: Buffer, contentType: string) => { await render.upload({ bucket: thumbBucket(), path, body, contentType, upsert: false }); };
  const base = v.baselineId ? e.variants.find(x => x.id === v.baselineId) : undefined;
  const work = slideWorkFor(e, v, index, t.fix);
  const baseSlide = base?.slides[index];

  if (work === 'reuse') {
    if (!baseSlide?.path) throw new SafeFailure('baseline_slide_missing');
    const bytes = await need(render.readReference, 'render_deps_incomplete')({ bucket: thumbBucket(), path: baseSlide.path });
    if (!bytes) throw new SafeFailure('baseline_slide_unreadable');
    return {
      free: true, units: 0,
      execute: async () => {
        await upload(bytes, 'image/jpeg');
        return { path, url: publicUrl(thumbBucket(), path), provider: 'reuse', costUsd: 0, prompt: '', reference: { kind: 'baseline', videoId: base!.id, index, path: baseSlide.path }, fanout: { requested: 0, rendered: 0, chosen: 0, judge: [] }, calls: {} };
      },
    };
  }

  const picks = pickFramesByArc(view);
  const pick = picks[index]!;
  const role = slideRole(view, index, pick);
  let referenceUrl: string | undefined;
  let referenceNote: { kind: string; videoId: string; index: number | null; path: string } | null = null;
  let prompt: string;
  if (work === 'caption-edit') {
    if (!baseSlide?.url || !base?.frozenBrief) throw new SafeFailure('baseline_slide_missing');
    referenceUrl = baseSlide.url;
    referenceNote = { kind: 'baseline', videoId: base.id, index, path: baseSlide.path ?? '' };
    prompt = captionEditPrompt(base.frozenBrief.slides[index]?.overlayText ?? '', view.slides[index]!.overlayText, t.fix ?? '');
  } else {
    const frames = listSourceFrames(e, await sourcesOf(e, render));
    if (role === 'edit') {
      const f = frames[pick.frameIndex ?? -1];
      if (!f) throw new SafeFailure('source_frame_missing');
      referenceUrl = f.url; referenceNote = { kind: f.kind, videoId: f.videoId, index: f.slideIndex, path: f.path };
    } else if (role === 'anchor-edit') {
      const anchor = v.slides[0];
      if (!anchor?.url) throw new SafeFailure('anchor_slide_missing');
      referenceUrl = anchor.url; referenceNote = { kind: 'anchor', videoId: v.id, index: 0, path: anchor.path ?? '' };
    } else if (pick.referenceUse === 'style-only') {
      const f = frames[pick.frameIndex ?? -1];
      if (f) { referenceUrl = f.url; referenceNote = { kind: f.kind, videoId: f.videoId, index: f.slideIndex, path: f.path }; }
    }
    prompt = compileSlidePrompt(view, index, role, referenceUrl && role === 'fresh' ? 'style-only' : pick.referenceUse, t.fix ?? '');
  }

  const callKind = t.fix ? 'render-extra' : work === 'caption-edit' ? 'caption-edit' : 'render';
  const model = process.env.EXPERIMENT_IMAGE_MODEL?.trim() || 'meta/muse-image';
  return {
    units: 1,
    execute: async (_ctx?: ExecuteContext) => {
      const meter = new SlideMeter();
      const write = render.recordAiCost ?? logAiCost;
      const ref = `${e.id}:${v.id}#${index}`;
      let calls = 0; let costUsd = 0;
      const once = async (p: string) => {
        calls++;
        const r = await render.generateImage({ prompt: p, referenceUrl, model, quality: 'low', aspectRatio: '9:16' });
        costUsd += r.costUsd ?? 0; meter.sink(callKind, { costUsd: r.costUsd });
        return r;
      };
      let usedPrompt = prompt;
      try {
        let image;
        try { image = await once(prompt); }
        catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!t.fix || !FILTERED.test(msg)) renderFailure(err);
          // The repair text can trip a content filter: retry once with the plain prompt.
          usedPrompt = work === 'caption-edit' && base?.frozenBrief
            ? captionEditPrompt(base.frozenBrief.slides[index]?.overlayText ?? '', view.slides[index]!.overlayText)
            : compileSlidePrompt(view, index, role, referenceUrl && role === 'fresh' ? 'style-only' : pick.referenceUse);
          try { image = await once(usedPrompt); } catch (err2) { renderFailure(err2); }
        }
        await upload(image!.buffer, image!.contentType);
        return {
          path, url: publicUrl(thumbBucket(), path), model, provider: 'openrouter', costUsd, prompt: usedPrompt, reference: referenceNote,
          fanout: { requested: 1, rendered: 1, chosen: 0, judge: [] }, calls: { [callKind]: calls },
        };
      } finally { meter.flush(e.workspaceId, ref, write); }
    },
  };
}

// ---- QA: one vision call per arm ---------------------------------------------------

export async function prepareContractQa(e: Experiment, t: Task, render: RenderDeps): Promise<Prepared> {
  const verify = need(render.verifyDeck, 'render_deps_incomplete');
  const v = e.variants.find(x => x.id === t.target);
  if (!v?.frozenBrief) throw new SafeFailure('missing_frozen_brief');
  const view = contractView(e, v.frozenBrief);
  const n = view.slides.length;
  const read = need(render.readReference, 'render_deps_incomplete');
  const slideBytes = await Promise.all(v.slides.map(async s => {
    const b = s.path ? await read({ bucket: thumbBucket(), path: s.path }) : null;
    if (!b) throw new SafeFailure('qa_slide_unreadable');
    return b;
  }));
  const referenceUse = chooseReferenceUse(view);
  const frames = listSourceFrames(e, await sourcesOf(e, render));
  const wanted: SourceFrame[] = [];
  if (referenceUse === 'edit') {
    for (const p of pickFramesByArc(view)) { const f = p.frameIndex == null ? undefined : frames[p.frameIndex]; if (f) wanted.push(f); }
  } else if (view.identity.startsWith('invented')) {
    const f = frames.find(x => view.sourceFrames.find(s => s.index === x.index)?.showsPerson);
    if (f) wanted.push(f);
  }
  const sourceBytes = await readFrames(render, wanted);
  return {
    execute: async () => {
      const meter = new SlideMeter();
      let raw: unknown;
      try {
        raw = await verify({
          system: QA_SYSTEM, user: compileQaPrompt(view, { slideCount: n, sourceImages: sourceBytes.length, referenceUse }),
          images: [...slideBytes.map((b, i) => jpeg(b, `Slide ${i + 1}:`)), ...sourceBytes.map((b, i) => jpeg(b, `Source frame ${i + 1}:`))],
          meter: meter.sink,
        });
      } finally { meter.flush(e.workspaceId, `${e.id}:${v.id}#qa`, render.recordAiCost ?? logAiCost); }
      const parsed = RawQa.safeParse(raw);
      if (!parsed.success) throw new SafeFailure('qa_invalid_response');
      const verdict = qaVerdict(view, parsed.data);
      return { passed: verdict.passed, failures: verdict.failures, warnings: verdict.warnings, calls: { qa: 1 } };
    },
  };
}

export function prepareContractTask(e: Experiment, t: Task, render: RenderDeps): Promise<Prepared> {
  if (t.kind === 'briefs') return prepareContractBriefs(e, render);
  if (t.kind === 'qa') return prepareContractQa(e, t, render);
  if (t.kind === 'slide') return prepareContractSlide(e, t, render);
  throw new SafeFailure('unexpected_task');
}

