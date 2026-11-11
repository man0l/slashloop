import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { MONO, SANS, SERIF } from './fonts';

export const W = 1080;
export const H = 1920;
export const FPS = 30;

const BLUSH = '#f3e4df';
const INK = '#2b1016';
const RED = '#c4122f';
const CREAM = '#fffaf6';

// ------------------------------------------------------------------ types

type Box = { x: number; y: number; w: number; h: number };
interface Manifest {
  base: { w: number; h: number };
  shades: Record<string, string>;
  lips: Box;
  vo: Record<string, { file: string; text: string; durationSec: number }>;
  music: string | null;
  sfx: Record<'pop' | 'whoosh' | 'tick', string>;
  stock: Record<string, { file: string; durationSec: number }>;
}
interface Shade {
  id: string;
  label: string;
  swatch: string;
}
interface Citation {
  authors: string;
  title: string;
  journal: string;
  titleIsSummary?: boolean;
}
interface Content {
  shades: Shade[];
  reds: Shade[];
  citations: Record<'gueguen' | 'tian', Citation>;
  comments: [string, string];
  /** Optional on-screen text per beat when it should differ from the spoken line (e.g. "2023"). */
  captions?: Partial<Record<string, string>>;
}
export type Props = { manifest: Manifest; content: Content };

const BEATS = ['hook', 'answer', 'method', 'result', 'reds', 'pivot', 'cta'] as const;
type Beat = (typeof BEATS)[number];
const GAP = 0.25;
const HOLD: Partial<Record<Beat, number>> = { hook: 0.9, cta: 2.2 }; // let the pick land / the end breathe

export function timeline(m: Manifest) {
  let t = 0;
  const beats = {} as Record<Beat, { from: number; dur: number }>;
  for (const b of BEATS) {
    const dur = Math.round((m.vo[b].durationSec + GAP + (HOLD[b] ?? 0)) * FPS);
    beats[b] = { from: t, dur };
    t += dur;
  }
  return { beats, total: t };
}

// ------------------------------------------------------------------ helpers

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const usePop = (delay = 0, damping = 14) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping, stiffness: 160 } });
};

/** Show a photo so that box `focus` (normalised) fills a viewport of size vw×vh, centred. */
const Portrait: React.FC<{
  m: Manifest;
  shade: string;
  vw: number;
  vh: number;
  focus: { cx: number; cy: number; scale: number };
  style?: React.CSSProperties;
}> = ({ m, shade, vw, vh, focus, style }) => {
  const imgW = vw * focus.scale;
  const imgH = (imgW * m.base.h) / m.base.w;
  return (
    <Img
      src={staticFile(m.shades[shade])}
      style={{
        position: 'absolute',
        width: imgW,
        height: imgH,
        left: vw / 2 - focus.cx * imgW,
        top: vh / 2 - focus.cy * imgH,
        ...style,
      }}
    />
  );
};

const faceFocus = (m: Manifest, scale = 1.25) => ({ cx: m.lips.x + m.lips.w / 2, cy: m.lips.y - 0.06, scale });
const lipFocus = (m: Manifest, scale = 4.2) => ({ cx: m.lips.x + m.lips.w / 2, cy: m.lips.y + m.lips.h / 2, scale });

