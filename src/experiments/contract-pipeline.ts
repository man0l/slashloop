import type { Video } from '@prisma/client';
import { experimentSourceKeys, isPhotoPost } from '../lib/media.js';
import { publicUrl, thumbBucket, thumbPath } from '../lib/storage.js';
import { universalLocks, type WorkspaceCategory } from './source-format.js';
import {
  CONTRACT_SYSTEM, ContractError, QA_SYSTEM, RawQa, baselineEdit, captionEditPrompt, chooseReferenceUse, compileQaPrompt, compileSlidePrompt,
  contractJsonSchema, contractPromptPayload, normalizeContract, pickFramesByArc, qaJsonSchema, qaVerdict, slideRole, tagLocks,
  type BaselineEdit, type ContractInput, type ResolvedContract,
} from './resolved-contract.js';
import { briefToArm, contractView, isMorphExperiment, isScriptOverlay, keepsBaselinePerson, proposalsFromContract, slideFeedback, slideUnits, slideWorkFor } from './contract-flow.js';
import { EDIT_SCENE_GOAL, editSceneDirection, validateVariants, type Experiment, type Task } from './schema.js';
import { CONTENT_FILTER_PATTERN, SafeFailure, contentFilterFailure, SlideMeter, logAiCost, type ExecuteContext, type Prepared, type RenderDeps } from './providers.js';
import { storySlideCount } from './slide-count.js';
import { classifyOpenRouterError } from '../lib/openrouter.js';
import { labelPolicy, labelRenderInstruction, redactOverlayCopy } from './render-prompt.js';

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

/** An edit-mode scene test: arm A is the source deck, the user's setting goes to the alternate only. */
const isEditScene = (e: Pick<Experiment, 'instructions'>) => e.instructions.goal === EDIT_SCENE_GOAL && !!e.instructions.sceneOverrides?.length;

/**
 * What the contract call is told. SLA-881: an edit-mode scene draft is planned from its scenes, not its stored prose
 * (drafts before SLA-881 store a direction that staged the baseline in the new setting too), and always carries the
 * workspace locks (those drafts stored none).
 */
export function contractInputOf(e: Experiment, frameCount: number, category: WorkspaceCategory = 'general'): ContractInput {
  const editScene = isEditScene(e);
  // Tagged against every category's locks, so a stored lock keeps its workspace origin if the category changes later.
  return {
    direction: editScene ? editSceneDirection(e.instructions.sceneOverrides!) : direction(e),
    locks: tagLocks(editScene ? [...universalLocks(category), ...e.instructions.lockedConstraints] : e.instructions.lockedConstraints, universalLocks('faceless')),
    sourceDefaults: e.instructions.sourceDefaults ?? [], slideCount: e.slideCount, frameCount,
    variables: e.instructions.variables, mode: e.instructions.mode, alternates: Math.max(e.variantCount - 1, 1),
    ...(e.instructions.sceneOverrides?.length ? { sceneOverrides: e.instructions.sceneOverrides } : {}),
    ...(isMorphExperiment(e) ? { morph: true } : {}),
  };
}

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

/** What the model is told when it rewrites a deck's brief after QA rejected it. The failed arms' briefs are the ones that were actually rendered. */
export function revisionContext(e: Experiment): Record<string, unknown> {
  const latest = e.revisions?.[e.revisions.length - 1];
  const failuresOf = (title: string) => latest?.arms.find(a => a.title === title)?.failures ?? {};
  return {
    revision: {
      why: 'The slideshow built from the previous slide contract FAILED the quality check after its one repair round. Return a revised contract in which every problem listed under failures cannot recur: change the scene, composition, visibleChange and overlayText of the slides concerned so the image model can show what the check asked for, and keep everything the check did not object to. Do not weaken the direction, the locks or the story arc to dodge a check.',
      arms: e.variants.map(v => ({
        title: v.title, qaVerdict: v.qaDeck?.verdict ?? null, failures: failuresOf(v.title),
        slides: (v.frozenBrief ?? v.brief).slides.map((s, i) => ({ slide: i + 1, overlayText: s.overlayText ?? '', scene: s.scene, composition: s.composition ?? '', visibleChange: s.visibleChange ?? '' })),
      })),
    },
  };
}

