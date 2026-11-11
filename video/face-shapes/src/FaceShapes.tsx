import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { MONO, SANS, SERIF } from './fonts';
import { FaceBox, ShapeId, toPath } from './shapes';


export const W = 1080;
export const H = 1920;
export const FPS = 30;

const INK = '#13201c';
const CREAM = '#fbf7ee';
const ACCENT = '#f3c969';

// ---------------------------------------------------------------- types / timing

type Pt = { x: number; y: number };
export interface Manifest {
  base: { file: string; w: number; h: number };
  landmarks: Record<string, Pt>;
  celebs: Record<string, { file: string; name: string; source: string }>;
  vo: Record<string, { file: string; text: string; durationSec: number }>;
  music: string | null;
}
export interface Shape {
  id: ShapeId;
  name: string;
  celeb: string;
  role: string;
  line: string;
  reveal?: boolean;
}
export interface Content {
  title: [string, string];
  baseFace: { cropBottom?: number };
  shapes: Shape[];
  comments: [string, string];
}
export type Props = {
  manifest: Manifest;
  content: Content;
};

const GAP = 0.3; // seconds of air after each voice line
const OUTRO_HOLD = 2.6; // seconds the grid stays up after the CTA line

export function timeline(m: Manifest, c: Content) {
  const sec = (s: number) => Math.round(s * FPS);
  const segs: { id: string; from: number; dur: number }[] = [];
  let t = 0;
  for (const id of ['hook', ...c.shapes.map((s) => s.id)]) {
    const d = sec(m.vo[id].durationSec + GAP);
    segs.push({ id, from: t, dur: d });
    t += d;
  }
  const outro = { id: 'cta', from: t, dur: sec(m.vo.cta.durationSec + OUTRO_HOLD) };
  return { segs, outro, total: t + outro.dur };
}

// ---------------------------------------------------------------- geometry

/**
 * Cover-fit the base image into the frame, ignoring the bottom `cropBottom`
 * fraction (image models often leave a band there). Returns the <Img> rect and
 * a mapper from normalised image coords to frame pixels.
 */
function coverLayout(img: { w: number; h: number }, cropBottom = 0) {
  const visibleH = img.h * (1 - cropBottom);
  const scale = Math.max(W / img.w, H / visibleH);
  const rect = { left: (W - img.w * scale) / 2, top: (H - visibleH * scale) / 2, width: img.w * scale, height: img.h * scale };
  const map = (p: Pt) => ({ x: rect.left + p.x * rect.width, y: rect.top + p.y * rect.height });
  return { rect, map };
}

function faceBox(m: Manifest, cropBottom: number): FaceBox {
  const { map } = coverLayout(m.base, cropBottom);
  const L = Object.fromEntries(Object.entries(m.landmarks).map(([k, v]) => [k, map(v)]));
  const cheekL = L.cheekL.x;
  const cheekR = L.cheekR.x;
  return {
    cx: (cheekL + cheekR) / 2,
    top: L.hairline.y,
    height: L.chin.y - L.hairline.y,
    halfWidth: (cheekR - cheekL) / 2,
  };
}

// ---------------------------------------------------------------- pieces