/** Word-by-word captions in chunks of up to 4 words; the spoken word turns red. */
const Captions: React.FC<{ text: string; durationSec: number; y?: number; dark?: boolean }> = ({ text, durationSec, y = 1600, dark }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(/\s+/);
  const weights = words.map((w) => w.replace(/[^\w']/g, '').length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  const starts = weights.map((w) => {
    const s = (acc / total) * durationSec * fps;
    acc += w;
    return s;
  });
  const current = Math.max(0, starts.findLastIndex((s) => frame >= s));
  const chunkStart = Math.floor(current / 4) * 4;
  return (
    <div
      style={{
        position: 'absolute',
        top: y,
        left: 70,
        right: 70,
        textAlign: 'center',
        fontFamily: SANS,
        fontWeight: 800,
        fontSize: 64,
        lineHeight: 1.12,
        letterSpacing: -1,
        color: dark ? INK : CREAM,
        textShadow: dark ? 'none' : '0 4px 22px rgba(0,0,0,0.55)',
      }}
    >
      {words.slice(chunkStart, chunkStart + 4).map((w, i) => {
        const idx = chunkStart + i;
        return (
          <span key={idx} style={{ color: idx === current ? RED : undefined, opacity: frame >= starts[idx] ? 1 : 0.25, marginRight: 16 }}>
            {w}
          </span>
        );
      })}
    </div>
  );
};

const Kicker: React.FC<{ children: React.ReactNode; top?: number; color?: string }> = ({ children, top = 150, color = INK }) => {
  const p = usePop(0, 18);
  return (
    <div
      style={{
        position: 'absolute',
        top,
        width: '100%',
        textAlign: 'center',
        fontFamily: SERIF,
        fontSize: 92,
        lineHeight: 1.02,
        color,
        opacity: p,
        transform: `translateY(${(1 - p) * -24}px)`,
      }}
    >
      {children}
    </div>
  );
};

const Label: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{ fontFamily: MONO, fontSize: 26, letterSpacing: 4, textTransform: 'uppercase', ...style }}>{children}</div>
);

const Sfx: React.FC<{ id: keyof Manifest['sfx']; m: Manifest; at?: number; volume?: number }> = ({ id, m, at = 0, volume = 1 }) => (
  <Sequence from={at} durationInFrames={20} layout="none">
    <Audio src={staticFile(m.sfx[id])} volume={volume} />
  </Sequence>
);

const CitationCard: React.FC<{ c: Citation; delay?: number; top?: number }> = ({ c, delay = 0, top = 1180 }) => {
  const p = usePop(delay, 15);
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: 90,
        right: 90,
        padding: '30px 36px',
        borderRadius: 26,
        background: CREAM,
        color: INK,
        boxShadow: '0 30px 70px rgba(43,16,22,0.35)',
        transform: `translateX(${(1 - p) * 900}px) rotate(${(1 - p) * 6 - 1.2}deg)`,
      }}
    >
      <Label style={{ color: RED, fontSize: 22 }}>{c.titleIsSummary ? 'Peer-reviewed study' : 'The study'}</Label>
      <div style={{ fontFamily: SERIF, fontSize: 46, lineHeight: 1.1, margin: '10px 0 14px', fontStyle: c.titleIsSummary ? 'normal' : 'italic' }}>
        {c.titleIsSummary ? c.title : `“${c.title}”`}
      </div>
      <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 28 }}>{c.authors}</div>
      <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: 24, opacity: 0.7 }}>{c.journal}</div>
    </div>
  );
};

const Framed: React.FC<{ src: string; top: number; height: number; startFrom?: number; tint?: number; position?: string }> = ({
  src,
  top,
  height,
  startFrom = 0,
  tint = 0,
  position = 'center',
}) => {
  const p = usePop(0, 16);
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: 70,
        right: 70,
        height,
        borderRadius: 44,
        overflow: 'hidden',
        boxShadow: '0 30px 70px rgba(43,16,22,0.3)',
        transform: `scale(${0.85 + 0.15 * p})`,
        opacity: p,
      }}
    >
      <OffthreadVideo src={staticFile(src)} muted startFrom={startFrom} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: position }} />
      {tint > 0 && <AbsoluteFill style={{ background: `rgba(43,16,22,${tint})` }} />}
    </div>
  );
};

// ------------------------------------------------------------------ beats