export async function prepareContractBriefs(e: Experiment, render: RenderDeps, revise = false): Promise<Prepared> {
  const contractCall = need(render.generateContract, 'render_deps_incomplete');
  if (!e.instructions.variables.length) throw new SafeFailure('no_variable');
  const frames = listSourceFrames(e, await sourcesOf(e, render));
  const bytes = await readFrames(render, frames);
  return {
    execute: async () => {
      const input = contractInputOf(e, frames.length, await render.workspaceCategory?.(e.workspaceId));
      const sources = e.inputs.filter(i => i.status === 'ready').map((i, ix) => ({
        // SLA-809: every observed slide, each trimmed, so a ladder's last frames (where the change peaks) are never cut off.
        source: `s${ix}`, observations: i.evidence.slice(0, MAX_CONTRACT_FRAMES + 4).map(v => `${v.location}: ${v.observation.slice(0, 240)}`).join(' | ').slice(0, 3000),
      }));
      const meter = new SlideMeter();
      let contract: ResolvedContract | undefined;
      let calls = 0;
      let repair: string | undefined;
      const revision = revise ? revisionContext(e) : {};
      try {
        // A variable whose value pool came back short or empty gets one in-call repair that names it; any other contract error is final.
        while (!contract) {
          calls++;
          const raw = await contractCall({
            system: CONTRACT_SYSTEM, user: contractPromptPayload(input, repair ? { sources, ...revision, repair } : { sources, ...revision }),
            images: bytes.map((b, i) => jpeg(b, `Source frame ${i}:`)), meter: meter.sink, schema: contractJsonSchema(input),
          });
          try { contract = normalizeContract(raw, input); }
          catch (err) {
            if (!(err instanceof ContractError)) throw err;
            if (err.code === 'contract_variant_missing' && calls === 1) {
              repair = `Your previous answer was rejected: ${err.message} Return the complete contract again with a full pool for every variable.`;
              continue;
            }
            // SLA-867: a morph deck's grades or wording get the same one in-call repair, naming what was wrong.
            if (err.code.startsWith('morph_') && calls === 1) {
              repair = `Your previous answer was rejected: ${err.message} Return the complete contract again with that fixed.`;
              continue;
            }
            throw new SafeFailure(err.code);
          }
        }
      } finally { meter.flush(e.workspaceId, `${e.id}#contract`, render.recordAiCost ?? logAiCost); }
      const { proposals, notices } = proposalsFromContract(e, contract);
      // The contract renders at least baseline + one alternative, so a variantCount of 1 cannot cap it (notice in proposalsFromContract).
      validateVariants({ ...e, variantCount: Math.max(e.variantCount, proposals.length) }, proposals);
      return { proposals, contract, slideCount: e.slideCount, notices, calls: { contract: calls } };
    },
  };
}

// ---- slides ------------------------------------------------------------------------

// OpenRouter words it "The response was filtered due to the prompt triggering our content management policy".
const FILTERED = /moderat|content.?(polic|filter|manag)|\bfiltered\b|safety|blocked|refus/i;

function renderFailure(err: unknown, refusal: { overlayMode: 'model' | 'script'; invocations: number; plainPromptRetry: boolean }): never {
  const message = err instanceof Error ? err.message : String(err);
  const flat = message.replace(/\s+/g, ' ');
  if (err instanceof SafeFailure) throw err;
  if (CONTENT_FILTER_PATTERN.test(flat)) throw contentFilterFailure(message, refusal);
  if (/in_flight_budget_exhausted/i.test(flat) && !/insufficient credits/i.test(flat)) throw new SafeFailure(`in_flight_budget retry_after=${/retry_after=(\d+)/i.exec(flat)?.[1] ?? 20}`);
  if (/\b402\b|insufficient credits/i.test(flat)) throw new SafeFailure('credits_exhausted_402');
  if (/\b429\b|rate.?limit/i.test(flat)) throw new SafeFailure(`rate_limited_429 retry_after=${/retry_after=(\d+)/i.exec(flat)?.[1] ?? 30}`);
  // 5xx and timeouts can change on a repeat: hand the provider error to the engine as-is so it is requeued as an unknown outcome, not recorded as a verified render_failed.
  if (classifyOpenRouterError(err).retryable) throw err;
  throw new SafeFailure(`render_failed[${flat.slice(0, 120)}]`);
}

