// Background colour of every still (median of patches along the top edge), written to assets/<reel>/stills.json.
// Full-bleed beats paint the canvas in this colour so the photo blends into it with no visible edge.
// Usage: npx tsx tools/still-meta.ts R01   (gen-stills runs it automatically)
import fs from 'node:fs';
import sharp from 'sharp';
import {abs, args, loadScript, log} from './lib';

const hex = (v: number[]) => '#' + v.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

export const stillMeta = async (reel: string) => {
  const script = loadScript(reel);
  const out: Record<string, {bg: string}> = {};
  for (const [k, rel] of Object.entries(script.faces)) {
    const file = abs(rel);
    if (!fs.existsSync(file)) continue;
    const img = sharp(file);
    const {width = 1080} = await img.metadata();
    const xs = [0.02, 0.1, 0.88, 0.96].map((f) => Math.floor(f * width));
    const samples: number[][] = [];
    for (const x of xs) {
      const {data} = await sharp(file).extract({left: x, top: 12, width: 24, height: 24}).raw().toBuffer({resolveWithObject: true});
      const n = data.length / 3;
      const sum = [0, 0, 0];
      for (let i = 0; i < data.length; i += 3) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
      samples.push(sum.map((s) => s / n));
    }
    const median = [0, 1, 2].map((c) => samples.map((s) => s[c]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]);
    out[k] = {bg: hex(median)};
  }
  fs.writeFileSync(abs(`assets/${script.id}/stills.json`), JSON.stringify(out, null, 2));
  log(`${script.id}: background colours for ${Object.keys(out).length} stills`);
};

if (require.main === module) {
  stillMeta(args().pos[0] ?? 'R01').catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