/** 1. Same woman, four lipsticks — a selector hops between tiles and lands on red. */
const Hook: React.FC<Props & { dur: number }> = ({ manifest: m, content: c, dur }) => {
  const frame = useCurrentFrame();
  const tile = 450;
  const gap = 30;
  const left0 = (W - 2 * tile - gap) / 2;
  const top0 = 470;
  // selector: visits tiles 0→1→2→3→0→1→2→3 (red), speeding up, then rests
  const hops = [0, 1, 2, 0, 1, 2, 3];
  const hopEnd = dur - 30;
  const hopTimes = hops.map((_, i) => Math.round(hopEnd * Math.pow((i + 1) / hops.length, 0.7)) - 20);
  const hopIdx = Math.max(0, hopTimes.findLastIndex((t) => frame >= t));
  const sel = frame >= hopTimes[0] ? hops[hopIdx] : -1;
  const landed = frame >= hopTimes[hops.length - 1];
  return (
    <AbsoluteFill style={{ background: BLUSH }}>
      <Kicker top={150}>
        Same woman.
        <br />
        <span style={{ color: RED, fontStyle: 'italic' }}>4 lipsticks.</span>
      </Kicker>
      {c.shades.map((s, i) => {
        const x = left0 + (i % 2) * (tile + gap);
        const y = top0 + Math.floor(i / 2) * (tile + 90);
        const on = sel === i;
        const dim = landed && s.id !== 'red';
        return (
          <TileIn key={s.id} delay={4 + i * 4}>
            <div
              style={{
                position: 'absolute',
                left: x,
                top: y,
                width: tile,
                height: tile,
                borderRadius: 34,
                overflow: 'hidden',
                outline: on ? `10px solid ${RED}` : '0px solid transparent',
                outlineOffset: -2,
                transform: `scale(${on && landed ? 1.04 : 1})`,
                filter: dim ? 'grayscale(0.7) brightness(0.8)' : 'none',
                transition: 'none',
              }}
            >
              <Portrait m={m} shade={s.id} vw={tile} vh={tile} focus={faceFocus(m, 1.45)} />
            </div>
            <div style={{ position: 'absolute', left: x, top: y + tile + 16, width: tile, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
              <div style={{ width: 30, height: 30, borderRadius: 30, background: s.swatch, border: '3px solid #fff' }} />
              <Label style={{ color: INK, fontSize: 26 }}>{s.label}</Label>
            </div>
          </TileIn>
        );
      })}
      {hopTimes.map((t, i) => (
        <Sfx key={i} id={i === hops.length - 1 ? 'pop' : 'tick'} m={m} at={t} />
      ))}
      <Captions text={m.vo.hook.text} durationSec={m.vo.hook.durationSec} y={1640} dark />
    </AbsoluteFill>
  );
};

const TileIn: React.FC<{ delay: number; children: React.ReactNode }> = ({ delay, children }) => {
  const p = usePop(delay, 13);
  return <AbsoluteFill style={{ opacity: p, transform: `translateY(${(1 - p) * 60}px)` }}>{children}</AbsoluteFill>;
};

/** 2. Zoom into red + the field study citation. */
const Answer: React.FC<Props> = ({ manifest: m, content: c }) => {
  const frame = useCurrentFrame();
  const z = interpolate(frame, [0, 90], [1.25, 1.45], clamp);
  return (
    <AbsoluteFill style={{ background: BLUSH }}>
      <Portrait m={m} shade="red" vw={W} vh={H} focus={{ ...faceFocus(m, z), cy: faceFocus(m).cy + 0.02 }} />
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(43,16,22,0.35), rgba(43,16,22,0) 30%, rgba(43,16,22,0) 55%, rgba(43,16,22,0.7))' }} />
      <Kicker top={140} color={CREAM}>
        You picked <span style={{ fontStyle: 'italic' }}>red?</span>
      </Kicker>
      <CitationCard c={c.citations.gueguen} delay={10} top={1150} />
      <Sfx id="whoosh" m={m} at={8} />
      <Captions text={m.vo.answer.text} durationSec={m.vo.answer.durationSec} y={1640} />
    </AbsoluteFill>
  );
};

/** 3. The experiment: bar footage + the four shades cycling on her lips. */
const Method: React.FC<Props & { dur: number }> = ({ manifest: m, content: c, dur }) => {
  const frame = useCurrentFrame();
  const per = dur / c.shades.length;
  const idx = Math.min(c.shades.length - 1, Math.floor(frame / per));
  const circle = 420;
  return (
    <AbsoluteFill style={{ background: BLUSH }}>
      <Label style={{ position: 'absolute', top: 120, width: '100%', textAlign: 'center', color: RED }}>The bar experiment</Label>
      <Kicker top={170}>4 shades, real bars</Kicker>
      <Framed src={m.stock.bar.file} top={320} height={560} startFrom={30} />
      {/* lip close-up cycling through the shades */}
      <div style={{ position: 'absolute', top: 930, left: 90, width: circle, height: circle, borderRadius: circle, overflow: 'hidden', border: `8px solid ${CREAM}`, boxShadow: '0 24px 60px rgba(43,16,22,0.3)' }}>
        {c.shades.map((s, i) => (
          <div key={s.id} style={{ position: 'absolute', inset: 0, opacity: i === idx ? 1 : 0 }}>
            <Portrait m={m} shade={s.id} vw={circle} vh={circle} focus={lipFocus(m, 3.6)} />
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', top: 960, left: 560, right: 70, display: 'flex', flexDirection: 'column', gap: 22 }}>
        {c.shades.map((s, i) => {
          const on = i === idx;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 18, opacity: on ? 1 : 0.45, transform: `translateX(${on ? 12 : 0}px)` }}>
              <div style={{ width: on ? 64 : 46, height: on ? 64 : 46, borderRadius: 64, background: s.swatch, border: `4px solid ${CREAM}`, boxShadow: on ? `0 0 0 4px ${RED}` : 'none' }} />
              <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: on ? 44 : 36, color: INK }}>{s.label}</div>
            </div>
          );
        })}
      </div>
      {c.shades.map((s, i) => (i > 0 ? <Sfx key={s.id} id="tick" m={m} at={Math.round(i * per)} /> : null))}
      <Captions text={m.vo.method.text} durationSec={m.vo.method.durationSec} y={1440} dark />
    </AbsoluteFill>
  );
};

