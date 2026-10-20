// Design tokens for the @facemetricai look, measured off the reference reels in reference/.
// Every component reads from here, so review notes are applied once and every reel inherits them.

export const theme = {
  canvas: {
    width: 1080,
    height: 1920,
    fps: 30,
    // Reference background. Full-bleed beats switch to the still's own background (assets/<reel>/stills.json)
    // so the photo has no visible edge; card / split / grid beats use the reel's average still background.
    background: '#9CADBB',
  },
  color: {
    navy: '#0B1F3A',
    white: '#FFFFFF',
    teal: '#10738F', // headline highlight ("BETTER", "DELIBERATE")
    check: '#1A93B0', // check badge on label chips, active-card border
    purple: '#7C3AED', // "CREEPY"
    yellow: '#FACC15', // active subtitle word box
  },
  font: {
    headline: 'Anton', // condensed, the reference's top text
    ui: 'Montserrat', // subtitles and chips
  },
  // Top headline: navy condensed caps, highlighted words in the beat's `hl` colour, thin white outline.
  headline: {
    fontSize: 104,
    lineHeight: 1.0,
    stroke: 3,
    top: 150,
    maxWidth: 940,
    underline: 8, // underline under highlighted words when beat.underline is set
  },
  // Voice-synced subtitles: up to 3 words at a time, the word being spoken sits on a yellow box.
  subtitle: {
    fontSize: 62,
    fontWeight: 900,
    stroke: 4,
    centerY: 1500,
    maxWords: 3,
    maxChars: 18,
    boxPadX: 10,
    boxRadius: 10,
  },
  card: {
    radius: 44,
    border: 8,
    borderColor: '#FFFFFF',
    shadow: '0 18px 40px rgba(10,30,60,.22)',
    singleWidth: 900, // rounded-card single view (beat.card = true)
    splitWidth: 486,
    splitGap: 24,
    gridWidth: 400,
    gridGap: 22,
    imageAspect: 4 / 5, // width / height of the stills
    activeBorder: 7,
    dimOpacity: 0.72,
    bleedFade: 0.1, // top fade of a full-bleed photo, fraction of its height
  },
  chip: {
    fontWeight: 800,
    fontSize: 34,
    padX: 22,
    padY: 9,
    border: 4,
    shadow: '0 6px 16px rgba(10,30,60,.18)',
    spring: {damping: 12, stiffness: 180},
    fromScale: 0.6,
    stackGap: 14, // label chips stacked above the photo
    checkSize: 34,
  },
  line: {
    color: '#FFFFFF',
    width: 5,
    tick: 26,
    endDot: 8, // teal dot with a white ring at measure ends
    drawFrames: 10,
    dotSpacing: 24,
    dotRadius: 5,
    bracket: 34, // corner bracket arm length for the brow "box"
    shadow: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))',
  },
  inset: {
    diameter: 420,
    zoom: 2,
    ring: 10,
    slideFrames: 8,
    square: 300, // ladder inset: rounded square at the right of the face
    squareRadius: 28,
    squareTop: 560,
    valueSize: 76,
  },
  // Ladder header (template A): persistent, 2 lines, keyword on a teal box.
  header: {
    fontSize: 72,
    lineHeight: 1.08,
    top: 120,
    maxWidth: 960,
  },
  cite: {
    top: 400, // under a 1-2 line headline
    topUnderHeader: 300, // under a ladder header
  },
  strip: {
    width: 190,
    gap: 16,
    top: 700,
  },
  agePill: {
    x: 60,
    y: 1350,
  },
  stagger: {
    firstAnim: 6, // frame the first anim (line) starts; headline + subtitles start at 0
    step: 9,
    chipDelay: 8, // a line/box/dots chip pops this many frames after its anim starts (6 + 8 = 14)
    insetDelay: 4,
    thenFraction: 0.45,
  },
  transition: {
    pushFrames: 6,
    flashFrames: 2,
  },
  tint: {
    purple: 'radial-gradient(ellipse at center, rgba(124,58,237,0) 45%, rgba(124,58,237,.38) 100%)',
    teal: 'radial-gradient(ellipse at center, rgba(16,115,143,0) 45%, rgba(16,115,143,.32) 100%)',
  },
  footer: {
    text: 'AI-edited images',
    fontWeight: 700,
    fontSize: 26,
    opacity: 0.65,
    bottom: 30,
  },
  audio: {
    tailSeconds: 0.3,
    voiceVolume: 1, // 0 dB
    sfxVolume: 0.2, // -14 dB
    sfx: {pop: true, whoosh: true, click: true},
  },
  motion: {
    maxEaseFrames: 12,
    headlinePopFrames: 5,
  },
} as const;

export type Hl = 'teal' | 'purple' | 'yellow';
export const hlColor = (hl: Hl | undefined) => (hl ? theme.color[hl] : theme.color.teal);
