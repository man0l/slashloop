import React from 'react';
import {AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import {cardsFor, resolvePoint, toCanvas, type CardRect} from '../geometry';
import type {Anim, Beat, Landmarks, Script} from '../schema';
import {theme} from '../theme';
import {Card, Inset, stillSrc} from './Card';
import {AnimView, LandmarkDebug, Measure} from './Overlays';
import {Caption, Chip, fontFamily} from './Text';

const sfx = (name: 'pop' | 'whoosh' | 'click') => stillSrc(`assets/sfx/${name}.mp3`);

const Pop: React.FC<{at: number}> = ({at}) =>
  theme.audio.sfx.pop ? (
    <Sequence from={at} durationInFrames={8} layout="none">
      <Audio src={sfx('pop')} volume={theme.audio.sfxVolume} />
    </Sequence>
  ) : null;

// Frames at which each anim of a list starts (caption 0, first line 6, then every `step`).
const starts = (list: Anim[], base: number) => list.map((_, i) => base + theme.stagger.firstAnim + i * theme.stagger.step);
const hasChip = (a: Anim) => a.t === 'chip' || !!a.chip;
const chipFrame = (a: Anim, start: number) => (a.t === 'chip' ? start : start + theme.stagger.chipDelay);

export const BeatView: React.FC<{
  beat: Beat;
  script: Script;
  landmarks: Record<string, Landmarks>;
  frames: number;
  index: number;
  debug?: boolean;
}> = ({beat, script, landmarks, frames, index, debug}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const cards = cardsFor(beat, landmarks);
  const thenAt = beat.then ? Math.round((beat.then.at ?? theme.stagger.thenFraction) * frames) : Infinity;
  const inThen = frame >= thenAt;
  const active = inThen && beat.then?.active !== undefined ? beat.then.active : beat.active;
  const caption = inThen && beat.then?.caption ? beat.then.caption : beat.caption;
  const captionPos = (inThen && beat.then?.captionPos) || beat.captionPos;
  const hl = (inThen && beat.then?.hl) || beat.hl;
  const captionFrom = inThen && beat.then?.caption ? thenAt : theme.stagger.caption;

  const anims = beat.anim ?? [];
  const animStarts = starts(anims, 0);
  const thenAnims = beat.then?.anim ?? [];
  const thenStarts = starts(thenAnims, thenAt === Infinity ? 0 : thenAt - theme.stagger.firstAnim + 2);

  const cardOf = (a: Anim): CardRect => cards[a.card ?? 0] ?? cards[0];
  const state = (i: number) => (active === undefined || cards.length < 2 ? 'normal' : i === active ? 'active' : 'dim');
  const isGrid = beat.layout === 'grid2x2';
  const labelY = (c: CardRect) => c.y - 52;

  return (
    <AbsoluteFill>
      {cards.map((c, i) => (
        <Card key={i} card={c} src={stillSrc(script.faces[c.key])} state={state(i)} grey={beat.grey} />
      ))}

      {/* split / strip labels above each card */}
      {beat.labels && !isGrid
        ? cards.map((c, i) =>
            beat.labels?.[i] ? (
              <Chip key={`l${i}`} text={beat.labels[i]} x={c.x + c.w / 2} y={labelY(c)} from={0} tone={state(i) === 'active' ? 'teal' : 'white'} />
            ) : null,
          )
        : null}

      {/* grid: column headers, row header, payoff labels, arrows */}
      {isGrid && beat.grid ? (
        <>
          {cards.slice(0, 2).map((c, i) => (
            <Chip key={`h${i}`} text={beat.grid![i][1]} x={c.x + c.w / 2} y={labelY(c)} from={0} />
          ))}
          {beat.row ? (
            <Chip text={beat.row} x={cards[2].x - 46} y={cards[2].y + cards[2].h / 2} from={2} rotate={-90} anchor="center" tone="navy" />
          ) : null}
          {cards.slice(2).map((c, i) => {
            const [, label, tone] = beat.grid![i + 2] as [string, string, ('teal' | 'purple' | 'yellow' | 'white' | 'navy')?];
            const ly = c.y + c.h + (beat.arrows ? 150 : 64);
            return (
              <React.Fragment key={`p${i}`}>
                {beat.arrows ? (
                  <Measure a={[c.x + c.w / 2, c.y + c.h + 18]} b={[c.x + c.w / 2, ly - 34]} from={theme.stagger.firstAnim + i * theme.stagger.step} arrow />
                ) : null}
                <Chip text={label} x={c.x + c.w / 2} y={ly} from={beat.arrows ? 0 : 4 + i * 4} tone={tone ?? 'white'} />
              </React.Fragment>
            );
          })}
        </>
      ) : null}

      {anims.map((a, i) => (
        <AnimView key={`a${i}`} anim={a} card={cardOf(a)} lm={landmarks[cardOf(a).key]} from={animStarts[i]} />
      ))}
      {inThen
        ? thenAnims.map((a, i) => <AnimView key={`t${i}`} anim={a} card={cardOf(a)} lm={landmarks[cardOf(a).key]} from={thenStarts[i]} />)
        : null}

      {beat.inset && cards[0] ? (
        <>
          <Inset
            card={cards[0]}
            src={stillSrc(script.faces[cards[0].key])}
            at={resolvePoint(beat.inset.at, landmarks[cards[0].key], cards[0].key)}
            from={theme.stagger.insetDelay}
          />
          {beat.inset.label ? (
            <Chip
              text={beat.inset.label}
              x={cards[0].x + cards[0].w + 40 - theme.inset.diameter / 2}
              y={cards[0].y + cards[0].h + 40 - theme.inset.diameter - 10}
              from={theme.stagger.insetDelay + theme.inset.slideFrames}
              tone={beat.inset.tone}
            />
          ) : null}
        </>
      ) : null}

      <Caption key={captionFrom} text={caption} pos={captionPos} hl={hl} from={captionFrom} />

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
            {beat.focus ? ` · focus ${JSON.stringify(toCanvas(cards[0], resolvePoint(beat.focus, landmarks[cards[0].key], cards[0].key)).map(Math.round))}` : ''}
          </div>
        </>
      ) : null}
    </AbsoluteFill>
  );
};