const Outline: React.FC<{ id: ShapeId; box: FaceBox; delay?: number; stroke?: number; color?: string }> = ({
  id,
  box,
  delay = 4,
  stroke = 5,
  color = CREAM,
}) => {
  const frame = useCurrentFrame();
  const draw = interpolate(frame - delay, [0, 22], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const d = toPath(id, box);
  const maskId = `m-${id}-${Math.round(box.cx)}-${Math.round(box.top)}`;
  return (
    <svg width={W} height={H} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          {/* a solid copy of the path drawn on progressively reveals the dotted line */}
          <path d={d} pathLength={1} fill="none" stroke="#fff" strokeWidth={stroke * 4} strokeDasharray={`${draw} 1`} />
        </mask>
      </defs>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={`0.1 ${stroke * 2.6}`}
        mask={`url(#${maskId})`}
        style={{ filter: 'drop-shadow(0 0 6px rgba(0,0,0,0.35))' }}
      />
    </svg>
  );
};

const Title: React.FC<{ lines: [string, string] }> = ({ lines }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 200 } });
  // second line: put the "face shapes" phrase in the serif italic
  const match = lines[1].match(/\d+ face shapes/)?.[0] ?? '';
  const [pre, post = ''] = match ? lines[1].split(match) : [lines[1]];
  return (
    <div
      style={{
        position: 'absolute',
        top: 150,
        width: '100%',
        textAlign: 'center',
        color: CREAM,
        fontFamily: SANS,
        fontWeight: 700,
        fontSize: 64,
        lineHeight: 1.08,
        letterSpacing: -1.5,
        opacity: s,
        transform: `translateY(${(1 - s) * -30}px)`,
        textShadow: '0 4px 24px rgba(0,0,0,0.25)',
      }}
    >
      <div>{lines[0]}</div>
      <div>
        {pre}
        <span style={{ fontFamily: SERIF, fontStyle: 'italic', fontWeight: 600, color: ACCENT, fontSize: 76 }}>
          {match}
        </span>
        {post}
      </div>
    </div>
  );
};

/** Word-by-word captions; words are timed proportionally to their length. */
const Captions: React.FC<{ text: string; durationSec: number; y?: number }> = ({ text, durationSec, y = 1520 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(/\s+/);
  const weights = words.map((w) => w.length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  const starts: number[] = [];
  let acc = 0;
  for (const w of weights) {
    starts.push((acc / total) * durationSec * fps);
    acc += w;
  }
  // show a sliding window of ~4 words: the current chunk
  const current = Math.max(0, starts.findLastIndex((s) => frame >= s));
  const chunkStart = Math.floor(current / 4) * 4;
  const chunk = words.slice(chunkStart, chunkStart + 4);
  return (
    <div
      style={{
        position: 'absolute',
        top: y,
        width: '100%',
        padding: '0 80px',
        textAlign: 'center',
        fontFamily: SERIF,
        fontStyle: 'italic',
        fontWeight: 600,
        fontSize: 68,
        lineHeight: 1.15,
        color: CREAM,
        textShadow: '0 3px 18px rgba(0,0,0,0.6)',
      }}
    >
      {chunk.map((w, i) => {
        const idx = chunkStart + i;
        const on = frame >= starts[idx];
        return (
          <span key={idx} style={{ opacity: on ? 1 : 0.28, color: idx === current ? ACCENT : CREAM, marginRight: 18 }}>
            {w}
          </span>
        );
      })}
    </div>
  );
};

const CelebCard: React.FC<{ shape: Shape; img: string; index: number; count: number }> = ({ shape, img, index, count }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14, stiffness: 160 } });
  return (
    <div
      style={{
        position: 'absolute',
        left: 34,
        top: 660,
        width: 210,
        transform: `translateX(${(1 - pop) * -320}px)`,
        opacity: pop,
      }}
    >
      <div style={{ fontFamily: MONO, fontSize: 24, color: CREAM, opacity: 0.85, letterSpacing: 2 }}>
        {String(index + 1).padStart(2, '0')} / {String(count).padStart(2, '0')}
      </div>
      <div
        style={{
          fontFamily: SERIF,
          fontStyle: 'italic',
          fontWeight: 600,
          fontSize: 58,
          color: ACCENT,
          margin: '4px 0 12px',
          textShadow: '0 3px 14px rgba(0,0,0,0.35)',
        }}
      >
        {shape.name}
      </div>
      <Img
        src={staticFile(img)}
        style={{
          width: 196,
          height: 196,
          objectFit: 'cover',
          borderRadius: 24,
          border: `4px solid ${CREAM}`,
          boxShadow: '0 18px 40px rgba(0,0,0,0.35)',
        }}
      />
      <div style={{ fontFamily: MONO, fontSize: 20, color: CREAM, marginTop: 12, lineHeight: 1.35, textTransform: 'uppercase' }}>
        {shape.celeb}
        <br />
        <span style={{ opacity: 0.7 }}>{shape.role}</span>
      </div>
    </div>
  );
};

