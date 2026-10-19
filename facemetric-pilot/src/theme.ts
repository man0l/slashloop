// Design tokens for the @facemetricai look. Every component reads from here,
// so review notes are applied once and every reel inherits them.

export const theme = {
  canvas: {
    width: 1080,
    height: 1920,
    fps: 30,
    background: '#DCE8F3',
    vignette: 0.02, // edge darkening opacity
  },
  color: {
    navy: '#0B1F3A',
    white: '#FFFFFF',
    teal: '#1FB6A6',
    purple: '#8B5CF6',
    yellow: '#FACC15',
  },
  card: {
    radius: 48,
    border: 12,
    borderColor: '#FFFFFF',
    shadow: '0 24px 48px rgba(10,30,60,.18)',
    singleWidth: 900,
    splitWidth: 440,
    splitGap: 40,
    gridWidth: 420,
    gridGap: 30,
    imageAspect: 4 / 5, // width / height of the stills
    activeBorder: 6,
    dimOpacity: 0.7,
  },
  caption: {
    fontWeight: 800,
    fontSize: 64,
    lineHeight: 1.05,
    stroke: 10, // visible outline width (text-stroke is drawn at 2x behind the fill)
    maxWidth: 960,
    letterSpacing: 1.5,
    wordSpacing: 16, // the outline eats the space between words, so widen it
    maxLines: 3,
    topY: 150, // top edge of a top caption
    bottomY: 1770, // bottom edge of a bottom caption
  },
  chip: {
    fontWeight: 700,
    fontSize: 40,
    padX: 28,
    padY: 12,
    shadow: '0 8px 20px rgba(10,30,60,.22)',
    spring: {damping: 12, stiffness: 180},
    fromScale: 0.6,
  },
  line: {
    width: 6,
    tick: 24,
    halo: 4, // white under-stroke so navy lines read on dark hair / turtleneck (0 = off)
    drawFrames: 10,
    dotSpacing: 26,
    dotRadius: 6,
    boxRadius: 28,
  },
  inset: {
    diameter: 420,
    zoom: 2,
    ring: 10,
    slideFrames: 8,
  },
  stagger: {
    caption: 0, // frame the caption appears
    firstAnim: 6, // frame the first anim (line) starts
    step: 9, // extra frames for every following anim
    chipDelay: 8, // a line/box/dots chip pops this many frames after its anim starts (6 + 8 = 14)
    insetDelay: 4,
    thenFraction: 0.45, // where in the beat a `then` step switches
  },
  transition: {
    pushFrames: 6,
    flashFrames: 2,
  },
  footer: {
    text: 'AI-edited images',
    fontWeight: 500,
    fontSize: 28,
    opacity: 0.6,
    bottom: 34,
  },
  audio: {
    tailSeconds: 0.3,
    voiceVolume: 1, // 0 dB
    sfxVolume: 0.2, // -14 dB
    sfx: {pop: true, whoosh: true, click: true},
  },
  motion: {
    maxEaseFrames: 12,
    captionPopFrames: 5,
  },
} as const;

export type Hl = 'teal' | 'purple' | 'yellow';
export const hlColor = (hl: Hl | undefined) => (hl ? theme.color[hl] : theme.color.yellow);
