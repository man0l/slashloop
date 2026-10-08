// SLA-555: per-format instruction presets. A brief that locks hair, eyes or
// wardrobe on a statue, a sprite or a line drawing has nothing to preserve and
// fights the renderer, so defaults are chosen by what the source actually
// shows. Callers can always override variables, mode and direction; locks are
// additive so the universal safety locks can never be dropped by omission.
import type { VARIABLE_FIELDS } from './schema.js';

export const SOURCE_FORMATS = [
  'statue-collage', 'sprite-vs-real', 'annotated-face', 'ai-render', 'sketch', 'portrait-collage', 'photo-person',
] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];
type Variable = (typeof VARIABLE_FIELDS)[number];

interface Preset {
  variables: Variable[];
  mode: 'controlled' | 'exploration';
  direction: string;
  /** Medium, layout and overlay locks. Never person attributes. */
  locks: string[];
  /** Person locks are emitted only where the source shows a photographic human. */
  person?: (varyCharacter: boolean) => string[];
}

const PHOTO_PERSON_ATTRIBUTES = 'hair, eye colour, facial hair, complexion, wardrobe and jewelry';

export const PRESETS: Record<SourceFormat, Preset> = {
  'statue-collage': {
    variables: ['hook', 'visualStyle'], mode: 'controlled',
    direction: 'Keep the 2x2 food-photo collage with one grayscale classical statue overlay. Change the benefit questions and the food in each panel. The statue is a sculpture, not a person.',
    locks: [
      '2x2 food-photo grid on every content slide with one grayscale classical statue cutout over the lower half',
      'Centred bold question overlay in the source style; closing slide is the app UI',
      'The statue stays a grayscale marble or plaster sculpture with no real face',
    ],
  },
  'sprite-vs-real': {
    variables: ['hook', 'concept'], mode: 'exploration',
    direction: 'Same item shown as a real photo and as a pixel sprite; keep the rule-card text format and vary the rule and the items. No people.',
    locks: [
      'Paired layout: real photo of an item beside the same item as a pixel sprite',
      'Pixel medium: blocky low-resolution sprites, hard edges, no anti-aliasing',
      'Rule-card overlay format ("Rule N: ...") with a verdict mark per pair',
    ],
  },
  'annotated-face': {
    variables: ['character', 'hook'], mode: 'controlled',
    direction: 'Cast new fictional adult faces; keep the marker-annotation style and the red cross / green tick labels. Change the facial feature being rated.',
    locks: [
      'Hand-drawn marker line on one facial feature with a red cross or green tick and a short label',
      'Plain background, profile or front close-up framing, good-versus-bad pairing as in the source',
      'Faces are newly invented, never the source people',
    ],
    person: () => ['Keep each face\'s framing, head angle and gaze direction'],
  },
  'ai-render': {
    variables: ['hook', 'visualStyle', 'caption'], mode: 'controlled',
    direction: 'Keep one consistent AI-render look across the deck. Change the scene, subject and props per slide, and the hook.',
    locks: [
      'One visual style family across the whole deck, same palette and overlay typography',
    ],
    person: () => ['Keep any visible person\'s role, framing and gaze'],
  },
  sketch: {
    variables: ['hook', 'concept'], mode: 'exploration',
    direction: 'Three-beat negation then reveal; each panel is three food photos plus one line-drawing archetype. Vary the foods, the labels and the correct choice.',
    locks: [
      'Black-and-white line-drawing medium for the character panel; the other three panels are photos',
      '2x2 layout with a rating label on the drawing',
      'Three beats in order: not this, also not this, but this',
    ],
  },
  'portrait-collage': {
    variables: ['hook', 'character'], mode: 'controlled',
    direction: 'Keep the 2x2 collage of three food photos and one portrait with an "average <group>" label. Change the group labels, the foods and the portrait identities.',
    locks: [
      '2x2 per content slide: three food photos plus one portrait with an "average <group>" label; closing slide is the app promo',
      'Portraits are newly invented adults, never the source people',
    ],
    person: () => ['Keep each portrait\'s framing and the label style'],
  },
  'photo-person': {
    variables: ['hook'], mode: 'controlled',
    direction: '',
    locks: [],
    person: varyCharacter => varyCharacter
      ? ['Keep wardrobe, jewelry, expression, gaze, framing and background; only the casting direction may change the subject\'s identity']
      : [`Keep the subject exactly as in the source frame: ${PHOTO_PERSON_ATTRIBUTES}, expression and gaze`],
  },
};

