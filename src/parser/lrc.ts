import { LyricLine, LyricWord, Song } from '../types.js';

export interface ParsedLrc {
  title?: string;
  artist?: string;
  album?: string;
  offsetMs?: number;
  durationMs?: number;
  lines: LyricLine[];
}

/**
 * Parses timestamp string like "01:23.45", "01:23.456", or "01:23" into milliseconds
 */
export function parseTimestampToMs(timeStr: string): number {
  const parts = timeStr.trim().split(':');
  if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1]);
    if (!isNaN(minutes) && !isNaN(seconds)) {
      return Math.round((minutes * 60 + seconds) * 1000);
    }
  } else if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    if (!isNaN(hours) && !isNaN(minutes) && !isNaN(seconds)) {
      return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
    }
  }
  return 0;
}

/**
 * Formats milliseconds into [mm:ss] or [mm:ss.xx]
 */
export function formatMsToTime(ms: number, includeMs: boolean = false): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');

  if (includeMs) {
    const centiseconds = Math.floor((Math.max(0, ms) % 1000) / 10);
    const xx = centiseconds.toString().padStart(2, '0');
    return `${mm}:${ss}.${xx}`;
  }

  return `${mm}:${ss}`;
}

/**
 * Parses an LRC string (standard or enhanced) into structured LyricLine items
 */
export function parseLrc(lrcContent: string): ParsedLrc {
  const lines = lrcContent.split(/\r?\n/);
  let title: string | undefined;
  let artist: string | undefined;
  let album: string | undefined;
  let offsetMs = 0;
  let durationMs: number | undefined;

  const rawEntries: Array<{ startMs: number; rawText: string }> = [];

  const tagRegex = /^\[([a-zA-Z]+):(.*)\]$/;
  const timeRegex = /\[(\d{1,2}:\d{2}(?:\.\d{1,3})?)\]/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check metadata tags like [ti:Title]
    const tagMatch = trimmed.match(tagRegex);
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase();
      const value = tagMatch[2].trim();
      if (tag === 'ti') title = value;
      else if (tag === 'ar') artist = value;
      else if (tag === 'al') album = value;
      else if (tag === 'offset') {
        const parsedOffset = parseInt(value, 10);
        if (!isNaN(parsedOffset)) offsetMs = parsedOffset;
      } else if (tag === 'length') {
        durationMs = parseTimestampToMs(value);
      }
      continue;
    }

    // Check line with one or multiple timestamps: [00:12.34][00:45.67]Text
    const matches = Array.from(trimmed.matchAll(timeRegex));
    if (matches.length > 0) {
      const textWithoutTags = trimmed.replace(timeRegex, '').trim();
      for (const match of matches) {
        const startMs = parseTimestampToMs(match[1]) + offsetMs;
        rawEntries.push({ startMs, rawText: textWithoutTags });
      }
    }
  }

  // Sort chronologically
  rawEntries.sort((a, b) => a.startMs - b.startMs);

  // Process word-level timings if available (Enhanced LRC e.g. <00:12.34>word)
  const wordTimeRegex = /<(\d{1,2}:\d{2}(?:\.\d{1,3})?)>([^<]*)/g;
  const lyricLines: LyricLine[] = [];

  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    const nextEntry = rawEntries[i + 1];

    let cleanText = entry.rawText;
    const words: LyricWord[] = [];

    // Check for word timing tags <mm:ss.xx>
    const wordMatches = Array.from(entry.rawText.matchAll(wordTimeRegex));
    if (wordMatches.length > 0) {
      cleanText = '';
      for (let j = 0; j < wordMatches.length; j++) {
        const wMatch = wordMatches[j];
        const wStartMs = parseTimestampToMs(wMatch[1]) + offsetMs;
        const wText = wMatch[2];
        const nextWMatch = wordMatches[j + 1];
        const wEndMs = nextWMatch
          ? parseTimestampToMs(nextWMatch[1]) + offsetMs
          : nextEntry
          ? nextEntry.startMs
          : wStartMs + Math.max(800, wText.length * 80);

        cleanText += wText;
        if (wText.trim()) {
          words.push({
            text: wText,
            startMs: wStartMs,
            endMs: wEndMs,
          });
        }
      }
    }

    // Calculate smart end time for line
    let lineEndMs: number;
    if (nextEntry) {
      const gap = nextEntry.startMs - entry.startMs;
      // If gap is large (e.g. musical solo > 8s), don't extend line forever
      if (gap > 8000) {
        const estimatedDuration = Math.min(gap - 1000, Math.max(2500, cleanText.length * 100));
        lineEndMs = entry.startMs + estimatedDuration;
      } else {
        lineEndMs = Math.max(entry.startMs + 500, nextEntry.startMs - 150);
      }
    } else {
      // Last line: estimate based on length or duration
      const estimatedDuration = Math.max(3000, cleanText.length * 120);
      lineEndMs = durationMs ? Math.max(entry.startMs + 3000, durationMs) : entry.startMs + estimatedDuration;
    }

    const isInstrumental = cleanText === '' || /^(♪|♫|\*|instrumental|\(instrumental\)|---)/i.test(cleanText);

    lyricLines.push({
      id: i,
      text: cleanText,
      startMs: Math.max(0, entry.startMs),
      endMs: Math.max(entry.startMs + 300, lineEndMs),
      words: words.length > 0 ? words : undefined,
      isInstrumental,
    });
  }

  // Determine total duration
  if (!durationMs && lyricLines.length > 0) {
    durationMs = lyricLines[lyricLines.length - 1].endMs + 2000;
  }

  return {
    title,
    artist,
    album,
    offsetMs,
    durationMs: durationMs || 180000,
    lines: lyricLines,
  };
}

/**
 * Creates a Song object from plain lyrics text or raw LRC
 */
export function createSongFromText(
  title: string,
  artist: string,
  rawContent: string,
  album?: string,
  durationSec?: number
): Song {
  // Check if content looks like LRC
  if (/\[\d{1,2}:\d{2}/.test(rawContent)) {
    const parsed = parseLrc(rawContent);
    return {
      id: `${artist}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      title: parsed.title || title,
      artist: parsed.artist || artist,
      album: parsed.album || album || 'Single',
      durationMs: durationSec ? durationSec * 1000 : parsed.durationMs || 180000,
      lyrics: parsed.lines,
      plainLyrics: parsed.lines.map((l) => l.text).join('\n'),
    };
  }

  // Plain text fallback: split by lines and estimate spacing
  const rawLines = rawContent.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const totalDurationMs = (durationSec || Math.max(120, rawLines.length * 4)) * 1000;
  const lineSpacing = rawLines.length > 0 ? totalDurationMs / rawLines.length : 3000;

  const lyricLines: LyricLine[] = rawLines.map((text, idx) => {
    const startMs = Math.round(idx * lineSpacing);
    const endMs = Math.round(Math.min(totalDurationMs, (idx + 1) * lineSpacing - 200));
    return {
      id: idx,
      text,
      startMs,
      endMs,
      isInstrumental: false,
    };
  });

  return {
    id: `${artist}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title,
    artist,
    album: album || 'Single',
    durationMs: totalDurationMs,
    lyrics: lyricLines,
    plainLyrics: rawContent,
  };
}
