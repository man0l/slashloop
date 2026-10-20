import React from 'react';
import {Easing, interpolate, useCurrentFrame} from 'remotion';
import {resolvePoint, toCanvas, type CardRect, type Vec} from '../geometry';
import type {Anim, Landmarks} from '../schema';
import {theme} from '../theme';
import {Chip} from './Text';

const L = theme.line;

const progress = (frame: number) =>
  interpolate(frame, [0, L.drawFrames], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});

const Svg: React.FC<{children: React.ReactNode}> = ({children}) => (
  <svg
    width={theme.canvas.width}
    height={theme.canvas.height}
    style={{position: 'absolute', left: 0, top: 0, overflow: 'visible', filter: L.shadow}}
  >
    {children}
  </svg>
);

// Draw-on white stroke.
const Stroke: React.FC<{d: string; len: number; p: number}> = ({d, len, p}) => (
  <path d={d} fill="none" stroke={L.color} strokeWidth={L.width} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={len} strokeDashoffset={len * (1 - p)} />
);

const EndDot: React.FC<{c: Vec}> = ({c}) => (
  <circle cx={c[0]} cy={c[1]} r={L.endDot} fill={theme.color.check} stroke={L.color} strokeWidth={3} />
);

const dist = (a: Vec, b: Vec) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// Measure line: white line, end ticks, teal end dots. `arrow` swaps the end tick for an arrow head.
export const Measure: React.FC<{a: Vec; b: Vec; from: number; arrow?: boolean}> = ({a, b, from, arrow}) => {
  const frame = useCurrentFrame() - from;
  if (frame < 0) return null;
  const p = progress(frame);
  const len = dist(a, b);
  const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const [nx, ny] = [-uy * (L.tick / 2), ux * (L.tick / 2)];
  const tick = (c: Vec) => `M ${c[0] + nx} ${c[1] + ny} L ${c[0] - nx} ${c[1] - ny}`;
  const head = (c: Vec) =>
    `M ${c[0] - ux * L.tick + nx} ${c[1] - uy * L.tick + ny} L ${c[0]} ${c[1]} L ${c[0] - ux * L.tick - nx} ${c[1] - uy * L.tick - ny}`;
  const end: Vec = [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p];
  return (
    <Svg>
      <Stroke d={`M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}`} len={len} p={p} />
      {arrow ? null : <Stroke d={tick(a)} len={L.tick} p={1} />}
      {p > 0.9 ? <Stroke d={arrow ? head(end) : tick(end)} len={L.tick * 3} p={1} /> : null}
      {arrow ? null : <EndDot c={a} />}
      {!arrow && p > 0.9 ? <EndDot c={end} /> : null}
    </Svg>
  );
};

// Viewfinder corner brackets around a region (the reference's "box").
const Brackets: React.FC<{a: Vec; b: Vec; from: number}> = ({a, b, from}) => {
  const frame = useCurrentFrame() - from;
  if (frame < 0) return null;
  const p = progress(frame);
  const [x0, y0, x1, y1] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const k = Math.min(L.bracket, (x1 - x0) / 3, (y1 - y0) / 1.5) * p;
  // Brackets slide in from slightly outside the box as they draw.
  const o = (1 - p) * 18;
  const d = [
    `M ${x0 - o} ${y0 - o + k} V ${y0 - o} H ${x0 - o + k}`,
    `M ${x1 + o - k} ${y0 - o} H ${x1 + o} V ${y0 - o + k}`,
    `M ${x1 + o} ${y1 + o - k} V ${y1 + o} H ${x1 + o - k}`,
    `M ${x0 - o + k} ${y1 + o} H ${x0 - o} V ${y1 + o - k}`,
  ].join(' ');
  return (
    <Svg>
      <path d={d} fill="none" stroke={L.color} strokeWidth={L.width} strokeLinecap="round" strokeLinejoin="round" opacity={p > 0 ? 1 : 0} />
    </Svg>
  );
};

const Circle: React.FC<{c: Vec; r: number; from: number}> = ({c, r, from}) => {
  const frame = useCurrentFrame() - from;
  if (frame < 0) return null;
  const d = `M ${c[0]} ${c[1] - r} A ${r} ${r} 0 1 1 ${c[0] - 0.01} ${c[1] - r}`;
  return (
    <Svg>
      <Stroke d={d} len={2 * Math.PI * r} p={progress(frame)} />
    </Svg>
  );
};

// Dotted path: dots appear one after another along the polyline.
const Dots: React.FC<{pts: Vec[]; from: number}> = ({pts, from}) => {
  const frame = useCurrentFrame() - from;
  if (frame < 0) return null;
  const samples: Vec[] = [];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const len = dist(a, b);
    for (let s = carry; s <= len; s += L.dotSpacing) samples.push([a[0] + ((b[0] - a[0]) * s) / len, a[1] + ((b[1] - a[1]) * s) / len]);
    carry = (L.dotSpacing - ((len - carry) % L.dotSpacing)) % L.dotSpacing;
  }
  const shown = Math.ceil(samples.length * progress(frame));
  return (
    <Svg>
      {samples.slice(0, shown).map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={L.dotRadius} fill={L.color} />
      ))}
    </Svg>
  );
};