const PERSON_FORMATS = new Set<SourceFormat>(['photo-person', 'annotated-face', 'portrait-collage']);

export function emitsPersonLocks(format: SourceFormat, observedHuman: boolean): boolean {
  return PERSON_FORMATS.has(format) || (format === 'ai-render' && observedHuman);
}

/** Always-on locks, independent of format. */
export function universalLocks(): string[] {
  return [
    'No source watermarks, creator handles or competitor brand names anywhere in the image',
    'Any app on the closing CTA slide is our own app (name and UI), never a competitor\'s',
    'No real people, celebrities or public figures; only invented likenesses',
    'Adults only: every person depicted is clearly an adult',
  ];
}

export interface ExpandInput {
  variables?: string[];
  mode?: 'controlled' | 'exploration';
  direction?: string;
  lockedConstraints?: string[];
}
export interface Expanded {
  variables: string[] | undefined;
  mode: 'controlled' | 'exploration';
  direction: string;
  /** Hard rules: the always-on workspace locks plus whatever the caller locked. */
  lockedConstraints: string[];
  /** SLA-700: what the source format suggests. Soft preferences, dropped when they conflict with the direction or a lock. */
  sourceDefaults: string[];
}

const EXPLORATION_ONLY = new Set(['concept', 'slides', 'angle']);
const MAX_LOCKS = 20;

/** Caller values win for variables, mode and direction. Hard locks (workspace + caller) and source defaults (format preset) are kept apart so no source trait is ever presented as a lock. */
export function expandPreset(format: SourceFormat | null, input: ExpandInput, observedHuman = false): Expanded {
  const preset = format ? PRESETS[format] : null;
  const caller = input.lockedConstraints ?? [];
  if (!preset) {
    return { variables: input.variables, mode: input.mode ?? 'controlled', direction: input.direction ?? '', lockedConstraints: caller, sourceDefaults: [] };
  }
  let variables = input.variables;
  if (!variables) {
    variables = preset.variables;
    if (input.mode === 'controlled') {
      const kept = variables.filter(v => !EXPLORATION_ONLY.has(v));
      variables = kept.length ? kept : ['hook'];
    }
  }
  const mode = input.mode ?? (variables.some(v => EXPLORATION_ONLY.has(v)) ? 'exploration' : preset.mode);
  const varyCharacter = variables.includes('character');
  const dedupe = (items: string[]) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const s of items) {
      const t = s.trim();
      const k = t.toLowerCase();
      if (t && !seen.has(k) && out.length < MAX_LOCKS) { seen.add(k); out.push(t); }
    }
    return out;
  };
  const locks = dedupe([...universalLocks(), ...caller]);
  const lockKeys = new Set(locks.map(l => l.toLowerCase()));
  const defaults = dedupe([...preset.locks, ...(preset.person && emitsPersonLocks(format!, observedHuman) ? preset.person(varyCharacter) : [])])
    .filter(d => !lockKeys.has(d.toLowerCase()));
  return { variables, mode, direction: input.direction?.trim() ? input.direction : preset.direction, lockedConstraints: locks, sourceDefaults: defaults };
}

// ---- inference ---------------------------------------------------------------

export interface FormatSignals {
  caption?: string | null;
  /** Parsed v3 analysis JSON, when the source has one. */
  analysis?: unknown;
}
export interface InferredFormat { format: SourceFormat; observedHuman: boolean }