/** 4. Result: red won on both measures. */
const Result: React.FC<Props> = ({ manifest: m }) => {
  const stats = [
    { k: 'Most men approached', v: 'Red', delay: 12 },
    { k: 'First approach came sooner', v: 'Red', delay: 40 },
  ];
  return (
    <AbsoluteFill style={{ background: INK }}>
      <OffthreadVideo src={staticFile(m.stock.approach.file)} muted startFrom={60} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(43,16,22,0.75), rgba(43,16,22,0.15) 40%, rgba(43,16,22,0.85))' }} />
      <Kicker top={150} color={CREAM}>
        The result <span style={{ fontStyle: 'italic' }}>💋</span>
      </Kicker>
      {stats.map((s, i) => (
        <StatCard key={s.k} {...s} top={360 + i * 220} />
      ))}
      <Sfx id="pop" m={m} at={12} />
      <Sfx id="pop" m={m} at={40} />
      <Captions text={m.vo.result.text} durationSec={m.vo.result.durationSec} y={1600} />
    </AbsoluteFill>
  );
};

const StatCard: React.FC<{ k: string; v: string; delay: number; top: number }> = ({ k, v, delay, top }) => {
  const p = usePop(delay, 13);
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: 90,
        right: 90,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '30px 40px',
        borderRadius: 30,
        background: 'rgba(255,250,246,0.94)',
        transform: `scale(${p})`,
        opacity: p,
      }}
    >
      <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 38, color: INK, maxWidth: 560 }}>{k}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 54, height: 54, borderRadius: 54, background: RED }} />
        <div style={{ fontFamily: SERIF, fontSize: 64, color: RED }}>{v}</div>
      </div>
    </div>
  );
};

