#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// SLA-868 operator tool: fill and calibrate the composite-deck face library.
// Run where the worker runs (needs DATABASE_URL, storage and OPENROUTER_API_KEY).
//
//   bun src/scripts/face-library-ingest.ts <command> --workspace=<id> [options]
//
//   gallery-frames --video=<id>              cut a frame at every overlay timestamp of a labelled
//                                            gallery video (calibration set; never drawn on a deck)
//   commons --title="File:X.jpg" --person="Name" [--sex=male|female]
//                                            one Commons photo; CC0 / public domain / CC-BY only
//   synthetic --count=N --batch=<name> --yes generate N unnamed synthetic faces (image-model spend:
//                                            about 12 credits-worth each; ~300 for a 25-face bank)
//   calibrate [--apply]                      fit thresholds to the labelled gallery frames, report,
//                                            and with --apply re-label the whole library (no model call)
//   list                                     library summary
// ---------------------------------------------------------------------------
import { db } from '../db.js';
import { callOpenRouterText, generateOpenRouterImage } from '../lib/openrouter.js';
import { mediaBucket, mediaPath, putObject, signUrl, thumbBucket } from '../lib/storage.js';
import { prismaFaceStore, usableFaces } from '../experiments/composite/face-store.js';
import { ingestCommonsFile, ingestGalleryFrames, ingestSyntheticFaces, type FrameExtractor, type IngestDeps } from '../experiments/composite/ingest.js';
import { LANDMARK_SYSTEM_PROMPT, calibrateThresholds, relabelLibrary } from '../experiments/composite/tagging.js';

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name: string) => argv.includes(`--${name}`);
const need = (name: string) => flag(name) ?? (() => { throw new Error(`--${name}=… is required`); })();

const VISION_MODEL = process.env.FACE_LANDMARK_MODEL || 'gemini-3.5-flash';

async function imageSize(bytes: Uint8Array) {
  const { PhotonImage } = await import('@cf-wasm/photon');
  const img = PhotonImage.new_from_byteslice(bytes);
  const size = { width: img.get_width(), height: img.get_height() };
  img.free();
  return size;
}

async function liveDeps(workspaceId: string): Promise<IngestDeps> {
  const { thresholds } = calibrateThresholds(await prismaFaceStore.listCalibration(workspaceId));
  return {
    store: prismaFaceStore,
    thresholds,
    imageSize,
    putImage: async (key, body) => { await putObject({ bucket: thumbBucket(), path: key, body, contentType: 'image/jpeg' }); },
    vision: async photo => {
      const { parsed } = await callOpenRouterText(LANDMARK_SYSTEM_PROMPT, 'Locate the landmarks in this photo.', VISION_MODEL, {
        images: [{ mimeType: 'image/jpeg', dataBase64: Buffer.from(photo).toString('base64') }], temperature: 0, maxTokens: 600, reasoningEffort: 'low',
      });
      return parsed;
    },
  };
}

// The gallery stores the source video; Playwright seeks it and screenshots the frame.
// The bundled Chromium cannot decode H.264, so prefer an installed Chrome.
function playwrightFrames(workspaceId: string): { extract: FrameExtractor; close(): Promise<void> } {
  let browser: import('playwright').Browser | undefined;
  const launch = async () => {
    const { chromium } = await import('playwright');
    return browser ??= await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  };
  return {
    async extract(videoId, timestampSec) {
      const url = await signUrl(mediaBucket(), mediaPath(workspaceId, videoId), 600);
      const page = await (await launch()).newPage({ viewport: { width: 540, height: 960 } });
      try {
        await page.setContent('<body style="margin:0;background:#000"><video id="v" muted playsinline style="width:540px;height:960px;object-fit:contain"></video></body>');
        const playable = await page.evaluate(async ({ src, t }) => {
          const v = document.getElementById('v') as HTMLVideoElement;
          v.src = src;
          await new Promise<void>((ok, bad) => { v.onloadeddata = () => ok(); v.onerror = () => bad(new Error('video not playable')); });
          v.currentTime = t;
          await new Promise<void>(ok => { v.onseeked = () => ok(); });
          return v.readyState >= 2;
        }, { src: url, t: timestampSec });
        if (!playable) throw new Error('frame not decoded');
        return new Uint8Array(await page.screenshot({ type: 'jpeg', quality: 92 }));
      } finally { await page.close(); }
    },
    close: async () => { await browser?.close(); },
  };
}

const show = (results: Array<{ status: string; reason?: string }>) => {
  const tally = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status + (r.reason ? `:${r.reason}` : '')]: (m[r.status + (r.reason ? `:${r.reason}` : '')] ?? 0) + 1 }), {});
  console.log(JSON.stringify(tally));
};

async function main() {
  const workspaceId = need('workspace');
  if (command === 'list') {
    const rows = await prismaFaceStore.list(workspaceId);
    const usable = usableFaces(rows);
    console.log(JSON.stringify({ total: rows.length, usableForDecks: usable.length, bySource: Object.fromEntries(['gallery_frame', 'commons', 'synthetic'].map(s => [s, rows.filter(r => r.source === s).length])), named: rows.filter(r => r.personName).length }));
  } else if (command === 'calibrate') {
    const { thresholds, report } = calibrateThresholds(await prismaFaceStore.listCalibration(workspaceId));
    console.log(JSON.stringify(report, null, 2));
    if (has('apply')) console.log(`re-labelled ${await relabelLibrary(prismaFaceStore, workspaceId, thresholds)} face(s)`);
    else console.log('dry run: pass --apply to re-label the library with these thresholds');
  } else if (command === 'gallery-frames') {
    const videoId = need('video');
    const analysis = await db.analysis.findFirst({ where: { videoId, video: { source: { workspaceId } } }, orderBy: { createdAt: 'desc' }, select: { analysisJson: true } });
    if (!analysis?.analysisJson) throw new Error('that video has no analysis');
    const frames = playwrightFrames(workspaceId);
    try { show(await ingestGalleryFrames(await liveDeps(workspaceId), workspaceId, videoId, JSON.parse(analysis.analysisJson), frames.extract)); } finally { await frames.close(); }
  } else if (command === 'commons') {
    show([await ingestCommonsFile(await liveDeps(workspaceId), workspaceId, (u, init) => fetch(u, init), { title: need('title'), personName: need('person'), sex: flag('sex') as 'male' | 'female' | undefined })]);
  } else if (command === 'synthetic') {
    const count = Number(need('count'));
    if (!Number.isInteger(count) || count < 1 || count > 40) throw new Error('--count must be 1..40');
    if (!has('yes')) throw new Error(`this spends image-model credits (${count} generations); pass --yes to proceed`);
    show(await ingestSyntheticFaces(await liveDeps(workspaceId), workspaceId, need('batch'), count, async i => {
      const sex = i % 2 ? 'woman' : 'man';
      const img = await generateOpenRouterImage({
        prompt: `Photorealistic studio side-profile portrait of a fictional adult ${sex}, head and shoulders, facing right, plain grey background, ear, jaw and chin fully visible, hair off the face, neutral expression, no glasses, no text, not a real person.`,
        quality: 'medium', aspectRatio: '3:4',
      });
      return new Uint8Array(img.buffer);
    }));
  } else {
    console.error('commands: list | calibrate | gallery-frames | commons | synthetic'); process.exit(2);
  }
}

main().then(() => process.exit(0), err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