const RULES: Array<[SourceFormat, RegExp]> = [
  ['sprite-vs-real', /\b(?:pixel(?:ated|\s*art)?|sprites?|8-?bit|16-?bit|minecraft|voxel)\b/i],
  ['statue-collage', /\b(?:statues?|sculptures?|marble bust|plaster bust)\b/i],
  ['annotated-face', /\b(?:ramus|jaw\s*line|annotat(?:ed|ion)s?|marker line)\b|❌|✅/i],
  ['sketch', /\b(?:line[- ]?drawings?|wojak|stick figures?|doodles?|black[- ]and[- ]white (?:drawing|illustration))\b/i],
  ['ai-render', /\b(?:ai[- ]generated|ai[- ]render(?:ed)?|3d render(?:ed|ing)?|cgi|midjourney)\b/i],
];
// A portrait collage needs both a portrait cue and a collage cue: "average boy" alone is also
// what a plain photo deck looks like, and a layout lock on a deck that is not 2x2 would be wrong.
const PORTRAIT_CUE = /\baverage\s+(?:\w+\s+){0,2}(?:man|boy|woman|girl|guy|person)\b|\bportraits?\b/i;
const COLLAGE_CUE = /\b(?:collage|grid|2x2|split[- ]screen|four panels?|quadrants?)\b|\bsplit_screen\b/i;
const HUMAN = /\b(?:person|man|woman|boy|girl|face|faces|creator|portrait|model|guy)\b/i;

function evidenceText(analysis: unknown): { text: string; talkingHeadMajority: boolean; humanShots: boolean; splitScreen: boolean } {
  const a = (analysis && typeof analysis === 'object' ? analysis : {}) as Record<string, unknown>;
  const parts: string[] = [];
  const str = (v: unknown) => { if (typeof v === 'string' && v) parts.push(v); };
  const shots = Array.isArray(a.shots) ? a.shots as Array<Record<string, unknown>> : [];
  for (const s of shots) { str(s?.description); str(s?.onScreenText); }
  const moments = Array.isArray(a.keyMoments) ? a.keyMoments as Array<Record<string, unknown>> : [];
  for (const m of moments) { str(m?.subjectAction); str(m?.wardrobeProps); str(m?.setting); }
  if (Array.isArray(a.visualTechniques)) for (const t of a.visualTechniques) str(t);
  const talking = shots.filter(s => s?.type === 'talking_head' || s?.type === 'reaction').length;
  return {
    text: parts.join(' \n '),
    splitScreen: shots.some(s => s?.type === 'split_screen'),
    talkingHeadMajority: shots.length > 0 && talking * 2 >= shots.length,
    humanShots: talking > 0 || moments.some(m => typeof m?.wardrobeProps === 'string' && m.wardrobeProps.trim()),
  };
}

export function inferSourceFormat(signals: FormatSignals): InferredFormat | null {
  const ev = evidenceText(signals.analysis);
  const corpus = `${signals.caption ?? ''} \n ${ev.text}`;
  const observedHuman = ev.humanShots || HUMAN.test(ev.text);
  if (ev.talkingHeadMajority) return { format: 'photo-person', observedHuman: true };
  for (const [format, re] of RULES) {
    if (re.test(corpus)) return { format, observedHuman };
    // Slot portrait-collage between sketch and ai-render, where the spec's priority puts it.
    if (format === 'sketch' && PORTRAIT_CUE.test(corpus) && (COLLAGE_CUE.test(corpus) || ev.splitScreen)) return { format: 'portrait-collage', observedHuman };
  }
  if (ev.humanShots) return { format: 'photo-person', observedHuman: true };
  return null;
}

/** One preset only when every source agrees; a mixed set keeps the plain defaults. */
export function inferSharedFormat(sources: FormatSignals[]): InferredFormat | null {
  const inferred = sources.map(inferSourceFormat);
  if (!inferred.length || inferred.some(i => !i)) return null;
  const first = inferred[0]!;
  if (inferred.some(i => i!.format !== first.format)) return null;
  return { format: first.format, observedHuman: inferred.some(i => i!.observedHuman) };
}
