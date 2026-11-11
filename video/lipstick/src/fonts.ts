// Fonts bundled from @fontsource (latin subset) so renders never depend on
// reaching Google Fonts from headless Chrome.
import { loadFont } from '@remotion/fonts';
import dmSerif from '@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff2';
import dmSerifItalic from '@fontsource/dm-serif-display/files/dm-serif-display-latin-400-italic.woff2';
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff2';
import inter700 from '@fontsource/inter/files/inter-latin-700-normal.woff2';
import inter800 from '@fontsource/inter/files/inter-latin-800-normal.woff2';
import plex500 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2';

export const SERIF = 'DM Serif Display';
export const SANS = 'Inter';
export const MONO = 'IBM Plex Mono';

const faces: [string, string, string, 'normal' | 'italic'][] = [
  [SERIF, dmSerif, '400', 'normal'],
  [SERIF, dmSerifItalic, '400', 'italic'],
  [SANS, inter500, '500', 'normal'],
  [SANS, inter700, '700', 'normal'],
  [SANS, inter800, '800', 'normal'],
  [MONO, plex500, '500', 'normal'],
];
for (const [family, url, weight, style] of faces) loadFont({ family, url, weight, style, format: 'woff2' });
