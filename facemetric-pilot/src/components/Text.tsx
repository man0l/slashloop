import {loadFont} from '@remotion/fonts';
import React from 'react';
import {interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {clampChip} from '../geometry';
import {hlColor, theme, type Hl} from '../theme';

// Fonts are bundled in assets/fonts (from @fontsource) rather than fetched from Google Fonts at render time:
// renders then need no network, which also suits a cloud renderer.
const fonts: [string, string, string][] = [
  [theme.font.headline, '400', 'anton-latin-400-normal'],
  [theme.font.ui, '700', 'montserrat-latin-700-normal'],
  [theme.font.ui, '800', 'montserrat-latin-800-normal'],
  [theme.font.ui, '900', 'montserrat-latin-900-normal'],
];
for (const [family, weight, file] of fonts) {
  loadFont({family, url: staticFile(`fonts/${file}.woff2`), weight, format: 'woff2'});
}
export const fontFamily = theme.font.ui;

export type Tone = 'white' | 'teal' | 'purple' | 'yellow' | 'navy';

// Splits "A **WORD** B" into plain / highlighted runs.
const runs = (s: string) =>
  s
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((r) => (r.startsWith('**') ? {hl: true, t: r.slice(2, -2)} : {hl: false, t: r}));

// Top headline: navy condensed caps, highlighted words in colour (or on a yellow box), optional draw-on underline.
export const Headline: React.FC<{text: string; hl: Hl; underline?: boolean; from?: number}> = ({text, hl, underline, from = 0}) => {
  const frame = useCurrentFrame() - from;
  const {fps} = useVideoConfig();
  if (frame < 0) return null;
  const h = theme.headline;
  const s = spring({frame, fps, config: {damping: 14, stiffness: 260}, durationInFrames: theme.motion.headlinePopFrames + 3});
  const draw = interpolate(frame, [4, 12], [0, 100], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div
      style={{
        position: 'absolute',
        left: (theme.canvas.width - h.maxWidth) / 2,
        width: h.maxWidth,
        top: h.top,
        textAlign: 'center',
        fontFamily: theme.font.headline,
        fontSize: h.fontSize,
        lineHeight: h.lineHeight,
        textTransform: 'uppercase',
        color: theme.color.navy,
        WebkitTextStroke: `${h.stroke * 2}px ${theme.color.white}`,
        paintOrder: 'stroke fill',
        scale: String(interpolate(s, [0, 1], [0.9, 1])),
        opacity: interpolate(frame, [0, 2], [0, 1], {extrapolateRight: 'clamp'}),
        transformOrigin: '50% 0%',
      }}
    >
      {runs(text).map((r, i) =>
        r.hl ? (
          <span
            key={i}
            style={{
              position: 'relative',
              color: hl === 'yellow' ? theme.color.navy : hlColor(hl),
              background: hl === 'yellow' ? theme.color.yellow : undefined,
              WebkitTextStroke: hl === 'yellow' ? '0px transparent' : undefined,
              padding: hl === 'yellow' ? '0 10px' : undefined,
              borderRadius: 10,
            }}
          >
            {r.t}
            {underline ? (
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  bottom: -h.underline - 4,
                  height: h.underline,
                  width: `${draw}%`,
                  borderRadius: h.underline,
                  background: hl === 'yellow' ? theme.color.navy : hlColor(hl),
                  boxShadow: `0 0 0 3px ${theme.color.white}`,
                }}
              />
            ) : null}
          </span>
        ) : (
          <span key={i}>{r.t}</span>
        ),
      )}
    </div>
  );
};

export type Word = {w: string; start: number; end: number};

