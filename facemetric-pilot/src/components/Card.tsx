import React from 'react';
import {Easing, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import type {CardRect, Vec} from '../geometry';
import {theme} from '../theme';

export const stillSrc = (path: string) => staticFile(path.replace(/^assets\//, ''));

// The still, framed by the card's zoom/focus, filling a w x h box.
const Framed: React.FC<{src: string; w: number; h: number; zoom: number; fx: number; fy: number; grey?: boolean}> = ({
  src,
  w,
  h,
  zoom,
  fx,
  fy,
  grey,
}) => (
  <Img
    src={src}
    style={{
      position: 'absolute',
      width: w * zoom,
      height: h * zoom,
      left: w / 2 - fx * w * zoom,
      top: h / 2 - fy * h * zoom,
      objectFit: 'cover',
      filter: grey ? 'grayscale(1) contrast(1.05)' : undefined,
    }}
  />
);

export const Card: React.FC<{
  card: CardRect;
  src: string;
  state?: 'active' | 'dim' | 'normal';
  grey?: boolean;
  overlay?: string; // optional selective-colour layer drawn on top of a grey still
}> = ({card, src, state = 'normal', grey, overlay}) => {
  const c = theme.card;
  // Scale the border and radius down with the card so small grid cards keep the same look.
  const k = Math.max(0.55, card.w / c.singleWidth);
  const border = Math.round(c.border * (card.w < 600 ? 0.75 : 1));
  return (
    <div
      style={{
        position: 'absolute',
        left: card.x - border,
        top: card.y - border,
        width: card.w + border * 2,
        height: card.h + border * 2,
        borderRadius: c.radius * k + border,
        background: c.borderColor,
        boxShadow:
          state === 'active' ? `0 0 0 ${c.activeBorder}px ${theme.color.teal}, ${c.shadow}` : c.shadow,
        opacity: state === 'dim' ? c.dimOpacity : 1,
        padding: border,
      }}
    >
      <div style={{position: 'relative', width: card.w, height: card.h, borderRadius: c.radius * k, overflow: 'hidden'}}>
        <Framed src={src} w={card.w} h={card.h} zoom={card.zoom} fx={card.fx} fy={card.fy} grey={grey} />
        {overlay ? <Framed src={overlay} w={card.w} h={card.h} zoom={card.zoom} fx={card.fx} fy={card.fy} /> : null}
      </div>
    </div>
  );
};

// Circular 2x close-up of a region, bottom-right of the card, sliding in from the right.
export const Inset: React.FC<{card: CardRect; src: string; at: Vec; from: number}> = ({card, src, at, from}) => {
  const frame = useCurrentFrame() - from;
  if (frame < 0) return null;
  const t = theme.inset;
  const d = t.diameter;
  const left = card.x + card.w - d + 40;
  const top = card.y + card.h - d + 40;
  const slide = interpolate(frame, [0, t.slideFrames], [theme.canvas.width - left + 20, 0], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  // Zoom is relative to how the card shows the still.
  const zoom = card.zoom * t.zoom;
  const iw = card.w * zoom;
  const ih = card.h * zoom;
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: d,
        height: d,
        borderRadius: '50%',
        overflow: 'hidden',
        boxShadow: `0 0 0 ${t.ring}px ${theme.color.white}, ${theme.card.shadow}`,
        translate: `${slide}px 0px`,
        background: theme.canvas.background,
      }}
    >
      <Img
        src={src}
        style={{position: 'absolute', width: iw, height: ih, left: d / 2 - at[0] * iw, top: d / 2 - at[1] * ih, objectFit: 'cover'}}
      />
    </div>
  );
};
