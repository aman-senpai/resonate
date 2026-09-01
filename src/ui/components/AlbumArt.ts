import { Song, Theme } from '../../types.js';
import { getVisualWidth, gradientText, pad, truncate } from '../renderer.js';

export interface AlbumArtOptions {
  width: number;
  height: number;
  song: Song | null;
  theme: Theme;
  spinAngle?: number;
}

export function renderAlbumArt(opts: AlbumArtOptions): string[] {
  const { width, height, song, theme } = opts;
  const lines: string[] = [];
  const innerWidth = Math.max(1, width);
  const innerHeight = Math.max(1, height);

  // If song has custom/TrueColor art lines, use them directly
  if (song?.art && song.art.length > 0) {
    const artLines = song.art;
    const startY = Math.max(0, Math.floor((innerHeight - artLines.length) / 2));

    for (let y = 0; y < innerHeight; y++) {
      if (y >= startY && y < startY + artLines.length) {
        const rawLine = artLines[y - startY];
        const visualLen = getVisualWidth(rawLine);
        const safeLine = visualLen > innerWidth ? truncate(rawLine, innerWidth) : rawLine;
        
        if (rawLine.includes('\x1b[')) {
          // Already ANSI colored (e.g. TrueColor half-blocks)
          lines.push(pad(safeLine, innerWidth, 'center'));
        } else {
          const coloredLine = gradientText(safeLine, [theme.primary, theme.accent, theme.secondary]);
          lines.push(pad(coloredLine, innerWidth, 'center'));
        }
      } else {
        lines.push(' '.repeat(innerWidth));
      }
    }
    return lines;
  }

  // YouTube Music Vinyl / Art Box fallback
  const titleDisplay = song?.title ? truncate(song.title.toUpperCase(), Math.max(8, innerWidth - 4)) : 'YOUTUBE MUSIC';
  const artistDisplay = song?.artist ? truncate(song.artist, Math.max(8, innerWidth - 4)) : 'STREAMING';

  const presetArt = [
    ' ╔═════════════════╗ ',
    ' ║  ▄▄▄▄     ▄▄▄▄  ║ ',
    ' ║ ▐████▌ ♫ ▐████▌ ║ ',
    ' ║  ▀▀▀▀     ▀▀▀▀  ║ ',
    ' ╚═════════════════╝ ',
    `   ${titleDisplay}   `,
    `   ${artistDisplay}   `,
  ];

  const startY = Math.max(0, Math.floor((innerHeight - presetArt.length) / 2));

  for (let y = 0; y < innerHeight; y++) {
    if (y >= startY && y < startY + presetArt.length) {
      const line = presetArt[y - startY];
      const safeLine = getVisualWidth(line) > innerWidth ? truncate(line, innerWidth) : line;
      const colored = gradientText(safeLine, [theme.primary, theme.accent, theme.secondary]);
      lines.push(pad(colored, innerWidth, 'center'));
    } else {
      lines.push(' '.repeat(innerWidth));
    }
  }
  return lines;
}