// Group words into subtitle chunks: up to maxWords / maxChars, breaking after punctuation.
const chunk = (words: Word[]) => {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const len = [...cur, w].map((x) => x.w).join(' ').length;
    if (cur.length && (cur.length >= theme.subtitle.maxWords || len > theme.subtitle.maxChars)) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
    if (/[,.:;?!]$/.test(w.w)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
};

// Voice-synced subtitles. Times are seconds from the beat start.
export const Subtitles: React.FC<{words: Word[]}> = ({words}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const t = frame / fps;
  const chunks = chunk(words);
  if (!chunks.length) return null;
  let ci = chunks.findIndex((c, i) => t >= c[0].start - 0.05 && (i === chunks.length - 1 || t < chunks[i + 1][0].start - 0.05));
  if (ci < 0) ci = t < chunks[0][0].start ? 0 : chunks.length - 1;
  const c = chunks[ci];
  const st = theme.subtitle;
  const activeIdx = c.reduce((a, w, i) => (t >= w.start - 0.03 ? i : a), 0);
  const popFrame = Math.round(c[0].start * fps);
  const pop = interpolate(frame, [popFrame - 1, popFrame + 3], [0.88, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div
      style={{
        position: 'absolute',
        left: 40,
        right: 40,
        top: st.centerY,
        translate: '0 -50%',
        textAlign: 'center',
        fontFamily: theme.font.ui,
        fontWeight: st.fontWeight,
        fontSize: st.fontSize,
        lineHeight: 1.25,
        textTransform: 'uppercase',
        scale: String(pop),
      }}
    >
      {c.map((w, i) => {
        const active = i === activeIdx;
        return (
          <React.Fragment key={i}>
            <span
              style={{
                display: 'inline-block',
                padding: `0 ${st.boxPadX}px`,
                borderRadius: st.boxRadius,
                background: active ? theme.color.yellow : 'transparent',
                color: active ? theme.color.navy : theme.color.white,
                WebkitTextStroke: active ? '0px transparent' : `${st.stroke * 2}px ${theme.color.navy}`,
                paintOrder: 'stroke fill',
                textShadow: active ? 'none' : '0 4px 10px rgba(0,0,0,.45), 0 1px 2px rgba(0,0,0,.6)',
              }}
            >
              {w.w.replace(/[,.:;!]$/, '')}
            </span>{' '}
          </React.Fragment>
        );
      })}
    </div>
  );
};

const Check: React.FC<{color: string}> = ({color}) => {
  const s = theme.chip.checkSize;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" style={{marginLeft: 10, flexShrink: 0}}>
      <circle cx="12" cy="12" r="11" fill={color} />
      <path d="M7 12.5 L10.5 16 L17 8.5" fill="none" stroke="#fff" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

const toneStyle = (tone: Tone = 'white') => {
  const c = theme.color;
  if (tone === 'white') return {background: c.white, color: c.navy, borderColor: c.navy};
  if (tone === 'yellow') return {background: c.yellow, color: c.navy, borderColor: c.navy};
  if (tone === 'navy') return {background: c.navy, color: c.white, borderColor: c.white};
  return {background: c.white, color: c.navy, borderColor: c[tone]};
};

// A pill that pops in with the brief's spring (damping 12, stiffness 180, scale 0.6 -> 1).
// anchor: 'center' centres the pill on (x, y); 'left' / 'right' put that edge at x.
export const Chip: React.FC<{
  text: string;
  x: number;
  y: number;
  from: number;
  tone?: Tone;
  check?: boolean;
  anchor?: 'center' | 'left' | 'right';
  small?: boolean;
}> = ({text, x, y, from, tone, check, anchor = 'center', small}) => {
  const frame = useCurrentFrame() - from;
  const {fps} = useVideoConfig();
  if (frame < 0) return null;
  const k = theme.chip;
  const s = spring({frame, fps, config: k.spring, durationInFrames: theme.motion.maxEaseFrames});
  const [cx, cy] = anchor === 'center' ? clampChip(x, y, text, check) : [x, y];
  const tx = anchor === 'center' ? '-50%' : anchor === 'right' ? '-100%' : '0%';
  const ts = toneStyle(tone);
  const checkColor = tone === 'purple' ? theme.color.purple : theme.color.check;
  const scale = small ? 0.8 : 1;
  return (
    <div
      style={{
        position: 'absolute',
        left: cx,
        top: cy,
        translate: `${tx} -50%`,
        scale: String(interpolate(s, [0, 1], [k.fromScale, 1]) * scale),
        opacity: interpolate(frame, [0, 2], [0, 1], {extrapolateRight: 'clamp'}),
        transformOrigin: anchor === 'center' ? '50% 50%' : anchor === 'left' ? '0% 50%' : '100% 50%',
        display: 'flex',
        alignItems: 'center',
        padding: `${k.padY}px ${check ? k.padY + 2 : k.padX}px ${k.padY}px ${k.padX}px`,
        borderRadius: 999,
        border: `${k.border}px solid ${ts.borderColor}`,
        boxShadow: k.shadow,
        fontFamily: theme.font.ui,
        fontWeight: k.fontWeight,
        fontSize: k.fontSize,
        lineHeight: 1.1,
        letterSpacing: 0.5,
        whiteSpace: 'nowrap',
        textTransform: 'uppercase',
        background: ts.background,
        color: ts.color,
      }}
    >
      {text}
      {check ? <Check color={checkColor} /> : null}
    </div>
  );
};

export const Footer: React.FC = () => (
  <div
    style={{
      position: 'absolute',
      bottom: theme.footer.bottom,
      width: '100%',
      textAlign: 'center',
      fontFamily: theme.font.ui,
      fontWeight: theme.footer.fontWeight,
      fontSize: theme.footer.fontSize,
      color: theme.color.white,
      opacity: theme.footer.opacity,
      textShadow: '0 1px 3px rgba(0,0,0,.5)',
    }}
  >
    {theme.footer.text}
  </div>
);
