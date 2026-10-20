import React from 'react';
import {Composition, Folder} from 'remotion';
import {calculateMetadata, Reel, type ReelProps} from './Reel';
import {theme} from './theme';
import R01 from '../scripts/R01.json';
import M01 from '../scripts/M01.json';
import M02 from '../scripts/M02.json';
import M03 from '../scripts/M03.json';
import M04 from '../scripts/M04.json';
import M05 from '../scripts/M05.json';

// `Reel` is the one composition the renderer uses: pass any script with --props=./scripts/RXX.json.
// The "Review" folder registers each script (and a debug copy with landmark dots) for Studio review.
const scripts = [R01, M01, M02, M03, M04, M05] as unknown as ReelProps[];

const common = {
  component: Reel,
  fps: theme.canvas.fps,
  width: theme.canvas.width,
  height: theme.canvas.height,
  durationInFrames: 30 * 45,
  calculateMetadata,
} as const;

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Reel" {...common} defaultProps={{...scripts[0], debug: false}} />
    <Folder name="Review">
      {scripts.map((s) => (
        <React.Fragment key={s.id}>
          <Composition id={s.id} {...common} defaultProps={{...s, debug: false}} />
          <Composition id={`${s.id}-debug`} {...common} defaultProps={{...s, debug: true}} />
        </React.Fragment>
      ))}
    </Folder>
  </>
);
