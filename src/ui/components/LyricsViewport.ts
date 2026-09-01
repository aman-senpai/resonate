import { LyricLine, PlayerState, Song, Theme } from '../../types.js';
import { formatMsToTime } from '../../parser/lrc.js';
import { ANSI, colorText, fg, getVisualWidth, lerpColor, pad, truncate } from '../renderer.js';

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
export interface LyricsViewportOptions {
  width: number;
  height: number;
  song: Song | null;
  state: PlayerState;
  theme: Theme;
  showTimestamps?: boolean;
}

export function renderLyricsViewport(opts: LyricsViewportOptions): string[] {
  const { width, height, song, state, theme, showTimestamps = false } = opts;
  const lines: string[] = [];
  const innerWidth = Math.max(10, width - 2);
  const innerHeight = Math.max(3, height);

  if (!song || song.lyrics.length === 0) {
    const emptyMsg = 'No lyrics loaded. Press / to search songs.';
    const midY = Math.floor(innerHeight / 2);
    for (let y = 0; y < innerHeight; y++) {
      if (y === midY) {
        const padded = pad(colorText(emptyMsg, theme.dimmed), innerWidth, 'center');
        lines.push(padded);
      } else {
        lines.push(' '.repeat(innerWidth));
      }
    }
    return lines;
  }

  const activeIdx = state.activeLineIndex >= 0 ? state.activeLineIndex : 0;
  const halfView = Math.floor(innerHeight / 2);
  const startIdx = activeIdx - halfView;
  const endIdx = startIdx + innerHeight;

  for (let i = startIdx; i < endIdx; i++) {
    if (i < 0 || i >= song.lyrics.length) {
      lines.push(' '.repeat(innerWidth));
      continue;
    }

    const lyricLine = song.lyrics[i];
    const isCurrent = i === state.activeLineIndex;
    const distance = Math.abs(i - (state.activeLineIndex >= 0 ? state.activeLineIndex : 0));

    // Optional timestamp prefix
    let timePrefix = '';
    if (showTimestamps) {
      const tStr = formatMsToTime(lyricLine.startMs, true);
      const tColor = isCurrent ? theme.accent : distance <= 2 ? theme.dimmed : theme.subtle;
      timePrefix = `${colorText(`[${tStr}] `, tColor)}`;
    }

    let renderedLine: string;

    if (isCurrent) {
      renderedLine = renderActiveLine(lyricLine, state, theme, innerWidth - getVisualWidth(timePrefix), timePrefix);
    } else if (i < (state.activeLineIndex >= 0 ? state.activeLineIndex : 0)) {
      // Past line: exponential decay dimming
      renderedLine = renderPastLine(lyricLine, distance, theme, innerWidth - getVisualWidth(timePrefix), timePrefix);
    } else {
      // Upcoming line: soft anticipation glow
      renderedLine = renderUpcomingLine(lyricLine, distance, theme, innerWidth - getVisualWidth(timePrefix), timePrefix);
    }

    lines.push(renderedLine);
  }

  return lines;
}

export function isMusicalNoteLine(line: LyricLine): boolean {
  if (line.isInstrumental) return true;
  const text = (line.text || '').trim();
  if (!text) return true;
  if (/^[♪♫\s*—\-–(instrumental)musicalinterlude]+$/i.test(text)) return true;
  if (/^(♪|♫|\(instrumental\)|\(instrumental break\)|instrumental)/i.test(text)) return true;
  return false;
}

export function formatMusicalNoteText(line: LyricLine): string {
  const text = (line.text || '').trim();
  if (!text || /^\(?(instrumental|instrumental break|musical interlude|---)\)?$/i.test(text)) {
    return '♪   ♪   ♪';
  }
  return text;
}

function getShimmerColor(theme: Theme, timeMs: number, offset: number = 0): [number, number, number] {
  // Smooth breathing shimmer cycle (~2.5s period)
  const t = (timeMs + offset) / 400;
  const shimmerFactor = (Math.sin(t) + 1) / 2;
  if (shimmerFactor < 0.5) {
    return lerpColor(theme.primary, theme.accent, shimmerFactor * 2);
  }
  return lerpColor(theme.accent, theme.highlight, (shimmerFactor - 0.5) * 2);
}

function renderShimmerNotes(text: string, theme: Theme, timeMs: number, availWidth: number): string {
  const cleanText = getVisualWidth(text) > availWidth ? truncate(text, availWidth) : text;
  const graphemes = Array.from(graphemeSegmenter.segment(cleanText), (s) => s.segment);
  let result = '';
  for (let i = 0; i < graphemes.length; i++) {
    const ch = graphemes[i];
    if (/\s/.test(ch)) {
      result += ch;
    } else {
      const color = getShimmerColor(theme, timeMs, i * 160);
      result += `${ANSI.BOLD}${fg(color)}${ch}${ANSI.RESET}`;
    }
  }
  return result;
}

