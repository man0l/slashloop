declare module 'opentype.js' {
  export interface PathCommand { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }
  export interface Path { commands: PathCommand[]; toPathData(decimalPlaces?: number): string }
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
