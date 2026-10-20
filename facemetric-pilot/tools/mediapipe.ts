// MediaPipe Face Landmarker fallback for front stills (brief 9.1). Runs @mediapipe/tasks-vision (WASM) inside the
// pre-installed headless Chromium, serving the wasm, model and image from disk, and maps the 478-point mesh to our
// landmark names. _L / _R = left / right side of the IMAGE (the subject's right eye is on the image left).
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {abs} from './lib';

const MODEL = abs('.cache/face_landmarker.task');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const CHROME = process.env.FM_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

type P = {x: number; y: number};
const mid = (a: P, b: P): [number, number] => [(a.x + b.x) / 2, (a.y + b.y) / 2];
const at = (p: P): [number, number] => [p.x, p.y];

// Mesh indices (canonical MediaPipe face mesh + iris refinement) -> our names.
export const fromMesh = (m: P[]): Record<string, [number, number]> => {
  const ringL = [469, 470, 471, 472].map((i) => m[i]);
  const ringR = [474, 475, 476, 477].map((i) => m[i]);
  const out: Record<string, [number, number]> = {
    hairline: at(m[10]), // top of the mesh: upper forehead, just under the hairline
    glabella: at(m[9]),
    brow_inner_L: at(m[107]),
    brow_outer_L: at(m[70]),
    brow_inner_R: at(m[336]),
    brow_outer_R: at(m[300]),
    canthus_inner_L: at(m[133]),
    canthus_outer_L: at(m[33]),
    canthus_inner_R: at(m[362]),
    canthus_outer_R: at(m[263]),
    upper_lid_L: at(m[159]),
    lower_lid_L: at(m[145]),
    upper_lid_R: at(m[386]),
    lower_lid_R: at(m[374]),
    iris_centre_L: at(m[468]),
    iris_centre_R: at(m[473]),
    pupil_L: at(m[468]),
    pupil_R: at(m[473]),
    iris_edge_L: at(ringL.reduce((a, b) => (b.x < a.x ? b : a))), // outer (image-left) edge of the iris
    iris_edge_R: at(ringR.reduce((a, b) => (b.x > a.x ? b : a))),
    sclera_L: mid(m[468], m[33]),
    sclera_R: mid(m[473], m[263]),
    nose_tip: at(m[1]),
    subnasale: at(m[2]),
    upper_lip_top: at(m[0]),
    stomion: mid(m[13], m[14]),
    cheilion_L: at(m[61]),
    cheilion_R: at(m[291]),
    pogonion: at(m[199]),
    chin_bottom: at(m[152]),
    jaw_angle_L: at(m[172]),
    jaw_angle_R: at(m[397]),
    cheek_L: at(m[116]),
    cheek_R: at(m[345]),
    cheek_top_L: at(m[118]),
    cheek_top_R: at(m[347]),
  };
  for (const k of Object.keys(out)) out[k] = [+out[k][0].toFixed(4), +out[k][1].toFixed(4)];
  return out;
};

const PAGE = `<!doctype html><html><body><script type="module">
import {FilesetResolver, FaceLandmarker} from 'http://mp.local/vision_bundle.mjs';
const files = await FilesetResolver.forVisionTasks('http://mp.local/wasm');
const lm = await FaceLandmarker.createFromOptions(files, {baseOptions: {modelAssetPath: 'http://mp.local/model.task', delegate: 'CPU'}, runningMode: 'IMAGE', numFaces: 1});
window.detect = async (url) => {
  const img = new Image(); img.src = url; await img.decode();
  const r = lm.detect(img);
  return r.faceLandmarks[0] ? r.faceLandmarks[0].map((p) => ({x: p.x, y: p.y})) : null;
};
window.ready = true;
</script></body></html>`;

// Detect landmarks on several stills with one browser. Returns null for a still where no face was found.
export const mediapipeLandmarks = async (files: string[]): Promise<(Record<string, [number, number]> | null)[]> => {
  if (!fs.existsSync(MODEL)) {
    fs.mkdirSync(path.dirname(MODEL), {recursive: true});
    fs.writeFileSync(MODEL, Buffer.from(await (await fetch(MODEL_URL)).arrayBuffer()));
  }
  const pkg = abs('node_modules/@mediapipe/tasks-vision');
  const browser = await chromium.launch({executablePath: CHROME, args: ['--no-sandbox']});
  try {
    const page = await browser.newPage();
    await page.route('http://mp.local/**', async (route) => {
      const u = new URL(route.request().url());
      const p = decodeURIComponent(u.pathname);
      const file =
        p === '/page.html' ? null
        : p === '/model.task' ? MODEL
        : p.startsWith('/img/') ? files[Number(p.slice(5))]
        : path.join(pkg, p);
      if (file === null) return route.fulfill({contentType: 'text/html', body: PAGE});
      const type = file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('js') ? 'text/javascript' : file.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream';
      return route.fulfill({contentType: type, body: fs.readFileSync(file), headers: {'Access-Control-Allow-Origin': '*'}});
    });
    await page.goto('http://mp.local/page.html');
    await page.waitForFunction('window.ready === true', null, {timeout: 120_000});
    const out: (Record<string, [number, number]> | null)[] = [];
    for (let i = 0; i < files.length; i++) {
      const mesh = (await page.evaluate((u) => (window as unknown as {detect: (u: string) => Promise<P[] | null>}).detect(u), `http://mp.local/img/${i}`)) as P[] | null;
      out.push(mesh ? fromMesh(mesh) : null);
    }
    return out;
  } finally {
    await browser.close();
  }
};

if (require.main === module) {
  mediapipeLandmarks(process.argv.slice(2).map((f) => path.resolve(f))).then((r) => console.log(JSON.stringify(r, null, 1).slice(0, 1500)));
}
