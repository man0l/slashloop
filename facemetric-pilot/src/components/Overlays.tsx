import React from 'react';
import {Easing, interpolate, useCurrentFrame} from 'remotion';
import {resolvePoint, toCanvas, type CardRect, type Vec} from '../geometry';
import type {Anim, Landmarks} from '../schema';
import {theme} from '../theme';
import {Chip} from './Text';

const {navy, white} = theme.color;
const L = theme.line;

const progress = (frame: number) =>
  interpolate(frame, [0, L.drawFrames], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});

const Svg: React.FC<{children: React.ReactNode}> = ({children}) => (
  <svg width={theme.canvas.width} height={theme.canvas.height} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
    {children}
  </svg>
);

// Draw-on stroke with a white halo underneath.
const Stroke: React.FC<{d: string; len: number; p: number; join?: 'round' | 'miter'}> = ({d, len, p, join = 'round'}) => (
  <>
    {L.halo > 0 ? (
      <path d={d} fill="none" stroke={white} strokeOpacity={0.85} strokeWidth={L.width + L.halo * 2} strokeLinecap="round" strokeLinejoin={join}
        strokeDasharray={len} strokeDashoffset={len * (1 - p)} />
    ) : null}
    <path d={d} fill="none" stroke={navy} strokeWidth={L.width} strokeLinecap="round" strokeLinejoin={join}
      strokeDasharray={len} strokeDashoffset={len * (1 - p)} />
  </>
);

const dist = (a: Vec, b: Vec) => Math.hypot(b[0] - a[0], b[1] - a[1]);

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
      {p > 0.9 ? <Stroke d={arrow ? head(end) : tick(end)} len={L.tick * 3} p={1} join={arrow ? 'round' : 'miter'} /> : null}
    </Svg>
  );
};

const Box: React.FC<{a: Vec; b: Vec; from: number}> = ({a, b, from}) => {
  const frame = useCurrentFrame() - from;
  if (frame < 0) return null;
  const [x, y, w, h] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
  const r = Math.min(L.boxRadius, h / 2, w / 2);
  // Start drawing at top-centre so the box closes symmetrically.
  const d = `M ${x + w / 2} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
  const len = 2 * (w + h) - 8 * r + 2 * Math.PI * r;
  return (
    <Svg>
      <Stroke d={d} len={len} p={progress(frame)} />
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

// Dotted path: dots appear one after another along the polyline over the draw time.
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
        <g key={i}>
          <circle cx={p[0]} cy={p[1]} r={L.dotRadius + L.halo * 0.6} fill={white} fillOpacity={0.85} />
          <circle cx={p[0]} cy={p[1]} r={L.dotRadius} fill={navy} />
        </g>
      ))}
    </Svg>
  );
};

// One `anim` entry of a beat, starting at frame `from` of the beat.
export const AnimView: React.FC<{anim: Anim; card: CardRect; lm: Landmarks | undefined; from: number}> = ({anim, card, lm, from}) => {
  const P = (p: Parameters<typeof resolvePoint>[0]) => toCanvas(card, resolvePoint(p, lm, card.key));
  const chipFrom = from + theme.stagger.chipDelay;
  const chipAt = 'chipAt' in anim && anim.chipAt ? P(anim.chipAt) : null;
  const tone = anim.tone;
  switch (anim.t) {
    case 'chip': {
      const [x, y] = P(anim.at);
      return <Chip text={anim.text} x={x} y={y} from={from} tone={tone} />;
    }
    case 'measure': {
      const a = P(anim.from);
      const b = P(anim.to);
      const mid: Vec = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const vertical = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
      const chip = anim.chip ? (
        chipAt ? (
          <Chip text={anim.chip} x={chipAt[0]} y={chipAt[1]} from={chipFrom} tone={tone} />
        ) : vertical ? (
          // Chip beside the line, on the side with more room.
          mid[0] < theme.canvas.width / 2 + 120 ? (
            <Chip text={anim.chip} x={Math.max(a[0], b[0]) + 30} y={mid[1]} from={chipFrom} tone={tone} anchor="left" />
          ) : (
            <Chip text={anim.chip} x={Math.min(a[0], b[0]) - 30} y={mid[1]} from={chipFrom} tone={tone} anchor="right" />
          )
        ) : (
          <Chip text={anim.chip} x={mid[0]} y={Math.max(a[1], b[1]) + 56} from={chipFrom} tone={tone} />
        )
      ) : null;
      return (
        <>
          <Measure a={a} b={b} from={from} />
          {chip}
        </>
      );
    }
    case 'box': {
      const pad = (anim.pad ?? 0.035) * card.w * card.zoom;
      const a0 = P(anim.from);
      const b0 = P(anim.to);
      const a: Vec = [Math.min(a0[0], b0[0]) - pad, Math.min(a0[1], b0[1]) - pad * 1.1];
      const b: Vec = [Math.max(a0[0], b0[0]) + pad, Math.max(a0[1], b0[1]) + pad * 1.1];
      const c = chipAt ?? ([(a[0] + b[0]) / 2, a[1] - 44] as Vec);
      return (
        <>
          <Box a={a} b={b} from={from} />
          {anim.chip ? <Chip text={anim.chip} x={c[0]} y={c[1]} from={chipFrom} tone={tone} /> : null}
        </>
      );
    }
    case 'dots': {
      const pts = anim.path.map(P);
      const low = pts.reduce((m, p) => (p[1] > m[1] ? p : m), pts[0]);
      const c = chipAt ?? ([low[0], low[1] + 60] as Vec);
      return (
        <>
          <Dots pts={pts} from={from} />
          {anim.chip ? <Chip text={anim.chip} x={c[0]} y={c[1]} from={chipFrom} tone={tone} /> : null}
        </>
      );
    }
    case 'circle': {
      const c = P(anim.at);
      const r = anim.r * card.w * card.zoom;
      const cc = chipAt ?? ([c[0], c[1] + r + 50] as Vec);
      return (
        <>
          <Circle c={c} r={r} from={from} />
          {anim.chip ? <Chip text={anim.chip} x={cc[0]} y={cc[1]} from={chipFrom} tone={tone} /> : null}
        </>
      );
    }
  }
};

// Debug: every landmark of the still as a dot with its name.
export const LandmarkDebug: React.FC<{card: CardRect; lm: Landmarks | undefined}> = ({card, lm}) => {
  if (!lm) return null;
  return (
    <Svg>
      {Object.entries(lm).map(([name, v]) => {
        const [x, y] = toCanvas(card, v);
        if (x < card.x || x > card.x + card.w || y < card.y || y > card.y + card.h) return null;
        return (
          <g key={name}>
            <circle cx={x} cy={y} r={6} fill="#ff2d55" stroke={white} strokeWidth={2} />
            <text x={x + 9} y={y - 7} fontSize={card.w > 600 ? 18 : 13} fontFamily="monospace" fill="#ff2d55" stroke={white} strokeWidth={4} paintOrder="stroke">
              {name}
            </text>
          </g>
        );
      })}
    </Svg>
  );
};
