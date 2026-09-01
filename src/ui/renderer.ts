import { RGB, TerminalDimensions, Theme } from '../types.js';

export const ANSI = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  ITALIC: '\x1b[3m',
  UNDERLINE: '\x1b[4m',
  BLINK: '\x1b[5m',
  INVERT: '\x1b[7m',
  HIDE_CURSOR: '\x1b[?25l',
  SHOW_CURSOR: '\x1b[?25h',
  ALT_SCREEN_ON: '\x1b[?1049h',
  ALT_SCREEN_OFF: '\x1b[?1049l',
  WRAP_OFF: '\x1b[?7l',
  WRAP_ON: '\x1b[?7h',
  CLEAR_SCREEN: '\x1b[2J\x1b[H',
  CURSOR_HOME: '\x1b[H',
  SYNC_START: '\x1b[?2026h',
  SYNC_END: '\x1b[?2026l',
};

/**
 * Returns ANSI 24-bit foreground escape code
 */
export function fg(rgb: RGB): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

/**
 * Returns ANSI 24-bit background escape code
 */
export function bg(rgb: RGB): string {
  return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

/**
 * Colorizes text with RGB foreground
 */
export function colorText(text: string, rgb: RGB, bold: boolean = false): string {
  const prefix = bold ? `${ANSI.BOLD}${fg(rgb)}` : fg(rgb);
  return `${prefix}${text}${ANSI.RESET}`;
}

/**
 * Strips ANSI escape codes from string to get pure visual text
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Calculates visible display width of a string (ignoring ANSI codes and accounting for fullwidth unicode and emojis)
 */
export function getVisualWidth(str: string): number {
  const clean = stripAnsi(str);
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean)) {
    const code = segment.codePointAt(0) || 0;
    if (
      code === 0xfe0f ||
      code === 0x200d ||
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0xfe00 && code <= 0xfe0f)
    ) {
      continue;
    }
    const hasEmojiPresentation = segment.includes('\ufe0f');
    if (
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f000 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3ffff) ||
      (hasEmojiPresentation && code >= 0x2000 && code <= 0x2bff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Truncates string to a max visual width with optional ellipsis
 */
export function truncate(str: string, maxWidth: number, ellipsis: string = '…'): string {
  if (maxWidth <= 0) return '';
  const visualLen = getVisualWidth(str);
  if (visualLen <= maxWidth) return str;

  const ellipsisLen = getVisualWidth(ellipsis);
  const targetWidth = Math.max(1, maxWidth - ellipsisLen);

  const clean = stripAnsi(str);
  let curWidth = 0;
  let result = '';

  for (const { segment } of graphemeSegmenter.segment(clean)) {
    const segWidth = getVisualWidth(segment);
    if (curWidth + segWidth > targetWidth) break;
    curWidth += segWidth;
    result += segment;
  }

  return result + ellipsis;
}

/**
 * Keeps the visible tail of a string within max visual width (for input fields).
 */
export function sliceVisualEnd(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const clean = stripAnsi(str);
  if (getVisualWidth(clean) <= maxWidth) return clean;

  const segments = Array.from(graphemeSegmenter.segment(clean), (s) => s.segment);
  let width = 0;
  const taken: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    const segWidth = getVisualWidth(segments[i]);
    if (width + segWidth > maxWidth) break;
    taken.unshift(segments[i]);
    width += segWidth;
  }
  return taken.join('');
}

/**
 * Pads string to exact visual width
 */
export function pad(str: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const curWidth = getVisualWidth(str);
  if (curWidth >= width) return str;

  const diff = width - curWidth;
  if (align === 'right') {
    return ' '.repeat(diff) + str;
  } else if (align === 'center') {
    const leftPad = Math.floor(diff / 2);
    const rightPad = diff - leftPad;
    return ' '.repeat(leftPad) + str + ' '.repeat(rightPad);
  }
  return str + ' '.repeat(diff);
}

/**
 * Linearly interpolates between two RGB colors with t in [0.0, 1.0]
 */
export function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
  const clampedT = Math.max(0, Math.min(1, t));
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * clampedT),
    Math.round(c1[1] + (c2[1] - c1[1]) * clampedT),
    Math.round(c1[2] + (c2[2] - c1[2]) * clampedT),
  ];
}

/**
 * Multi-stop gradient color evaluation
 */
export function sampleGradient(stops: RGB[], t: number): RGB {
  if (stops.length === 0) return [255, 255, 255];
  if (stops.length === 1) return stops[0];

  const clampedT = Math.max(0, Math.min(1, t));
  const segmentCount = stops.length - 1;
  const scaledT = clampedT * segmentCount;
  const index = Math.min(Math.floor(scaledT), segmentCount - 1);
  const localT = scaledT - index;

  return lerpColor(stops[index], stops[index + 1], localT);
}

/**
 * Applies a smooth RGB gradient across characters of a string
 */
