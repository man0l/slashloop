// Render a reel to out/<id>.mp4, then a 2x3 contact sheet (6 evenly spaced frames) to out/<id>-sheet.png,
// and append wall time + peak RAM to out/render-log.md.
// Usage: npx tsx tools/render.ts R01 [--debug] [--sheet-only]
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import sharp from 'sharp';
import {abs, args, balance, loadScript, log, spendSoFar} from './lib';

// Sum RSS of a process and all its descendants (Linux /proc).
const treeRss = (pid: number): number => {
  const kids = new Map<number, number[]>();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const ppid = Number(fs.readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
      kids.set(ppid, [...(kids.get(ppid) ?? []), Number(d)]);
    } catch {
      /* process exited */
    }
  }
  let total = 0;
  const walk = (p: number) => {
    try {
      const m = fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
      if (m) total += Number(m[1]) * 1024;
    } catch {
      /* gone */
    }
    for (const k of kids.get(p) ?? []) walk(k);
  };
  walk(pid);
  return total;
};

const run = (cmd: string, argv: string[]) =>
  new Promise<{ms: number; peak: number}>((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(cmd, argv, {cwd: abs('.'), stdio: ['ignore', 'inherit', 'inherit']});
    let peak = 0;
    const iv = setInterval(() => (peak = Math.max(peak, treeRss(child.pid!))), 250);
    child.on('exit', (code) => {
      clearInterval(iv);
      if (code === 0) resolve({ms: Date.now() - t0, peak});
      else reject(new Error(`${cmd} ${argv.join(' ')} exited ${code}`));
    });
  });

const frameCount = (file: string) =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file])
      .toString()
      .trim(),
  );

const main = async () => {
  const {pos, flags} = args();
  const script = loadScript(pos[0] ?? 'R01');
  const id = script.id;
  const debug = flags.has('--debug');
  const name = debug ? `${id}-debug` : id;
  const props = `./scripts/${id}.json`;
  const mp4 = `out/${name}.mp4`;
  fs.mkdirSync(abs('out'), {recursive: true});
  const bal0 = await balance();

  let r = {ms: 0, peak: 0};
  if (!flags.has('--sheet-only')) {
    // Debug renders go through the Review/<id>-debug composition (landmark dots on).
    const comp = debug ? `${id}-debug` : 'Reel';
    const argv = ['remotion', 'render', 'src/index.ts', comp, ...(debug ? [] : [`--props=${props}`]), '--output', mp4, '--codec', 'h264', '--crf', '18', '--concurrency', '4'];
    log(`npx ${argv.join(' ')}`);
    r = await run('npx', argv);
    log(`rendered ${mp4} in ${(r.ms / 1000).toFixed(1)} s, peak RAM ${(r.peak / 2 ** 30).toFixed(2)} GiB`);
  }

  // Contact sheet: bundle once, then `remotion still` per frame.
  const total = frameCount(abs(mp4));
  const frames = Array.from({length: 6}, (_, i) => Math.floor(((i + 0.5) * total) / 6));
  const tmp = abs(`out/.sheet-${name}`);
  fs.rmSync(tmp, {recursive: true, force: true});
  fs.mkdirSync(tmp, {recursive: true});
  execFileSync('npx', ['remotion', 'bundle', 'src/index.ts', '--out-dir', 'build'], {cwd: abs('.'), stdio: 'ignore'});
  const comp = debug ? `${id}-debug` : 'Reel';
  for (const f of frames) {
    execFileSync('npx', ['remotion', 'still', 'build', comp, `${tmp}/${f}.png`, `--frame=${f}`, ...(debug ? [] : [`--props=${props}`])], {
      cwd: abs('.'),
      stdio: 'ignore',
    });
  }
  const [tw, th] = [540, 960];
  const tiles = await Promise.all(frames.map((f) => sharp(`${tmp}/${f}.png`).resize(tw, th).toBuffer()));
  const label = (f: number) =>
    Buffer.from(
      `<svg width="${tw}" height="44"><rect width="150" height="44" rx="8" fill="rgba(11,31,58,.8)"/><text x="12" y="30" font-size="24" font-family="monospace" fill="#fff">${(f / 30).toFixed(1)}s</text></svg>`,
    );
  await sharp({create: {width: tw * 2, height: th * 3, channels: 3, background: '#0B1F3A'}})
    .composite(tiles.flatMap((t, i) => [
      {input: t, left: (i % 2) * tw, top: Math.floor(i / 2) * th},
      {input: label(frames[i]), left: (i % 2) * tw + 10, top: Math.floor(i / 2) * th + 10},
    ]))
    .png()
    .toFile(abs(`out/${name}-sheet.png`));
  fs.rmSync(tmp, {recursive: true, force: true});
  log(`contact sheet out/${name}-sheet.png (frames ${frames.join(', ')})`);

  if (!flags.has('--sheet-only')) {
    const logFile = abs('out/render-log.md');
    if (!fs.existsSync(logFile)) {
      fs.writeFileSync(
        logFile,
        '# Render log\n\n| reel | rendered (UTC) | length | frames | render wall time | peak RAM | OpenRouter spend (reel, cumulative) | balance | QA FAILs |\n|---|---|---|---|---|---|---|---|---|\n',
      );
    }
    const qaPath = abs(`assets/${id}/qa.json`);
    const qa = fs.existsSync(qaPath) ? (JSON.parse(fs.readFileSync(qaPath, 'utf8')) as Record<string, {verdict: string; reason: string}>) : {};
    const fails = Object.entries(qa).filter(([, v]) => v.verdict === 'FAIL').map(([k, v]) => `${k}: ${v.reason}`).join('; ') || 'none';
    const row = `| ${name} | ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | ${(total / 30).toFixed(1)} s | ${total} | ${(r.ms / 1000).toFixed(1)} s | ${(r.peak / 2 ** 30).toFixed(2)} GiB | $${spendSoFar(id).toFixed(3)} ($${spendSoFar().toFixed(3)}) | ${bal0 === null ? '?' : `$${bal0.toFixed(2)}`} | ${fails} |\n`;
    fs.appendFileSync(logFile, row);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