/** 5. Not all reds are equal: true red vs orange-red vs cameo red on her. */
const Reds: React.FC<Props & { dur: number }> = ({ manifest: m, content: c, dur }) => {
  const frame = useCurrentFrame();
  const intro = 50; // red close-up b-roll first
  const per = (dur - intro - 40) / c.reds.length;
  const idx = frame < intro ? -1 : Math.min(c.reds.length - 1, Math.floor((frame - intro) / per));
  const settled = frame >= intro + per * c.reds.length; // back on true red, crowned
  const shown = settled ? 0 : idx;
  const z = interpolate(frame, [intro, dur], [2.3, 2.6], clamp);
  return (
    <AbsoluteFill style={{ background: BLUSH }}>
      {frame < intro + 8 && (
        <AbsoluteFill style={{ opacity: interpolate(frame, [intro - 4, intro + 8], [1, 0], clamp) }}>
          <OffthreadVideo src={staticFile(m.stock.redclose.file)} muted startFrom={90} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </AbsoluteFill>
      )}
      {frame >= intro - 4 && (
        <AbsoluteFill style={{ opacity: interpolate(frame, [intro - 4, intro + 8], [0, 1], clamp) }}>
          {c.reds.map((r, i) => (
            <div key={r.id} style={{ position: 'absolute', inset: 0, opacity: i === shown ? 1 : 0 }}>
              <Portrait m={m} shade={r.id} vw={W} vh={H} focus={{ ...lipFocus(m, z), cy: lipFocus(m).cy - 0.035 }} />
            </div>
          ))}
          <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(43,16,22,0.55), rgba(43,16,22,0) 28%, rgba(43,16,22,0) 60%, rgba(43,16,22,0.75))' }} />
          <Kicker top={130} color={CREAM}>
            Not every red <span style={{ fontStyle: 'italic' }}>wins</span>
          </Kicker>
          <div style={{ position: 'absolute', top: 1130, left: 60, right: 60, display: 'flex', justifyContent: 'space-between' }}>
            {c.reds.map((r, i) => {
              const on = i === shown;
              return (
                <div key={r.id} style={{ width: 300, textAlign: 'center', opacity: on ? 1 : 0.55 }}>
                  <div style={{ margin: '0 auto', width: on ? 130 : 100, height: on ? 130 : 100, borderRadius: 130, background: r.swatch, border: `6px solid ${CREAM}`, boxShadow: on ? `0 0 0 6px ${RED}` : 'none' }} />
                  <div style={{ fontFamily: SANS, fontWeight: 800, fontSize: 36, color: CREAM, marginTop: 14 }}>{r.label}</div>
                  {settled && i === 0 && <Crown />}
                </div>
              );
            })}
          </div>
          <div style={{ position: 'absolute', top: 1470, width: '100%', textAlign: 'center', fontFamily: MONO, fontSize: 24, color: CREAM, opacity: 0.85 }}>
            {c.citations.tian.authors} · Frontiers in Neuroscience
          </div>
        </AbsoluteFill>
      )}
      <Sfx id="whoosh" m={m} at={intro - 6} />
      {c.reds.map((r, i) => (i > 0 ? <Sfx key={r.id} id="tick" m={m} at={Math.round(intro + i * per)} /> : null))}
      <Sfx id="pop" m={m} at={Math.round(intro + per * c.reds.length)} />
      <Captions text={c.captions?.reds ?? m.vo.reds.text} durationSec={m.vo.reds.durationSec} y={1600} />
    </AbsoluteFill>
  );
};

const Crown: React.FC = () => {
  const p = usePop(0, 10);
  return (
    <div style={{ marginTop: 10, display: 'inline-block', padding: '8px 18px', borderRadius: 999, background: RED, color: CREAM, fontFamily: SANS, fontWeight: 800, fontSize: 26, transform: `scale(${p})` }}>
      rated most attractive
    </div>
  );
};

/** 6. Pivot: wear what you like. */
const Pivot: React.FC<Props> = ({ manifest: m }) => (
  <AbsoluteFill style={{ background: BLUSH }}>
    <Kicker top={150}>
      Your pick <span style={{ color: RED }}>&gt;</span>
      <br />
      <span style={{ fontStyle: 'italic' }}>their pick</span>
    </Kicker>
    <Framed src={m.stock.mirror.file} top={430} height={1000} startFrom={45} position="78% center" />
    <Captions text={m.vo.pivot.text} durationSec={m.vo.pivot.durationSec} y={1530} dark />
  </AbsoluteFill>
);

