import {Audio} from '@remotion/media';
import {getAudioDurationInSeconds} from '@remotion/media-utils';
import {linearTiming, TransitionSeries} from '@remotion/transitions';
import {slide} from '@remotion/transitions/slide';
import React, {useMemo} from 'react';
import {AbsoluteFill, CalculateMetadataFunction, Sequence, staticFile, useVideoConfig} from 'remotion';
import {z} from 'zod';
import {BeatView} from './components/BeatView';
import {stillSrc} from './components/Card';
import {Footer, Header, type Word} from './components/Text';
import {parseScript, type Landmarks, type Resolved, Script} from './schema';
import {theme} from './theme';

export type ReelProps = z.input<typeof Script> & {debug?: boolean; resolved?: Resolved};

type Timing = {beats: {file: string; vo: string; seconds: number; lead: number; trail: number; words?: Word[]}[]};

// Average of the stills' background colours: the canvas behind cards, splits and grids.
const averageHex = (hexes: string[]) => {
  if (!hexes.length) return theme.canvas.background;
  const rgb = [0, 1, 2].map((c) => hexes.reduce((s, h) => s + parseInt(h.slice(1 + c * 2, 3 + c * 2), 16), 0) / hexes.length);
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
};

const split = (props: ReelProps) => {
  const {debug, resolved, ...raw} = props;
  return {debug, resolved, script: parseScript(raw)};
};

const getJson = async <T,>(path: string): Promise<T | null> => {
  const r = await fetch(staticFile(path));
  if (!r.ok) return null;
  try {
    return (await r.json()) as T;
  } catch {
    return null; // dev server answers unknown paths with HTML
  }
};

// Duration = measured voice clips (minus their silent lead/trail) + 0.3 s tail per beat, minus push overlaps.
export const calculateMetadata: CalculateMetadataFunction<ReelProps> = async ({props}) => {
  const {script} = split(props);
  const fps = theme.canvas.fps;
  const timing = await getJson<Timing>(`${script.id}/timing.json`);
  if (!timing) throw new Error(`assets/${script.id}/timing.json missing. Run: npx tsx tools/tts.ts ${script.id}`);
  const seconds = await Promise.all(
    script.beats.map(async (b, i) => {
      const t = timing.beats[i];
      if (!t || t.vo !== b.vo) throw new Error(`Beat ${i + 1} voice is stale. Run: npx tsx tools/tts.ts ${script.id}`);
      const d = await getAudioDurationInSeconds(staticFile(t.file));
      return d - t.lead - t.trail;
    }),
  );
  const beatFrames = seconds.map((s) => Math.ceil((s + theme.audio.tailSeconds) * fps));
  const push = theme.transition.pushFrames;
  const beatStarts: number[] = [];
  beatFrames.forEach((_, i) => {
    beatStarts.push(i === 0 ? 0 : beatStarts[i - 1] + beatFrames[i - 1] - (script.beats[i].transition === 'push' ? push : 0));
  });
  const total = beatStarts[beatStarts.length - 1] + beatFrames[beatFrames.length - 1];

  const landmarks: Record<string, Landmarks> = {};
  await Promise.all(
    Object.entries(script.faces).map(async ([k, p]) => {
      const lm = await getJson<Landmarks>(p.replace(/^assets\//, '').replace(/\.(png|jpe?g)$/i, '.landmarks.json'));
      if (lm) {
        // Landmark files carry {source: "llm" | "llm-retry" | "mediapipe"} next to the points.
        const {source: _source, ...points} = lm as Landmarks & {source?: string};
        void _source;
        landmarks[k] = points;
      }
    }),
  );
  const audio = timing.beats.map((t) => t.file);
  const leads = timing.beats.map((t) => t.lead);
  // Subtitle word times relative to the beat start (the clip's silent lead is trimmed off).
  const words = timing.beats.map((t) => (t.words ?? []).map((w) => ({...w, start: w.start - t.lead, end: w.end - t.lead})));
  const meta = (await getJson<Record<string, {bg: string}>>(`${script.id}/stills.json`)) ?? {};
  const bg: Record<string, string> = {_reel: averageHex(Object.values(meta).map((m) => m.bg))};
  for (const [k, m] of Object.entries(meta)) bg[k] = m.bg;
  const resolved: Resolved = {beatFrames, beatStarts, audio, leads, words, bg, landmarks, total};
  return {durationInFrames: total, fps, width: theme.canvas.width, height: theme.canvas.height, props: {...props, resolved}, defaultOutName: script.id};
};

const Flash: React.FC = () => <AbsoluteFill style={{background: theme.color.white}} />;

export const Reel: React.FC<ReelProps> = (props) => {
  const {fps} = useVideoConfig();
  const {script, resolved, debug} = useMemo(() => split(props), [props]);
  if (!resolved) throw new Error('Reel rendered without calculateMetadata');
  const {beatFrames, beatStarts, landmarks} = resolved;
  const timing = resolved.audio;
  const sfx = theme.audio.sfx;

  return (
    <AbsoluteFill style={{background: resolved.bg._reel}}>
      <TransitionSeries>
        {script.beats.flatMap((b, i) => {
          const nodes: React.ReactNode[] = [];
          if (i > 0 && b.transition === 'push') {
            nodes.push(
              <TransitionSeries.Transition
                key={`t${i}`}
                presentation={slide({direction: 'from-right'})}
                timing={linearTiming({durationInFrames: theme.transition.pushFrames})}
              />,
            );
          }
          if (i > 0 && b.transition === 'flash') {
            nodes.push(
              <TransitionSeries.Overlay key={`o${i}`} durationInFrames={theme.transition.flashFrames}>
                <Flash />
              </TransitionSeries.Overlay>,
            );
          }
          nodes.push(
            <TransitionSeries.Sequence key={`b${i}`} name={`Beat ${i + 1}: ${b.caption.replace(/\*/g, '')}`} durationInFrames={beatFrames[i]}>
              <BeatView beat={b} script={script} landmarks={landmarks} bg={resolved.bg} words={resolved.words[i] ?? []} frames={beatFrames[i]} index={i} debug={debug} />
            </TransitionSeries.Sequence>,
          );
          return nodes;
        })}
      </TransitionSeries>
      {script.header ? <Header text={script.header} /> : null}
      <Footer />

      {/* Voice: one clip per beat, starting on the beat's first frame */}
      {script.beats.map((b, i) => {
        const t = timing[i];
        return t ? (
          <Sequence key={`v${i}`} name={`VO ${i + 1}`} from={beatStarts[i]} durationInFrames={beatFrames[i]} layout="none">
            <Audio src={stillSrc(`assets/${t}`)} volume={theme.audio.voiceVolume} trimBefore={Math.round(resolved.leads[i] * fps)} />
          </Sequence>
        ) : null;
      })}
      {/* Cut SFX: whoosh on pushes, click on hard cuts and flashes */}
      {script.beats.map((b, i) =>
        i === 0 ? null : b.transition === 'push' ? (
          sfx.whoosh ? (
            <Sequence key={`w${i}`} from={beatStarts[i] - 2} durationInFrames={12} layout="none">
              <Audio src={stillSrc('assets/sfx/whoosh.mp3')} volume={theme.audio.sfxVolume} />
            </Sequence>
          ) : null
        ) : sfx.click ? (
          <Sequence key={`c${i}`} from={beatStarts[i]} durationInFrames={Math.round(fps * 0.1)} layout="none">
            <Audio src={stillSrc('assets/sfx/click.mp3')} volume={theme.audio.sfxVolume} />
          </Sequence>
        ) : null,
      )}
    </AbsoluteFill>
  );
};