export function gradientText(text: string, colorStops: RGB[], bold: boolean = false): string {
  const clean = stripAnsi(text);
  if (clean.length === 0) return '';
  if (colorStops.length <= 1) {
    const c = colorStops[0] || [255, 255, 255];
    return colorText(text, c, bold);
  }

  const segments = Array.from(graphemeSegmenter.segment(clean), (s) => s.segment);
  const total = segments.length;
  let result = bold ? ANSI.BOLD : '';

  for (let i = 0; i < total; i++) {
    const t = total > 1 ? i / (total - 1) : 0;
    const color = sampleGradient(colorStops, t);
    result += `${fg(color)}${segments[i]}`;
  }

  result += ANSI.RESET;
  return result;
}

/**
 * Renders a rounded box with borders and optional header
 */
export function drawBox(
  lines: string[],
  width: number,
  borderColor: RGB,
  title?: string,
  titleBadge?: { text: string; bg: RGB; fg: RGB }
): string[] {
  const boxW = Math.max(10, width);
  const innerW = boxW - 2;
  const result: string[] = [];

  const bFg = fg(borderColor);
  const reset = ANSI.RESET;

  // Top border
  let topBorder = `${bFg}╭`;
  if (title) {
    const badgeWidth = titleBadge ? getVisualWidth(titleBadge.text) + 6 : 0;
    const maxTitleLen = Math.max(0, innerW - 2 - badgeWidth);
    const safeTitle = maxTitleLen > 3 ? truncate(title, maxTitleLen) : '';

    if (safeTitle.length > 0) {
      const styledTitle = ` ${safeTitle} `;
      topBorder += `─${ANSI.BOLD}${colorText(styledTitle, borderColor)}${reset}${bFg}`;
      const titleWidth = getVisualWidth(styledTitle);
      let remaining = Math.max(0, innerW - 1 - titleWidth);

      if (titleBadge && remaining >= getVisualWidth(titleBadge.text) + 4) {
        const badgeStr = ` ${bg(titleBadge.bg)}${fg(titleBadge.fg)} ${titleBadge.text} ${reset}${bFg} `;
        const fillLen = remaining - getVisualWidth(titleBadge.text) - 4;
        topBorder += '─'.repeat(Math.max(1, fillLen)) + badgeStr;
      } else {
        topBorder += '─'.repeat(remaining);
      }
    } else {
      topBorder += '─'.repeat(innerW);
    }
  } else {
    topBorder += '─'.repeat(innerW);
  }
  topBorder += `╮${reset}`;
  result.push(topBorder);

  // Content lines
  for (const line of lines) {
    const cleanLen = getVisualWidth(line);
    const safeLine = cleanLen > innerW ? truncate(line, innerW) : line;
    const safeLen = getVisualWidth(safeLine);
    const padLen = Math.max(0, innerW - safeLen);
    result.push(`${bFg}│${reset}${safeLine}${' '.repeat(padLen)}${bFg}│${reset}`);
  }

  // Bottom border
  result.push(`${bFg}╰${'─'.repeat(innerW)}╯${reset}`);

  return result;
}

export class ScreenBuffer {
  private lastRenderedBuffer: string = '';
  private isAltScreen: boolean = false;
  private lastWidth: number = 0;
  private lastHeight: number = 0;

  public init(): void {
    if (process.stdout.isTTY) {
      process.stdout.write(ANSI.ALT_SCREEN_ON + ANSI.HIDE_CURSOR + ANSI.WRAP_OFF + ANSI.CLEAR_SCREEN);
      this.isAltScreen = true;
      const dims = this.getDimensions();
      this.lastWidth = dims.width;
      this.lastHeight = dims.height;

      process.stdout.on('resize', () => {
        process.stdout.write(ANSI.CLEAR_SCREEN);
        this.lastRenderedBuffer = '';
      });
    }
    const cleanup = () => {
      this.destroy();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('exit', () => this.destroy());
  }

  public getDimensions(): TerminalDimensions {
    return {
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24,
    };
  }

  public render(output: string): void {
    const dims = this.getDimensions();
    if (dims.width !== this.lastWidth || dims.height !== this.lastHeight) {
      this.lastWidth = dims.width;
      this.lastHeight = dims.height;
      process.stdout.write(ANSI.CLEAR_SCREEN);
      this.lastRenderedBuffer = '';
    }

    if (output === this.lastRenderedBuffer) return;
    this.lastRenderedBuffer = output;
    process.stdout.write(ANSI.SYNC_START + ANSI.CURSOR_HOME + output + ANSI.SYNC_END);
  }
  public clear(): void {
    if (process.stdout.isTTY) {
      process.stdout.write(ANSI.CLEAR_SCREEN);
      this.lastRenderedBuffer = '';
    }
  }

  public destroy(): void {
    if (this.isAltScreen && process.stdout.isTTY) {
      process.stdout.write(ANSI.WRAP_ON + ANSI.SHOW_CURSOR + ANSI.ALT_SCREEN_OFF);
      this.isAltScreen = false;
    }
  }
}
