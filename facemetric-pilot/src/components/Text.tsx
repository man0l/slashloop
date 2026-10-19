import {loadFont} from '@remotion/fonts';
import React from 'react';
import {interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {clampChip} from '../geometry';
import {hlColor, theme, type Hl} from '../theme';

// Inter is bundled (assets/fonts, from @fontsource/inter) instead of fetched from Google Fonts at render time:
// renders then need no network, which also suits a cloud renderer.
export const fontFamily = 'Inter';
for (const w of ['500', '700', '800']) {
  loadFont({family: fontFamily, url: staticFile(`fonts/inter-latin-${w}-normal.woff2`), weight: w, format: 'woff2'});
}

type Tone = 'white' | 'teal' | 'purple' | 'yellow' | 'navy';
const toneStyle = (tone: Tone = 'white') => {
  const c = theme.color;
  if (tone === 'white') return {background: c.white, color: c.navy};
  if (tone === 'yellow') return {background: c.yellow, color: c.navy};
  if (tone === 'navy') return {background: c.navy, color: c.white};
  return {background: c[tone], color: c.white};
};

// Splits "A **WORD** B" into plain / highlighted runs.
const runs = (s: string) => s.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((r) => (r.startsWith('**') ? {hl: true, t: r.slice(2, -2)} : {hl: false, t: r}));

export const Caption: React.FC<{text: string; pos: 'top' | 'bottom'; hl: Hl; from?: number}> = ({text, pos, hl, from = 0}) => {
  const frame = useCurrentFrame() - from;
  const {fps} = useVideoConfig();
  if (frame < 0) return null;
  const c = theme.caption;
  const s = spring({frame, fps, config: {damping: 14, stiffness: 260}, durationInFrames: theme.motion.captionPopFrames + 3});
  return (
    <div
      style={{
        position: 'absolute',
        left: (theme.canvas.width - c.maxWidth) / 2,
        width: c.maxWidth,
        ...(pos === 'top' ? {top: c.topY} : {bottom: theme.canvas.height - c.bottomY}),
        textAlign: 'center',
        fontFamily,
        fontWeight: c.fontWeight,
        fontSize: c.fontSize,
        lineHeight: c.lineHeight,
        textTransform: 'uppercase',
        color: theme.color.white,
        WebkitTextStroke: `${c.stroke * 2}px ${theme.color.navy}`,
        paintOrder: 'stroke fill',
        letterSpacing: c.letterSpacing,
        wordSpacing: c.wordSpacing,
        scale: String(interpolate(s, [0, 1], [0.86, 1])),
        opacity: interpolate(frame, [0, 2], [0, 1], {extrapolateRight: 'clamp'}),
        transformOrigin: pos === 'top' ? '50% 0%' : '50% 100%',
        display: '-webkit-box',
        WebkitLineClamp: c.maxLines,
        WebkitBoxOrient: 'vertical',
        overflow: 'visible',
      }}
    >
      {runs(text).map((r, i) => (
        <span key={i} style={r.hl ? {color: hlColor(hl)} : undefined}>
          {r.t}
        </span>
      ))}
    </div>
  );
};

// A pill that pops in with the brief's spring (damping 12, stiffness 180, scale 0.6 -> 1).
// anchor: 'center' centres the pill on (x, y); 'left' puts its left edge at x.
export const Chip: React.FC<{
  text: string;
  x: number;
  y: number;
  from: number;
  tone?: Tone;
  anchor?: 'center' | 'left' | 'right';
  rotate?: number;
}> = ({text, x, y, from, tone, anchor = 'center', rotate}) => {
  const frame = useCurrentFrame() - from;
  const {fps} = useVideoConfig();
  if (frame < 0) return null;
  const k = theme.chip;
  const s = spring({frame, fps, config: k.spring, durationInFrames: theme.motion.maxEaseFrames});
  const [cx, cy] = anchor === 'center' && !rotate ? clampChip(x, y, text) : [x, y];
  const tx = anchor === 'center' ? '-50%' : anchor === 'right' ? '-100%' : '0%';
  return (
    <div
      style={{
        position: 'absolute',
        left: cx,
        top: cy,
        translate: `${tx} -50%`,
        rotate: rotate ? `${rotate}deg` : undefined,
        scale: String(interpolate(s, [0, 1], [k.fromScale, 1])),
        opacity: interpolate(frame, [0, 2], [0, 1], {extrapolateRight: 'clamp'}),
        transformOrigin: anchor === 'center' ? '50% 50%' : anchor === 'left' ? '0% 50%' : '100% 50%',
        padding: `${k.padY}px ${k.padX}px`,
        borderRadius: 999,
        boxShadow: k.shadow,
        fontFamily,
        fontWeight: k.fontWeight,
        fontSize: k.fontSize,
        lineHeight: 1.1,
        whiteSpace: 'nowrap',
        textTransform: 'uppercase',
        ...toneStyle(tone),
      }}
    >
      {text}
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
      fontFamily,
      fontWeight: theme.footer.fontWeight,
      fontSize: theme.footer.fontSize,
      color: theme.color.navy,
      opacity: theme.footer.opacity,
    }}
  >
    {theme.footer.text}
  </div>
);