/** 7. CTA: which shade are you wearing? */
const Cta: React.FC<Props> = ({ manifest: m, content: c }) => {
  const all = [...c.shades.filter((s) => s.id !== 'red'), ...c.reds];
  const size = 300;
  return (
    <AbsoluteFill style={{ background: BLUSH }}>
      <Kicker top={140}>
        Which one are
        <br />
        <span style={{ color: RED, fontStyle: 'italic' }}>you wearing?</span>
      </Kicker>
      <div style={{ position: 'absolute', top: 430, left: 55, right: 55, display: 'flex', flexWrap: 'wrap', gap: 30, justifyContent: 'center' }}>
        {all.map((s, i) => (
          <CtaTile key={s.id} m={m} shade={s} size={size} delay={4 + i * 3} />
        ))}
      </div>
      <Bubble text={c.comments[0]} x={80} y={1290} delay={26} m={m} />
      <Bubble text={c.comments[1]} x={330} y={1420} delay={44} m={m} />
      <Captions text={m.vo.cta.text} durationSec={m.vo.cta.durationSec} y={1610} dark />
    </AbsoluteFill>
  );
};

const CtaTile: React.FC<{ m: Manifest; shade: Shade; size: number; delay: number }> = ({ m, shade, size, delay }) => {
  const p = usePop(delay, 13);
  return (
    <div style={{ width: size, transform: `scale(${p})`, opacity: p }}>
      <div style={{ position: 'relative', width: size, height: size * 0.62, borderRadius: 28, overflow: 'hidden', border: `4px solid ${CREAM}` }}>
        <Portrait m={m} shade={shade.id} vw={size} vh={size * 0.62} focus={lipFocus(m, 2.8)} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 10 }}>
        <div style={{ width: 22, height: 22, borderRadius: 22, background: shade.swatch }} />
        <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 28, color: INK }}>{shade.label}</div>
      </div>
    </div>
  );
};

const Bubble: React.FC<{ text: string; x: number; y: number; delay: number; m: Manifest }> = ({ text, x, y, delay, m }) => {
  const p = usePop(delay, 12);
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '16px 28px 16px 16px',
          borderRadius: 999,
          background: CREAM,
          boxShadow: '0 16px 36px rgba(43,16,22,0.2)',
          fontFamily: SANS,
          fontWeight: 700,
          fontSize: 36,
          color: INK,
          transform: `scale(${p})`,
          transformOrigin: 'left center',
        }}
      >
        <div style={{ width: 52, height: 52, borderRadius: 52, background: `linear-gradient(135deg, ${RED}, #f08aa0)` }} />
        {text}
      </div>
      <Sfx id="pop" m={m} at={delay} volume={0.8} />
    </>
  );
};

// ------------------------------------------------------------------ composition

const SCENES: Record<Beat, React.FC<Props & { dur: number }>> = {
  hook: Hook,
  answer: Answer,
  method: Method,
  result: Result,
  reds: Reds,
  pivot: Pivot,
  cta: Cta,
};

export const Lipstick: React.FC<Props> = (props) => {
  const { manifest: m } = props;
  const { beats, total } = timeline(m);
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: BLUSH }}>
      {BEATS.map((b, i) => {
        const Scene = SCENES[b];
        const { from, dur } = beats[b];
        return (
          <Sequence key={b} from={from} durationInFrames={dur}>
            <SceneIn first={i === 0}>
              <Scene {...props} dur={dur} />
            </SceneIn>
            <Audio src={staticFile(m.vo[b].file)} />
            {i > 0 && <Sfx id="whoosh" m={m} volume={0.6} />}
          </Sequence>
        );
      })}
      {m.music && (
        <Audio
          src={staticFile(m.music)}
          loop
          volume={(f) => interpolate(f, [0, 12, total - 40, total], [0, 0.13, 0.13, 0], clamp)}
        />
      )}
      {/* thin progress bar */}
      <div style={{ position: 'absolute', top: 0, left: 0, height: 8, width: `${(frame / total) * 100}%`, background: RED }} />
    </AbsoluteFill>
  );
};

/** Quick push-in + fade on every scene change. */
const SceneIn: React.FC<{ first: boolean; children: React.ReactNode }> = ({ first, children }) => {
  const frame = useCurrentFrame();
  if (first) return <>{children}</>;
  const t = interpolate(frame, [0, 9], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  return <AbsoluteFill style={{ opacity: t, transform: `scale(${1.06 - 0.06 * t})` }}>{children}</AbsoluteFill>;
};