// One `anim` entry of a beat, starting at frame `from` of the beat. Chips without `at` are drawn by BeatView (stacked labels).
export const AnimView: React.FC<{anim: Anim; card: CardRect; lm: Landmarks | undefined; from: number}> = ({anim, card, lm, from}) => {
  const P = (p: Parameters<typeof resolvePoint>[0]) => toCanvas(card, resolvePoint(p, lm, card.key));
  const chipFrom = from + theme.stagger.chipDelay;
  const chipAt = 'chipAt' in anim && anim.chipAt ? P(anim.chipAt) : null;
  const tone = anim.tone;
  const small = card.w < 600;
  switch (anim.t) {
    case 'chip': {
      if (!anim.at) return null;
      const [x, y] = P(anim.at);
      return <Chip text={anim.text} x={x} y={y} from={from} tone={tone} check={anim.check} small={small} />;
    }
    case 'measure': {
      const a = P(anim.from);
      const b = P(anim.to);
      const mid: Vec = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const vertical = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
      let chip: React.ReactNode = null;
      if (anim.chip) {
        if (chipAt) chip = <Chip text={anim.chip} x={chipAt[0]} y={chipAt[1]} from={chipFrom} tone={tone} small={small} />;
        else if (vertical) {
          const right = mid[0] < theme.canvas.width / 2 + 120;
          chip = (
            <Chip text={anim.chip} x={right ? Math.max(a[0], b[0]) + 28 : Math.min(a[0], b[0]) - 28} y={mid[1]} from={chipFrom} tone={tone} anchor={right ? 'left' : 'right'} small={small} />
          );
        } else chip = <Chip text={anim.chip} x={mid[0]} y={Math.max(a[1], b[1]) + 48} from={chipFrom} tone={tone} small={small} />;
      }
      return (
        <>
          <Measure a={a} b={b} from={from} />
          {chip}
        </>
      );
    }
    case 'box': {
      const pad = (anim.pad ?? 0.03) * card.dw;
      const a0 = P(anim.from);
      const b0 = P(anim.to);
      const a: Vec = [Math.min(a0[0], b0[0]) - pad, Math.min(a0[1], b0[1]) - pad];
      const b: Vec = [Math.max(a0[0], b0[0]) + pad, Math.max(a0[1], b0[1]) + pad];
      const c = chipAt ?? ([a[0], a[1] + (b[1] - a[1]) / 2 + 60] as Vec);
      return (
        <>
          <Brackets a={a} b={b} from={from} />
          {anim.chip ? <Chip text={anim.chip} x={c[0]} y={c[1]} from={chipFrom} tone={tone} small={small} /> : null}
        </>
      );
    }
    case 'dots': {
      const pts = anim.path.map(P);
      const low = pts.reduce((m, p) => (p[1] > m[1] ? p : m), pts[0]);
      const c = chipAt ?? ([low[0], low[1] + 50] as Vec);
      return (
        <>
          <Dots pts={pts} from={from} />
          {anim.chip ? <Chip text={anim.chip} x={c[0]} y={c[1]} from={chipFrom} tone={tone} small={small} /> : null}
        </>
      );
    }
    case 'circle': {
      const c = P(anim.at);
      const r = anim.r * card.dw;
      const cc = chipAt ?? ([c[0], c[1] + r + 44] as Vec);
      return (
        <>
          <Circle c={c} r={r} from={from} />
          {anim.chip ? <Chip text={anim.chip} x={cc[0]} y={cc[1]} from={chipFrom} tone={tone} small={small} /> : null}
        </>
      );
    }
  }
};

// Debug: every landmark of the still as a dot with its name.
export const LandmarkDebug: React.FC<{card: CardRect; lm: Landmarks | undefined}> = ({card, lm}) => {
  if (!lm) return null;
  return (
    <svg width={theme.canvas.width} height={theme.canvas.height} style={{position: 'absolute', left: 0, top: 0}}>
      {Object.entries(lm).map(([name, v]) => {
        const [x, y] = toCanvas(card, v);
        if (x < card.x || x > card.x + card.w || y < card.y || y > card.y + card.h) return null;
        return (
          <g key={name}>
            <circle cx={x} cy={y} r={6} fill="#ff2d55" stroke="#fff" strokeWidth={2} />
            <text x={x + 9} y={y - 7} fontSize={card.w > 600 ? 18 : 13} fontFamily="monospace" fill="#ff2d55" stroke="#fff" strokeWidth={4} paintOrder="stroke">
              {name}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