/** A prompt the contract refuses to compile (SLA-867: valuation words on a morph slide) fails the slide before any provider call. */
function compileWithin(compile: () => string): string {
  try { return compile(); } catch (err) {
    if (err instanceof ContractError) throw new SafeFailure(`${err.code}: ${err.message}`.slice(0, 300));
    throw err;
  }
}

export async function prepareContractSlide(e: Experiment, t: Task, render: RenderDeps): Promise<Prepared> {
  const v = e.variants.find(x => x.id === t.target);
  if (!v?.frozenBrief) throw new SafeFailure('missing_frozen_brief');
  const index = t.index ?? 0;
  if (!v.frozenBrief.slides[index]) throw new SafeFailure('invalid_slide');
  const view = contractView(e, v.frozenBrief, v);
  const path = `experiments/retained/${e.workspaceId}/${e.id}/${v.id}/r${v.revision}/${t.id}.jpg`;
  const upload = async (body: Buffer, contentType: string) => { await render.upload({ bucket: thumbBucket(), path, body, contentType, upsert: false }); };
  const base = v.baselineId ? e.variants.find(x => x.id === v.baselineId) : undefined;
  let work = slideWorkFor(e, v, index, t.fix);
  const human = slideFeedback(v, index);
  const baseSlide = base?.slides[index];
  // SLA-787: in script mode the model only ever sees a text-free contract; the words are drawn onto the verified-blank
  // bytes in code, so a word that trips the provider's content filter never reaches it.
  // SLA-867: a morph deck's labels (rank names, percentages) never reach the image model, whatever the stored mode says.
  const morph = isMorphExperiment(e);
  const scriptMode = isScriptOverlay(e);
  const scriptText = scriptMode ? (view.slides[index]?.overlayText ?? '') : '';
  const copy = scriptMode ? [view.hook, ...view.slides.map(x => x.overlayText), ...(base?.frozenBrief?.slides.map(x => x.overlayText ?? '') ?? [])].filter(x => x.trim().length > 1) : [];
  const promptView: ResolvedContract = scriptMode ? { ...view, hook: '', slides: view.slides.map(x => ({ ...x, overlayText: '' })) } : view;
  const guard = (p: string) => (scriptMode ? redactOverlayCopy(p, copy) : p);
  const basePathOf = (p: string) => p.replace(/\.jpg$/, '.base.jpg');
  const compose = async (bytes: Buffer): Promise<{ body: Buffer; contentType: string; audit: unknown }> => {
    if (!scriptText) return { body: bytes, contentType: 'image/jpeg', audit: null };
    if (!render.composeOverlay) throw new SafeFailure('overlay_compose_failed: compositor unavailable');
    try {
      const c = await render.composeOverlay({ buffer: bytes, text: scriptText, slideIndex: index, ...(morph ? { stacked: true } : {}) });
      return { body: c.buffer, contentType: c.contentType, audit: { mode: 'script', font: c.font, fontSize: c.fontSize, lines: c.lines, skipped: c.skipped } };
    } catch (err) {
      throw new SafeFailure(`overlay_compose_failed: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  };

  if (work === 'reuse') {
    if (!baseSlide?.path) throw new SafeFailure('baseline_slide_missing');
    const read = need(render.readReference, 'render_deps_incomplete');
    const bytes = await read({ bucket: thumbBucket(), path: baseSlide.path });
    if (!bytes) throw new SafeFailure('baseline_slide_unreadable');
    // SLA-867: the text-free base travels with the copy, so a later slide can still edit a picture without words.
    const clean = scriptMode ? await read({ bucket: thumbBucket(), path: basePathOf(baseSlide.path) }) : null;
    return {
      free: true, units: slideUnits('reuse', scriptMode),
      execute: async () => {
        if (clean) await render.upload({ bucket: thumbBucket(), path: basePathOf(path), body: clean, contentType: 'image/jpeg', upsert: false });
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
  let edit: BaselineEdit | undefined;
  if (work === 'caption-edit' && scriptMode) {
    // The baseline's picture is text-free by construction; only the words differ, so nothing needs the model.
    if (!baseSlide?.path) throw new SafeFailure('baseline_slide_missing');
    const readBase = need(render.readReference, 'render_deps_incomplete');
    const baseBytes = baseSlide?.path
      ? (await readBase({ bucket: thumbBucket(), path: basePathOf(baseSlide.path) }))
        ?? ((base?.frozenBrief?.slides[index]?.overlayText ?? '').trim() ? null : await readBase({ bucket: thumbBucket(), path: baseSlide.path }))
      : null;
    if (baseBytes) {
      return {
        free: true, units: slideUnits('caption-edit', scriptMode),
        execute: async () => {
          const composed = await compose(baseBytes);
          await render.upload({ bucket: thumbBucket(), path: basePathOf(path), body: baseBytes, contentType: 'image/jpeg', upsert: false });
          await upload(composed.body, composed.contentType);
          return { path, url: publicUrl(thumbBucket(), path), provider: 'script-overlay', costUsd: 0, prompt: '', reference: { kind: 'baseline', videoId: base!.id, index, path: baseSlide!.path ?? '' }, overlay: composed.audit, fanout: { requested: 0, rendered: 0, chosen: 0, judge: [] }, calls: {} };
        },
      };
    }
    // No text-free picture to redraw the words on. A model edit here would be a call the quote never counted, so the slide fails closed.
    throw new SafeFailure('baseline_slide_missing');
  }
  if (work === 'baseline-edit') {
    // The baseline's own picture is the reference. In script mode that is its text-free base: the words are drawn again afterwards.
    if (!baseSlide?.path || !baseSlide.url || !base?.frozenBrief) throw new SafeFailure('baseline_slide_missing');
    const withWords = scriptMode && (base.frozenBrief.slides[index]?.overlayText ?? '').trim();
    if (withWords) {
      const clean = await need(render.readReference, 'render_deps_incomplete')({ bucket: thumbBucket(), path: basePathOf(baseSlide.path) });
      if (!clean) throw new SafeFailure('baseline_slide_missing');
      referenceUrl = publicUrl(thumbBucket(), basePathOf(baseSlide.path));
    } else referenceUrl = baseSlide.url;
    referenceNote = { kind: 'baseline', videoId: base.id, index, path: baseSlide.path };
    edit = baselineEdit(briefToArm(base.frozenBrief), briefToArm(v.frozenBrief), index);
    prompt = guard(compileSlidePrompt(promptView, index, 'baseline-edit', 'none', t.fix ?? '', guard(human), labelRenderInstruction(labelPolicy(e.instructions.lockedConstraints)), edit));
  } else if (work === 'caption-edit') {
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
      // SLA-867: in script mode slide 1 carries code-drawn words; the edit starts from its text-free base, so no label reaches the model as pixels.
      if (scriptMode && anchor.path && (view.slides[0]?.overlayText ?? '').trim()) {
        const base1 = basePathOf(anchor.path);
        if (!(await need(render.readReference, 'render_deps_incomplete')({ bucket: thumbBucket(), path: base1 }))) throw new SafeFailure('anchor_slide_missing');
        referenceUrl = publicUrl(thumbBucket(), base1); referenceNote = { ...referenceNote, path: base1 };
      }
    } else if (pick.referenceUse === 'style-only') {
      const f = frames[pick.frameIndex ?? -1];
      if (f) { referenceUrl = f.url; referenceNote = { kind: f.kind, videoId: f.videoId, index: f.slideIndex, path: f.path }; }
    }
    prompt = guard(compileWithin(() => compileSlidePrompt(promptView, index, role, referenceUrl && role === 'fresh' ? 'style-only' : pick.referenceUse, t.fix ?? '', guard(human))));
  }

  const callKind = t.fix || human ? 'render-extra' : work === 'caption-edit' ? 'caption-edit' : 'render';
  const model = process.env.EXPERIMENT_IMAGE_MODEL?.trim() || 'meta/muse-image';
  return {
    units: slideUnits(work, scriptMode),
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
          const comparative = work !== 'caption-edit' && work !== 'baseline-edit' && role === 'anchor-edit' && !!view.slides[index]?.visibleChange;
          const refusal = { overlayMode: scriptMode ? 'script' : 'model', invocations: calls, plainPromptRetry: false } as const;
          if (!FILTERED.test(msg)) renderFailure(err, refusal);
          // A filter hit gets one plain retry: without the repair text or human feedback, and an edit of slide 1 asks
          // for the slide's own scene instead of the face comparison. A second refusal is terminal (renderFailure).
          const plain = comparative ? { ...promptView, sourceArc: undefined, slides: promptView.slides.map((s, i) => i === index ? { ...s, visibleChange: '' } : s) } : promptView;
          usedPrompt = work === 'caption-edit' && base?.frozenBrief
            ? captionEditPrompt(base.frozenBrief.slides[index]?.overlayText ?? '', view.slides[index]!.overlayText)
            : work === 'baseline-edit'
              ? guard(compileSlidePrompt(promptView, index, 'baseline-edit', 'none', '', '', labelRenderInstruction(labelPolicy(e.instructions.lockedConstraints)), edit))
              : guard(compileWithin(() => compileSlidePrompt(plain, index, role, referenceUrl && role === 'fresh' ? 'style-only' : pick.referenceUse)));
          try { image = await once(usedPrompt); } catch (err2) { renderFailure(err2, { ...refusal, invocations: calls, plainPromptRetry: true }); }
        }
        let overlay: unknown = null;
        if (scriptMode) {
          const composed = await compose(image!.buffer);
          overlay = composed.audit;
          if (scriptText) await render.upload({ bucket: thumbBucket(), path: basePathOf(path), body: image!.buffer, contentType: image!.contentType, upsert: false });
          await upload(composed.body, composed.contentType);
        } else await upload(image!.buffer, image!.contentType);
        return {
          path, url: publicUrl(thumbBucket(), path), model, provider: 'openrouter', costUsd, prompt: usedPrompt, reference: referenceNote, ...(overlay ? { overlay } : {}),
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
  const view = contractView(e, v.frozenBrief, v);
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
  // An alternate that keeps the baseline's person and changes the scene is judged against the baseline deck: same person and medium, a different setting.
  const base = keepsBaselinePerson(e, v) ? e.variants.find(x => x.id === v.baselineId) : undefined;
  const baselineBytes = base ? await Promise.all(base.slides.map(async s => {
    const b = s.path ? await read({ bucket: thumbBucket(), path: s.path }) : null;
    if (!b) throw new SafeFailure('qa_baseline_unreadable');
    return b;
  })) : [];
  return {
    execute: async () => {
      const meter = new SlideMeter();
      let raw: unknown;
      try {
        raw = await verify({
          system: QA_SYSTEM, user: compileQaPrompt(view, { slideCount: n, sourceImages: sourceBytes.length, referenceUse, ...(baselineBytes.length ? { baselineImages: baselineBytes.length } : {}) }),
          images: [...slideBytes.map((b, i) => jpeg(b, `Slide ${i + 1}:`)), ...sourceBytes.map((b, i) => jpeg(b, `Source frame ${i + 1}:`)), ...baselineBytes.map((b, i) => jpeg(b, `Baseline slide ${i + 1}:`))],
          meter: meter.sink, schema: qaJsonSchema(view),
        });
      } finally { meter.flush(e.workspaceId, `${e.id}:${v.id}#qa`, render.recordAiCost ?? logAiCost); }
      const parsed = RawQa.safeParse(raw);
      if (!parsed.success) throw new SafeFailure('qa_invalid_response');
      const verdict = qaVerdict(view, parsed.data, { sceneEdit: baselineBytes.length > 0 });
      return { passed: verdict.passed, failures: verdict.failures, warnings: verdict.warnings, calls: { qa: 1 } };
    },
  };
}

export function prepareContractTask(e: Experiment, t: Task, render: RenderDeps): Promise<Prepared> {
  if (t.kind === 'briefs') return prepareContractBriefs(e, render);
  if (t.kind === 'revise') return prepareContractBriefs(e, render, true);
  if (t.kind === 'qa') return prepareContractQa(e, t, render);
  if (t.kind === 'slide') return prepareContractSlide(e, t, render);
  throw new SafeFailure('unexpected_task');
}