const RevealBadge: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - 40, fps, config: { damping: 12 } });
  return (
    <div
      style={{
        position: 'absolute',
        right: 60,
        top: 690,
        padding: '16px 26px',
        borderRadius: 999,
        background: ACCENT,
        color: INK,
        fontFamily: SANS,
        fontWeight: 800,
        fontSize: 34,
        transform: `scale(${s}) rotate(${(1 - s) * 12}deg)`,
        boxShadow: '0 12px 30px rgba(0,0,0,0.3)',
      }}
    >
      ✓ his real shape
    </div>
  );
};

// ---------------------------------------------------------------- outro grid

/** Approximate face box inside a square head-crop thumbnail. */
const thumbBox = (size: number): FaceBox => ({ cx: size / 2, top: size * 0.24, height: size * 0.62, halfWidth: size * 0.29 });

const Outro: React.FC<{ manifest: Manifest; content: Content }> = ({ manifest, content }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tile = 300;
  const gap = 36;
  const cols = 3;
  const items = [...content.shapes.map((s) => ({ shape: s })), { shape: null }];
  const gridW = cols * tile + (cols - 1) * gap;
  const left0 = (W - gridW) / 2;
  const top0 = 400;
  const bg = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: `rgba(19,32,28,${0.86 * bg})` }} />
      <div
        style={{
          position: 'absolute',
          top: 170,
          width: '100%',
          textAlign: 'center',
          fontFamily: SERIF,
          fontStyle: 'italic',
          fontWeight: 600,
          fontSize: 92,
          color: CREAM,
          opacity: bg,
        }}
      >
        Which one <span style={{ color: ACCENT }}>are you?</span>
      </div>
      {items.map((it, i) => {
        // 7 shapes + a "you" tile → 3/3/2 rows, last row centred
        const row = Math.floor(i / cols);
        const inRow = row < 2 ? cols : items.length - 2 * cols;
        const col = i % cols;
        const rowLeft = left0 + ((cols - inRow) * (tile + gap)) / 2;
        const x = rowLeft + col * (tile + gap);
        const y = top0 + row * (tile + 92);
        const s = spring({ frame: frame - 4 - i * 3, fps, config: { damping: 15 } });
        return (
          <div key={i} style={{ position: 'absolute', left: x, top: y, width: tile, transform: `scale(${s})`, opacity: s }}>
            <div style={{ position: 'relative', width: tile, height: tile, borderRadius: 32, overflow: 'hidden', background: '#2b3a35' }}>
              {it.shape ? (
                <>
                  <Img src={staticFile(manifest.celebs[it.shape.id].file)} style={{ width: tile, height: tile, objectFit: 'cover' }} />
                  <div style={{ position: 'absolute', inset: 0, transform: `scale(${tile / W})`, transformOrigin: '0 0' }}>
                    {/* outline is authored in frame space; scale the tile's face box up to it */}
                    <Outline id={it.shape.id} box={scaleBox(thumbBox(tile), W / tile)} delay={14 + i * 3} stroke={22} />
                  </div>
                </>
              ) : (
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: SERIF,
                    fontStyle: 'italic',
                    fontSize: 180,
                    color: ACCENT,
                    border: `4px dashed ${ACCENT}`,
                    borderRadius: 32,
                    boxSizing: 'border-box',
                  }}
                >
                  ?
                </div>
              )}
            </div>
            <div
              style={{
                marginTop: 12,
                textAlign: 'center',
                fontFamily: SANS,
                fontWeight: 800,
                letterSpacing: 3,
                fontSize: 30,
                color: it.shape ? CREAM : ACCENT,
              }}
            >
              {it.shape ? it.shape.name.toUpperCase() : 'YOU'}
            </div>
          </div>
        );
      })}
      <Comment text={content.comments[0]} x={70} y={1500} delay={30} />
      <Comment text={content.comments[1]} x={360} y={1640} delay={48} />
    </AbsoluteFill>
  );
};