function renderActiveLine(
  line: LyricLine,
  state: PlayerState,
  theme: Theme,
  maxWidth: number,
  timePrefix: string
): string {
  const icon = colorText('▶ ', theme.accent, true);
  const availWidth = Math.max(5, maxWidth - getVisualWidth(icon));

  if (isMusicalNoteLine(line)) {
    const noteText = formatMusicalNoteText(line);
    const shimmerText = renderShimmerNotes(noteText, theme, state.currentTimeMs, availWidth);
    return `${icon}${timePrefix}${shimmerText}`;
  }

  const text = line.text;
  if (!text) {
    const shimmerText = renderShimmerNotes('♪   ♪   ♪', theme, state.currentTimeMs, availWidth);
    return `${icon}${timePrefix}${shimmerText}`;
  }

  // Check if we have word-level timings
  if (line.words && line.words.length > 0) {
    let lineFormatted = '';
    for (let w = 0; w < line.words.length; w++) {
      const word = line.words[w];
      const isWordActive = w === state.activeWordIndex;
      const isWordPast = w < state.activeWordIndex || (state.activeWordIndex === -1 && state.lineProgressRatio > 0.5);

      if (isWordActive) {
        // Highlighting current singing word with bold glow and underline
        lineFormatted += `${ANSI.BOLD}${ANSI.UNDERLINE}${fg(theme.highlight)}${word.text}${ANSI.RESET}`;
      } else if (isWordPast) {
        lineFormatted += `${ANSI.BOLD}${fg(theme.activeLine)}${word.text}${ANSI.RESET}`;
      } else {
        lineFormatted += `${fg(theme.primary)}${word.text}${ANSI.RESET}`;
      }
    }
    return `${icon}${timePrefix}${lineFormatted}`;
  }

  // Smooth grapheme-by-grapheme karaoke fill
  const cleanText = getVisualWidth(text) > availWidth ? truncate(text, availWidth) : text;
  const graphemes = Array.from(graphemeSegmenter.segment(cleanText), (s) => s.segment);
  const ratio = Math.max(0, Math.min(1.0, state.lineProgressRatio));
  const fillCharCount = Math.floor(ratio * graphemes.length);

  const filledPart = graphemes.slice(0, fillCharCount).join('');
  const remainingPart = graphemes.slice(fillCharCount).join('');

  const styledFilled = filledPart.length > 0 ? `${ANSI.BOLD}${fg(theme.highlight)}${filledPart}${ANSI.RESET}` : '';
  const styledRemaining = remainingPart.length > 0 ? `${ANSI.BOLD}${fg(theme.activeLine)}${remainingPart}${ANSI.RESET}` : '';

  const fullActive = `${styledFilled}${styledRemaining}`;
  return `${icon}${timePrefix}${fullActive}`;
}

function renderPastLine(
  line: LyricLine,
  distance: number,
  theme: Theme,
  maxWidth: number,
  timePrefix: string
): string {
  const icon = '  ';
  const availWidth = Math.max(5, maxWidth - getVisualWidth(icon));

  // Decay color based on distance: distance 1 is 65% bright, distance 2 is 40%, etc.
  const decayFactor = Math.pow(0.55, distance);
  const fadedColor = lerpColor(theme.background, theme.dimmed, Math.max(0.15, decayFactor));

  const text = isMusicalNoteLine(line) ? formatMusicalNoteText(line) : line.text || ' ';
  const styledText = colorText(truncate(text, availWidth), fadedColor);

  return `${icon}${timePrefix}${styledText}`;
}

function renderUpcomingLine(
  line: LyricLine,
  distance: number,
  theme: Theme,
  maxWidth: number,
  timePrefix: string
): string {
  const icon = '  ';
  const availWidth = Math.max(5, maxWidth - getVisualWidth(icon));

  const text = isMusicalNoteLine(line) ? formatMusicalNoteText(line) : line.text || ' ';

  let styledText: string;
  if (distance === 1) {
    // Next immediate line: soft bright anticipation
    styledText = colorText(truncate(text, availWidth), theme.text);
  } else {
    // Distant upcoming lines: fade toward subtle
    const decayFactor = Math.pow(0.65, distance - 1);
    const fadedColor = lerpColor(theme.subtle, theme.dimmed, decayFactor);
    styledText = colorText(truncate(text, availWidth), fadedColor);
  }

  return `${icon}${timePrefix}${styledText}`;
}
