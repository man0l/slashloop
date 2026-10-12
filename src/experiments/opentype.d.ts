declare module 'opentype.js' {
  export interface Path { toPathData(decimalPlaces?: number): string }
  export interface Font {
    unitsPerEm: number;
    charToGlyphIndex(char: string): number;
    getAdvanceWidth(text: string, fontSize?: number): number;
    getPath(text: string, x: number, y: number, fontSize: number): Path;
  }
  export function parse(buffer: ArrayBuffer): Font;
  const opentype: { parse: typeof parse };
  export default opentype;
}
