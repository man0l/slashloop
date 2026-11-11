// Fonts are bundled from @fontsource (latin subset only) instead of being
// fetched from Google Fonts at render time, so renders work offline and in
// sandboxes where headless Chrome can't reach fonts.gstatic.com.
import { loadFont } from '@remotion/fonts';
import fraunces500 from '@fontsource/fraunces/files/fraunces-latin-500-italic.woff2';
import fraunces600 from '@fontsource/fraunces/files/fraunces-latin-600-italic.woff2';
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff2';
import inter700 from '@fontsource/inter/files/inter-latin-700-normal.woff2';
import inter800 from '@fontsource/inter/files/inter-latin-800-normal.woff2';
import plex500 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2';

export const SERIF = 'Fraunces';
export const SANS = 'Inter';
export const MONO = 'IBM Plex Mono';

const faces: [string, string, string, 'normal' | 'italic'][] = [
  [SERIF, fraunces500, '500', 'italic'],
  [SERIF, fraunces600, '600', 'italic'],
  [SANS, inter500, '500', 'normal'],
  [SANS, inter700, '700', 'normal'],
  [SANS, inter800, '800', 'normal'],
  [MONO, plex500, '500', 'normal'],
];
for (const [family, url, weight, style] of faces) {
  loadFont({ family, url, weight, style, format: 'woff2' });
}
