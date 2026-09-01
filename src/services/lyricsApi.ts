import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SearchResult, Song } from '../types.js';
import { createSongFromText } from '../parser/lrc.js';
import { fetchYtMusicLyrics, searchYtMusic } from './ytmusic.js';
import { getAlbumArtAnsi } from './albumArt.js';

interface LrclibSearchItem {
  id: number;
  name?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string;
  plainLyrics?: string;
}

interface LrclibGetItem {
  id: number;
  name?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string;
  plainLyrics?: string;
}
const CACHE_DIR = path.join(os.homedir(), '.config', 'resonate', 'songs');
function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Searches online YouTube Music and LRCLIB lyrics database
 */
export async function searchLyrics(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const results: SearchResult[] = [];

  // Run YouTube Music search and LRCLIB search in parallel
  const [ytResults, lrclibResults] = await Promise.allSettled([
    searchYtMusic(trimmed, 'all'),
    searchLrclib(trimmed),
  ]);

  if (ytResults.status === 'fulfilled') {
    for (const item of ytResults.value) {
      results.push(item);
    }
  }

  if (lrclibResults.status === 'fulfilled') {
    for (const item of lrclibResults.value) {
      const isDup = results.some(
        (r) =>
          r.title.toLowerCase() === item.title.toLowerCase() &&
          r.artist.toLowerCase() === item.artist.toLowerCase()
      );
      if (!isDup) {
        results.push(item);
      }
    }
  }

  return results;
}

async function searchLrclib(query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  try {
    const encoded = encodeURIComponent(query);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(`https://lrclib.net/api/search?q=${encoded}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Resonate-CLI/1.0 (https://github.com/aman-senpai/resonate)',
      },
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as unknown;
      if (Array.isArray(data)) {
        for (const item of data as LrclibSearchItem[]) {
          results.push({
            id: item.id,
            title: item.trackName || item.name || 'Unknown Track',
            artist: item.artistName || 'Unknown Artist',
            album: item.albumName,
            duration: item.duration ? Math.round(item.duration) : undefined,
            hasSynced: Boolean(item.syncedLyrics),
            source: 'online',
            rawLrc: item.syncedLyrics || item.plainLyrics,
          });
        }
      }
    }
  } catch {
    // Timeout or network error
  }
  return results;
}

/**
 * Fetches full song lyrics by ID or search result (YouTube Music + LRCLIB fallback)
 */
export async function fetchSongDetails(result: SearchResult): Promise<Song | null> {
  // If it's a YouTube Music track or ID string
  // If it's a YouTube Music track
  if (result.source === 'youtube' || typeof result.id === 'string') {
    const videoId = String(result.id);
    let lyricsContent: string | null = null;

    // 1. Try to find synced lyrics on LRCLIB using title & clean artist
    try {
      const cleanArtist = result.artist.split(',')[0].replace(/- Topic$/i, '').trim();
      const cleanTitle = result.title.replace(/\(Official.+?\)|\[Official.+?\]|\(Lyrics\)|\[Lyrics\]/gi, '').trim();
      const lrclibRes = await fetch(
        `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`,
        { headers: { 'User-Agent': 'Resonate-CLI/1.0' }, signal: AbortSignal.timeout(4000) }
      );
      if (lrclibRes.ok) {
        const lrcData = (await lrclibRes.json()) as LrclibGetItem;
        if (lrcData.syncedLyrics) {
          lyricsContent = lrcData.syncedLyrics;
        } else if (lrcData.plainLyrics) {
          lyricsContent = lrcData.plainLyrics;
        }
      }
    } catch {
      // Continue to YTM lyrics
    }

    // 2. If no lyrics yet, try YouTube Music native lyrics
    if (!lyricsContent) {
      try {
        const ytLyrics = await fetchYtMusicLyrics(videoId);
        if (ytLyrics) {
          lyricsContent = ytLyrics;
        }
      } catch {
        // No lyrics found
      }
    }

    // 3. Create song structure
    const fallbackText = lyricsContent || `[00:00.00] ${result.title} - ${result.artist}\n[00:05.00] (Instrumental / No synced lyrics available)`;
    const song = createSongFromText(
      result.title,
      result.artist,
      fallbackText,
      result.album,
      result.duration ? result.duration : 180
    );

    song.id = videoId;
    song.source = 'youtube';
    song.thumbnailUrl = result.thumbnailUrl;

    if (result.thumbnailUrl) {
      // Async prefetch album art ANSI
      getAlbumArtAnsi(result.thumbnailUrl, 26, 13).then(({ lines, dominantColor }) => {
        song.art = lines;
        song.coverColor = dominantColor;
      }).catch(() => {});
    }

    saveSongToCache(song, fallbackText);
    return song;
  }

  // Check if we already have the raw LRC attached
  if (result.rawLrc) {
    const song = createSongFromText(result.title, result.artist, result.rawLrc, result.album, result.duration);
    song.thumbnailUrl = result.thumbnailUrl;
    if (result.thumbnailUrl) {
      getAlbumArtAnsi(result.thumbnailUrl, 26, 13).then(({ lines, dominantColor }) => {
        song.art = lines;
        song.coverColor = dominantColor;
      }).catch(() => {});
    }
    saveSongToCache(song, result.rawLrc);
    return song;
  }

  // Fetch from LRCLIB get API by item ID
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(`https://lrclib.net/api/get/${result.id}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Resonate-CLI/1.0',
      },
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as LrclibGetItem;
      const lrcContent = data.syncedLyrics || data.plainLyrics;
      if (lrcContent) {
        const song = createSongFromText(
          data.trackName || data.name || result.title,
          data.artistName || result.artist,
          lrcContent,
          data.albumName || result.album,
          data.duration || result.duration
        );
        song.thumbnailUrl = result.thumbnailUrl;
        if (result.thumbnailUrl) {
          getAlbumArtAnsi(result.thumbnailUrl, 26, 13).then(({ lines, dominantColor }) => {
            song.art = lines;
            song.coverColor = dominantColor;
          }).catch(() => {});
        }
        saveSongToCache(song, lrcContent);
        return song;
      }
    }
  } catch {
    // Fetch failed
  }

  return null;
}

/**
 * Reads local LRC or text file from filesystem
 */
export function loadLocalLrcFile(filePath: string): Song {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  const baseName = path.basename(filePath, path.extname(filePath));

  let artist = 'Local Track';
  let title = baseName;
  if (baseName.includes(' - ')) {
    const parts = baseName.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }

  const song = createSongFromText(title, artist, content);
  song.source = 'local';
  return song;
}

function saveSongToCache(song: Song, rawLrc: string): void {
  try {
    ensureCacheDir();
    const safeName = `${song.artist}_${song.title}`.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const filePath = path.join(CACHE_DIR, `${safeName}.lrc`);
    fs.writeFileSync(filePath, rawLrc, 'utf-8');
  } catch {
    // Cache write failure non-critical
  }
}
