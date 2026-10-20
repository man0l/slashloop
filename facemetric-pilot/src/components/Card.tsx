import React from 'react';
import {Easing, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import type {CardRect, Vec} from '../geometry';
import {theme} from '../theme';

export const stillSrc = (path: string) => staticFile(path.replace(/^assets\//, ''));

// The still, cover-fitted and zoomed around the card's focus, filling the card box.
const Framed: React.FC<{src: string; card: CardRect; grey?: boolean}> = ({src, card, grey}) => (
  <Img
    src={src}
    style={{
      position: 'absolute',
      width: card.dw,
      height: card.dh,
      left: card.w / 2 - card.fx * card.dw,
      top: card.h / 2 - card.fy * card.dh,
      objectFit: 'cover',
      filter: grey ? 'grayscale(1) contrast(1.05)' : undefined,
    }}
  />
);

export const Card: React.FC<{
  card: CardRect;
  src: string;
  state?: 'active' | 'dim' | 'normal';
  ring?: string; // coloured border (grid payoff cards)
  grey?: boolean;
  overlay?: string; // optional selective-colour layer drawn on top of a grey still
}> = ({card, src, state = 'normal', ring, grey, overlay}) => {
  const c = theme.card;
  if (card.bleed) {
    // Full-bleed photo: no chrome; the top edge fades into the canvas (which is painted the still's background colour).
    const fade = card.y > 0 ? `linear-gradient(to bottom, transparent 0%, #000 ${c.bleedFade * 100}%)` : undefined;
    return (
      <div style={{position: 'absolute', left: card.x, top: card.y, width: card.w, height: card.h, overflow: 'hidden', maskImage: fade, WebkitMaskImage: fade}}>
        <Framed src={src} card={card} grey={grey} />
        {overlay ? <Framed src={overlay} card={card} /> : null}
      </div>
    );
  }
  // Scale chrome down with the card so small grid cards keep the same look.
  const k = Math.max(0.5, card.w / c.singleWidth);
  const border = Math.max(5, Math.round(c.border * k));
  const ringColor = ring ?? (state === 'active' ? theme.color.check : null);
  return (
    <div
      style={{
        position: 'absolute',
        left: card.x - border,
        top: card.y - border,
        width: card.w + border * 2,
        height: card.h + border * 2,
        borderRadius: c.radius * k + border,
        background: ringColor ?? c.borderColor,
        boxShadow: c.shadow,
        opacity: state === 'dim' ? c.dimOpacity : 1,
        padding: border,
      }}
    >
      <div style={{position: 'relative', width: card.w, height: card.h, borderRadius: c.radius * k, overflow: 'hidden'}}>
        <Framed src={src} card={card} grey={grey} />
        {overlay ? <Framed src={overlay} card={card} /> : null}
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
  const left = Math.min(theme.canvas.width - d - 30, card.x + card.w - d + 40);
  const top = Math.min(theme.canvas.height - d - 260, card.y + card.h - d + 40);
  const slide = interpolate(frame, [0, t.slideFrames], [theme.canvas.width - left + 20, 0], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const iw = card.dw * t.zoom;
  const ih = card.dh * t.zoom;
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
      <Img src={src} style={{position: 'absolute', width: iw, height: ih, left: d / 2 - at[0] * iw, top: d / 2 - at[1] * ih, objectFit: 'cover'}} />
    </div>
  );
};
