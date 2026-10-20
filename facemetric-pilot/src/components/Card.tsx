import React from 'react';
import {Easing, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import {SUBTITLE_BAND, type CardRect, type Vec} from '../geometry';
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

// Close-up of a region, sliding in from the right. circle: bottom-right of the photo (420 px, white ring).
// square: the ladder inset, a rounded square at the right of the face (reference jaw ladder).
export const insetBox = (card: CardRect, shape: 'circle' | 'square' = 'circle') => {
  const t = theme.inset;
  if (shape === 'square') {
    const d = t.square;
    return {d, left: theme.canvas.width - d - 60, top: t.squareTop, radius: t.squareRadius};
  }
  const d = t.diameter;
  return {
    d,
    left: Math.min(theme.canvas.width - d - 30, card.x + card.w - d + 40),
    // Above the subtitle band (brief 9.2), never under the subtitles.
    top: Math.min(SUBTITLE_BAND[0] - d - 24, card.y + card.h - d + 40),
    radius: d / 2,
  };
};

export const Inset: React.FC<{card: CardRect; src: string; at: Vec; from: number; shape?: 'circle' | 'square'; zoom?: number}> = ({card, src, at, from, shape, zoom}) => {
  const frame = useCurrentFrame() - from;
  if (frame < 0) return null;
  const t = theme.inset;
  const {d, left, top, radius} = insetBox(card, shape);
  // The ladder's square inset stays put from level to level (only its content changes); the circle slides in.
  const slide =
    shape === 'square'
      ? 0
      : interpolate(frame, [0, t.slideFrames], [theme.canvas.width - left + 20, 0], {extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  // Zoom is relative to how the photo shows the still.
  const iw = card.dw * (zoom ?? t.zoom);
  const ih = card.dh * (zoom ?? t.zoom);
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: d,
        height: d,
        borderRadius: radius,
        overflow: 'hidden',
        boxShadow: `0 0 0 ${shape === 'square' ? 7 : t.ring}px ${theme.color.white}, ${theme.card.shadow}`,
        translate: `${slide}px 0px`,
        background: theme.canvas.background,
      }}
    >
      <Img src={src} style={{position: 'absolute', width: iw, height: ih, left: d / 2 - at[0] * iw, top: d / 2 - at[1] * ih, objectFit: 'cover'}} />
    </div>
  );
};
