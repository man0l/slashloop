import {Audio} from '@remotion/media';
import React from 'react';
import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {cardsFor, resolvePoint, type CardRect} from '../geometry';
import type {Anim, Beat, Landmarks, Script} from '../schema';
import {theme} from '../theme';
import {Card, Inset, stillSrc} from './Card';
import {AnimView, LandmarkDebug} from './Overlays';
import {Chip, fontFamily, Headline, Subtitles, type Tone, type Word} from './Text';

const Pop: React.FC<{at: number}> = ({at}) =>
  theme.audio.sfx.pop ? (
    <Sequence from={at} durationInFrames={8} layout="none">
      <Audio src={stillSrc('assets/sfx/pop.mp3')} volume={theme.audio.sfxVolume} />
    </Sequence>
  ) : null;

// Frames at which each anim of a list starts (headline 0, first line 6, then every `step`).
const starts = (list: Anim[], base: number) => list.map((_, i) => base + theme.stagger.firstAnim + i * theme.stagger.step);
const hasChip = (a: Anim) => a.t === 'chip' || !!a.chip;
const chipFrame = (a: Anim, start: number) => (a.t === 'chip' ? start : start + theme.stagger.chipDelay);
const isLabel = (a: Anim) => a.t === 'chip' && !a.at;

export const BeatView: React.FC<{
  beat: Beat;
  script: Script;
  landmarks: Record<string, Landmarks>;
  bg: Record<string, string>; // still key -> background colour, plus "_reel" for the reel average
  words: Word[];
  frames: number;
  index: number;
  debug?: boolean;
}> = ({beat, script, landmarks, bg, words, frames, index, debug}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const thenAt = beat.then ? Math.round((beat.then.at ?? theme.stagger.thenFraction) * frames) : Infinity;
  const inThen = frame >= thenAt;
  // A `then` step can reframe a single still (close-up -> full face). A view change without a zoom resets the zoom.
  const t = inThen ? beat.then : undefined;
  const framed = t && (t.view || t.zoom || t.focus)
    ? {...beat, view: t.view ?? beat.view, zoom: t.zoom ?? (t.view ? undefined : beat.zoom), focus: t.focus ?? (t.view ? undefined : beat.focus)}
    : beat;
  const cards = cardsFor(framed, landmarks);
  const active = inThen && beat.then?.active !== undefined ? beat.then.active : beat.active;
  const caption = inThen && beat.then?.caption ? beat.then.caption : beat.caption;
  const hl = (inThen && beat.then?.hl) || beat.hl;
  const headlineFrom = inThen && beat.then?.caption ? thenAt : 0;

  const anims = beat.anim ?? [];
  const animStarts = starts(anims, 0);
  const thenAnims = beat.then?.anim ?? [];
  const thenStarts = starts(thenAnims, thenAt === Infinity ? 0 : thenAt - theme.stagger.firstAnim + 2);

  const cardOf = (a: Anim): CardRect => cards[a.card ?? 0] ?? cards[0];
  const state = (i: number) => (active === undefined || cards.length < 2 ? 'normal' : i === active ? 'active' : 'dim');
  const isGrid = beat.layout === 'grid2x2';
  const bleed = cards.length === 1 && cards[0].bleed;
  const canvasBg = bleed ? bg[cards[0].key] ?? bg._reel : bg._reel;

  // Label chips (chip anims without `at`): stacked above the photo, or under the headline on a full-bleed beat.
  const labels = [...anims.map((a, i) => ({a, from: animStarts[i]})), ...(inThen ? thenAnims.map((a, i) => ({a, from: thenStarts[i]})) : [])].filter(
    ({a}) => isLabel(a),
  );
  const labelPos = (n: number, a: Anim): [number, number] => {
    const c = cardOf(a);
    const gap = theme.chip.fontSize + theme.chip.padY * 2 + theme.chip.border * 2 + theme.chip.stackGap;
    if (c.bleed) return [c.x + c.w / 2, 470 + n * gap];
    const total = labels.filter((l) => cardOf(l.a) === c).length;
    return [c.x + c.w / 2, c.y - 46 - (total - 1 - n) * gap];
  };
  const inside = (c: CardRect) => c.y + c.h - (c.w < 600 ? 34 : 44); // chip line inside the card's bottom edge

  return (
    <AbsoluteFill style={{background: canvasBg}}>
      {cards.map((c, i) => {
        const ring = isGrid && beat.arrows && i >= 2 ? theme.color[(beat.grid![i][2] as 'teal' | 'purple' | undefined) ?? 'teal'] : undefined;
        return <Card key={i} card={c} src={stillSrc(script.faces[c.key])} state={state(i)} ring={ring} grey={beat.grey} />;
      })}

      {beat.tint ? <AbsoluteFill style={{background: theme.tint[beat.tint]}} /> : null}

      {/* split / strip labels: small pills inside the bottom of each card */}
      {beat.labels && !isGrid
        ? cards.map((c, i) =>
            beat.labels?.[i] ? (
              <Chip key={`l${i}`} text={beat.labels[i]} x={c.x + c.w / 2} y={inside(c)} from={0} small tone={state(i) === 'active' ? 'teal' : 'white'} />
            ) : null,
          )
        : null}

      {/* grid: column labels on the top row, row pill between rows, payoff labels + coloured rings on reveal */}
      {isGrid && beat.grid ? (
        <>
          {cards.slice(0, 2).map((c, i) => (
            <Chip key={`h${i}`} text={beat.grid![i][1]} x={c.x + c.w / 2} y={inside(c)} from={0} small />
          ))}
          {beat.row ? <Chip text={beat.row} x={theme.canvas.width / 2} y={(cards[0].y + cards[0].h + cards[2].y) / 2} from={3} small tone="navy" /> : null}
          {beat.arrows
            ? cards.slice(2).map((c, i) => {
                const [, label, tone] = beat.grid![i + 2] as [string, string, Tone?];
                return <Chip key={`p${i}`} text={label} x={c.x + c.w / 2} y={inside(c)} from={theme.stagger.firstAnim + i * theme.stagger.step} tone={tone} small />;
              })
            : null}
        </>
      ) : null}

      {anims.map((a, i) => (
        <AnimView key={`a${i}`} anim={a} card={cardOf(a)} lm={landmarks[cardOf(a).key]} from={animStarts[i]} />
      ))}
      {inThen
        ? thenAnims.map((a, i) => <AnimView key={`t${i}`} anim={a} card={cardOf(a)} lm={landmarks[cardOf(a).key]} from={thenStarts[i]} />)
        : null}
      {labels.map(({a, from}, n) => {
        const [x, y] = labelPos(labels.filter((l, j) => j < n && cardOf(l.a) === cardOf(a)).length, a);
        return a.t === 'chip' ? <Chip key={`lab${n}`} text={a.text} x={x} y={y} from={from} tone={a.tone} check={a.check ?? true} /> : null;
      })}

      {beat.inset && cards[0] ? (
        <>
          <Inset card={cards[0]} src={stillSrc(script.faces[cards[0].key])} at={resolvePoint(beat.inset.at, landmarks[cards[0].key], cards[0].key)} from={theme.stagger.insetDelay} />
          {beat.inset.label ? (
            <Chip
              text={beat.inset.label}
              x={Math.min(theme.canvas.width - 30 - theme.inset.diameter / 2, cards[0].x + cards[0].w + 40 - theme.inset.diameter / 2)}
              y={Math.min(theme.canvas.height - 260, cards[0].y + cards[0].h + 40) - theme.inset.diameter - 10}
              from={theme.stagger.insetDelay + theme.inset.slideFrames}
              tone={beat.inset.tone}
            />
          ) : null}
        </>
      ) : null}

      <Headline key={headlineFrom} text={caption} hl={hl} underline={beat.underline} from={headlineFrom} />
      {beat.subs ? <Subtitles words={words} /> : null}

      {/* SFX: a pop on every chip */}
      {anims.map((a, i) => (hasChip(a) ? <Pop key={`s${i}`} at={chipFrame(a, animStarts[i])} /> : null))}
      {thenAnims.map((a, i) => (hasChip(a) ? <Pop key={`st${i}`} at={chipFrame(a, thenStarts[i])} /> : null))}
      {beat.inset?.label ? <Pop at={theme.stagger.insetDelay + theme.inset.slideFrames} /> : null}

      {debug ? (
        <>
          {cards.map((c, i) => (
            <LandmarkDebug key={`d${i}`} card={c} lm={landmarks[c.key]} />
          ))}
          <div style={{position: 'absolute', left: 16, top: 16, fontFamily, fontSize: 26, fontWeight: 700, color: '#ff2d55', background: 'rgba(255,255,255,.85)', padding: '4px 10px', borderRadius: 8}}>
            {script.id} beat {index + 1} · {beat.layout}/{beat.view} · {(frames / fps).toFixed(2)}s · f{frame}
          </div>
        </>
      ) : null}
    </AbsoluteFill>
  );
};