function scaleBox(b: FaceBox, k: number): FaceBox {
  return { cx: b.cx * k, top: b.top * k, height: b.height * k, halfWidth: b.halfWidth * k };
}

const Comment: React.FC<{ text: string; x: number; y: number; delay: number }> = ({ text, x, y, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 13 } });
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '18px 30px 18px 18px',
        borderRadius: 999,
        background: CREAM,
        color: INK,
        fontFamily: SANS,
        fontWeight: 700,
        fontSize: 38,
        transform: `scale(${s})`,
        transformOrigin: 'left center',
        boxShadow: '0 14px 34px rgba(0,0,0,0.35)',
      }}
    >
      <div style={{ width: 56, height: 56, borderRadius: 999, background: 'linear-gradient(135deg,#f3c969,#e07a5f)' }} />
      {text}
    </div>
  );
};

// ---------------------------------------------------------------- composition

export const FaceShapes: React.FC<Props> = ({ manifest, content }) => {
  const frame = useCurrentFrame();
  const { segs, outro, total } = timeline(manifest, content);
  const crop = content.baseFace.cropBottom ?? 0;
  const box = faceBox(manifest, crop);
  const { rect } = coverLayout(manifest.base, crop);
  // slow push-in on the base portrait across the whole piece
  const zoom = interpolate(frame, [0, total], [1, 1.06]);
  return (
    <AbsoluteFill style={{ background: '#8fa69b' }}>
      <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: `${box.cx}px ${box.top + box.height / 2}px` }}>
        <Img src={staticFile(manifest.base.file)} style={{ position: 'absolute', ...rect }} />
        {segs.slice(1).map((seg) => (
          <Sequence key={seg.id} from={seg.from} durationInFrames={seg.dur} layout="none">
            <Outline id={seg.id as ShapeId} box={box} />
          </Sequence>
        ))}
      </AbsoluteFill>

      {/* soft vignette so white type always reads */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(180deg, rgba(10,20,17,0.45) 0%, rgba(10,20,17,0) 22%, rgba(10,20,17,0) 70%, rgba(10,20,17,0.55) 100%)',
        }}
      />

      <Sequence durationInFrames={outro.from} layout="none">
        <Title lines={content.title} />
      </Sequence>

      {segs.map((seg, i) => {
        const shape = content.shapes[i - 1];
        return (
          <Sequence key={seg.id} from={seg.from} durationInFrames={seg.dur}>
            {shape && (
              <CelebCard shape={shape} img={manifest.celebs[shape.id].file} index={i - 1} count={content.shapes.length} />
            )}
            {shape?.reveal && <RevealBadge />}
            <Captions text={manifest.vo[seg.id].text} durationSec={manifest.vo[seg.id].durationSec} />
            <Audio src={staticFile(manifest.vo[seg.id].file)} />
          </Sequence>
        );
      })}

      <Sequence from={outro.from} durationInFrames={outro.dur}>
        <Outro manifest={manifest} content={content} />
        <Captions text={manifest.vo.cta.text} durationSec={manifest.vo.cta.durationSec} y={1790} />
        <Audio src={staticFile(manifest.vo.cta.file)} />
      </Sequence>

      {manifest.music && (
        <Audio
          src={staticFile(manifest.music)}
          loop
          volume={(f) => interpolate(f, [0, 15, total - 30, total], [0, 0.16, 0.16, 0], { extrapolateRight: 'clamp' })}
        />
      )}
    </AbsoluteFill>
  );
};
