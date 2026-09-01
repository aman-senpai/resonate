import { Innertube, Log, UniversalCache } from 'youtubei.js';

Log.setLevel(Log.Level.NONE);
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SearchResult, Song, YtExploreCategory, YtPlaylist, YtTrack } from '../types.js';
import { findExecutable, getCookiesFilePath, loadAuthCredentials, saveAuthCredentials } from './auth.js';
import { getCachedMediaPath, getCachedStreamUrl, prefetchMediaFile, rememberStreamUrl as persistStreamUrl } from './mediaCache.js';
const execFileAsync = promisify(execFile);

let innertubeInstance: Innertube | null = null;
let isInitializing: boolean = false;
let initPromise: Promise<Innertube> | null = null;

const CACHE_DIR = path.join(os.homedir(), '.config', 'resonate', 'cache');

export async function getYtMusicClient(): Promise<Innertube> {
  if (innertubeInstance) return innertubeInstance;
  if (isInitializing && initPromise) return initPromise;

  isInitializing = true;
  initPromise = (async () => {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      const creds = loadAuthCredentials();
      const cookie = creds?.cookie;

      const yt = await Innertube.create({
        cache: new UniversalCache(true, CACHE_DIR),
        cookie: cookie || undefined,
        generate_session_locally: true,
      });

      // If OAuth tokens exist, sign in
      if (creds?.oauthToken) {
        try {
          await yt.session.signIn(creds.oauthToken as any);
        } catch {
          // If token refresh fails, proceed with guest or cookie session
        }
      }

      // Listen for token updates
      yt.session.on('update-credentials', ({ credentials }) => {
        const current = loadAuthCredentials() || {};
        current.oauthToken = credentials as any;
        current.lastChecked = Date.now();
        saveAuthCredentials(current);
      });

      innertubeInstance = yt;
      return yt;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
}

export function resetYtClient(): void {
  innertubeInstance = null;
  initPromise = null;
}

/**
 * Searches YouTube Music for songs, albums, playlists, artists
 */
export async function searchYtMusic(query: string, type: 'song' | 'video' | 'album' | 'playlist' | 'artist' | 'all' = 'all'): Promise<SearchResult[]> {
  const yt = await getYtMusicClient();
  const results: SearchResult[] = [];

  try {
    if (type === 'all') {
      const [songsRes, albumsRes, playlistsRes, videosRes] = await Promise.allSettled([
        yt.music.search(query, { type: 'song' }),
        yt.music.search(query, { type: 'album' }),
        yt.music.search(query, { type: 'playlist' }),
        yt.music.search(query, { type: 'video' }),
      ]);

      if (songsRes.status === 'fulfilled') {
        const contents = extractSearchContents(songsRes.value, 'song');
        for (const item of contents) {
          results.push(mapYtMusicItemToSearchResult(item, 'song'));
        }
      }

      if (albumsRes.status === 'fulfilled') {
        const contents = extractSearchContents(albumsRes.value, 'album');
        for (const item of contents) {
          results.push(mapYtMusicItemToSearchResult(item, 'album'));
        }
      }

      if (playlistsRes.status === 'fulfilled') {
        const contents = extractSearchContents(playlistsRes.value, 'playlist');
        for (const item of contents) {
          results.push(mapYtMusicItemToSearchResult(item, 'playlist'));
        }
      }

      if (videosRes.status === 'fulfilled') {
        const contents = extractSearchContents(videosRes.value, 'video');
        for (const item of contents) {
          results.push(mapYtMusicItemToSearchResult(item, 'video'));
        }
      }
    } else {
      const searchRes = await yt.music.search(query, { type: type as any });
      const contents = extractSearchContents(searchRes, type);
      for (const item of contents) {
        results.push(mapYtMusicItemToSearchResult(item, type));
      }
    }
  } catch (err: any) {
    // Fallback if specific search structure differs
    try {
      const generalSearch = await yt.search(query);
      if (generalSearch.results) {
        for (const res of generalSearch.results.slice(0, 15)) {
          if ((res as any).id) {
            results.push({
              id: (res as any).id,
              title: (res as any).title?.text || (res as any).title || 'Unknown Title',
              artist: (res as any).author?.name || (res as any).short_byline?.text || 'YouTube',
              duration: (res as any).duration?.seconds || 180,
              hasSynced: false,
              source: 'youtube',
              type: 'song',
              thumbnailUrl: (res as any).thumbnails?.[0]?.url,
            });
          }
        }
      }
    } catch {
      // Return whatever collected
    }
  }

  return results;
}

function extractSearchContents(searchRes: any, type: string): any[] {
  if (!searchRes) return [];
  if (type === 'song' && searchRes.songs?.contents) return searchRes.songs.contents;
  if (type === 'album' && searchRes.albums?.contents) return searchRes.albums.contents;
  if (type === 'playlist' && searchRes.playlists?.contents) return searchRes.playlists.contents;
  if (type === 'video' && searchRes.videos?.contents) return searchRes.videos.contents;
  if (searchRes.contents?.[0]?.contents) return searchRes.contents[0].contents;
  if (Array.isArray(searchRes.contents)) return searchRes.contents;
  return [];
}

function mapYtMusicItemToSearchResult(item: any, type: SearchResult['type']): SearchResult {
  const title = item.title?.text || item.title || 'Unknown Title';
  let artist = 'YouTube Music';
  if (item.artists && item.artists.length > 0) {
    artist = item.artists.map((a: any) => a.name || a.text || '').filter(Boolean).join(', ');
  } else if (item.author?.name || item.author?.text) {
    artist = item.author.name || item.author.text;
  } else if (item.artists_or_type?.text) {
    artist = item.artists_or_type.text;
  } else if (item.flex_columns?.[1]?.title?.text) {
    const sub = item.flex_columns[1].title.text;
    if (sub && !sub.startsWith('Song •') && !sub.startsWith('Video •')) {
      artist = sub.split('•')[0].trim();
    }
  }

  const album = item.album?.name || item.album?.text;
  let duration = 0;
  if (item.duration?.seconds) {
    duration = item.duration.seconds;
  } else if (typeof item.duration?.text === 'string') {
    duration = parseDurationText(item.duration.text);
  }

  const thumbnailUrl = extractThumbnailUrl(item) || '';

  const id = item.id || item.video_id || item.playlist_id || item.endpoint?.payload?.videoId || item.endpoint?.payload?.playlistId || '';

  return {
    id,
    title,
    artist,
    album,
    duration,
    hasSynced: false,
    source: 'youtube',
    type: type || 'song',
    thumbnailUrl,
  };
}

function parseDurationText(text: string): number {
  const parts = text.split(':').map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

function audioFormatUrl(fmt: unknown, player: unknown): string | undefined {
  if (!fmt || typeof fmt !== 'object') return undefined;
  if ('decipher' in fmt && typeof fmt.decipher === 'function') {
    const decoded = fmt.decipher(player);
    if (typeof decoded === 'string' && (decoded.startsWith('http://') || decoded.startsWith('https://'))) {
      return decoded;
    }
  }
  if ('url' in fmt && typeof fmt.url === 'string' && (fmt.url.startsWith('http://') || fmt.url.startsWith('https://'))) {
    return fmt.url;
  }
  return undefined;
}

export function isStreamRef(input: string): boolean {
  if (!input) return false;
  const t = input.trim();
  if (t.startsWith('http://') || t.startsWith('https://') || t.startsWith('file://')) return true;
  if (t.startsWith('/') || /^[A-Za-z]:[\\/]/.test(t)) return true;
  return /^[a-zA-Z0-9_-]{11}$/.test(t);
}

const streamCache = new Map<string, { url: string; expiresAt: number }>();
const inflightStreams = new Map<string, Promise<string>>();

function streamCacheKey(input: string): string {
  const id = extractVideoId(input);
  return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : input.trim();
}

function expiryFromStreamUrl(url: string): number {
  try {
    const parsed = new URL(url);
    const expire = parsed.searchParams.get('expire');
    if (expire) {
      const sec = parseInt(expire, 10);
      if (sec > 1e9) return sec * 1000 - 30_000;
    }
  } catch {
    // default TTL
  }
  return Date.now() + 5 * 60 * 1000;
}

function cachedStreamUrl(input: string): string | undefined {
  const key = streamCacheKey(input);
  const hit = streamCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.url;
  const disk = getCachedStreamUrl(key);
  if (disk) {
    streamCache.set(key, { url: disk, expiresAt: Date.now() + 5 * 60 * 1000 });
    return disk;
  }
  return undefined;
}

function rememberStreamUrl(input: string, url: string): void {
  const expiresAt = expiryFromStreamUrl(url);
  const key = streamCacheKey(input);
  streamCache.set(key, { url, expiresAt });
  persistStreamUrl(key, url, expiresAt);
}

export function prefetchAudioStream(videoIdOrUrl: string): void {
  if (!isStreamRef(videoIdOrUrl)) return;
  const key = streamCacheKey(videoIdOrUrl);
  if (/^[a-zA-Z0-9_-]{11}$/.test(key)) prefetchMediaFile(key);
  if (cachedStreamUrl(videoIdOrUrl) || getCachedMediaPath(key)) return;
  void resolveAudioStreamUrl(videoIdOrUrl).catch(() => {});
}

export async function resolveAudioStreamUrl(videoIdOrUrl: string): Promise<string> {
  const trimmed = videoIdOrUrl.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('file://') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }

  const key = streamCacheKey(trimmed);
  const file = /^[a-zA-Z0-9_-]{11}$/.test(key) ? getCachedMediaPath(key) : undefined;
  if (file) return file;

  const cached = cachedStreamUrl(trimmed);
  if (cached) return cached;

  const pending = inflightStreams.get(key);
  if (pending) return pending;

  const work = resolveAudioStreamUrlFresh(trimmed);
  inflightStreams.set(key, work);
  try {
    return await work;
  } finally {
    inflightStreams.delete(key);
  }
}

async function resolveAudioStreamUrlFresh(trimmed: string): Promise<string> {
  const videoId = extractVideoId(trimmed);
  const isId = /^[a-zA-Z0-9_-]{11}$/.test(videoId);
  const targetUrl = isId ? `https://music.youtube.com/watch?v=${videoId}` : trimmed;

  const ytDlpPath = findExecutable('yt-dlp');
  const cookiesFile = getCookiesFilePath();
  const cookiesOk = fs.existsSync(cookiesFile) && fs.statSync(cookiesFile).size > 80;

  if (ytDlpPath) {
    const args = ['-g', '-f', 'bestaudio/best', '--no-playlist', '--no-warnings'];
    if (cookiesOk) args.push('--cookies', cookiesFile);
    args.push(targetUrl);
    try {
      const { stdout } = await execFileAsync(ytDlpPath, args, { timeout: 20000 });
      const url = stdout.trim().split('\n').find((line) => line.startsWith('http://') || line.startsWith('https://'));
      if (url) {
        rememberStreamUrl(trimmed, url);
        return url;
      }
    } catch {
      if (cookiesOk) {
        try {
          const { stdout } = await execFileAsync(
            ytDlpPath,
            ['-g', '-f', 'bestaudio/best', '--no-playlist', '--no-warnings', targetUrl],
            { timeout: 20000 }
          );
          const url = stdout.trim().split('\n').find((line) => line.startsWith('http://') || line.startsWith('https://'));
          if (url) {
            rememberStreamUrl(trimmed, url);
            return url;
          }
        } catch {
          // Innertube fallback below
        }
      }
    }
  }

  if (isId) {
    try {
      const yt = await getYtMusicClient();
      const info = await yt.getInfo(videoId);
      const fmt: unknown = info.chooseFormat({ type: 'audio', quality: 'best' });
      const url = audioFormatUrl(fmt, yt.session.player);
      if (url) {
        rememberStreamUrl(trimmed, url);
        return url;
      }
    } catch {
      // fall through
    }
  }

  throw new Error(`Failed to resolve audio stream for ${trimmed}`);
}

export async function ensurePlayableSong(song: Song): Promise<Song> {
  if (song.audioUrl && isStreamRef(song.audioUrl)) return song;
  if (/^[a-zA-Z0-9_-]{11}$/.test((song.id || '').trim())) {
    song.source = song.source || 'youtube';
    return song;
  }
  const query = `${song.title || ''} ${song.artist || ''}`.trim();
  if (!query) return song;
  try {
    const results = await searchYtMusic(query, 'song');
    const hit = results.find((r) => typeof r.id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(r.id));
    if (hit && typeof hit.id === 'string') {
      song.audioUrl = hit.id;
      song.source = song.source || 'youtube';
      if (!song.thumbnailUrl && hit.thumbnailUrl) song.thumbnailUrl = hit.thumbnailUrl;
    }
  } catch {
    // lyrics-only playback remains available
  }
  return song;
}

export function extractVideoId(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/(?:v=|vi=|\/v\/|\/vi\/|\/embed\/|\/watch\?v=|youtu\.be\/|\/watch\?.+&v=|music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/);
  if (match) {
    return match[1];
  }
  return trimmed;
}

export function extractPlaylistId(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (/^(VL)?(PL|RD|LM|OLAK5uy)[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (match) {
    return match[1];
  }
  return trimmed;
}

/**
 * Fetches native lyrics from YouTube Music
 */
export async function fetchYtMusicLyrics(videoId: string): Promise<string | null> {
  const yt = await getYtMusicClient();
  try {
    const lyricsData = await yt.music.getLyrics(videoId);
    if (lyricsData?.description?.text) {
      return lyricsData.description.text;
    }
  } catch {
    // No native lyrics on YTM
  }
  return null;
}

/**
 * Fetches playlist details and tracks
 */
export async function getYtPlaylist(playlistId: string): Promise<YtPlaylist> {
  const yt = await getYtMusicClient();
  const cleanId = extractPlaylistId(playlistId);

  try {
    const pl = await yt.music.getPlaylist(cleanId);
    const title = (pl as any).header?.title?.text || (pl as any).title || 'Playlist';
    const description = (pl as any).header?.description?.text;
    const author = (pl as any).header?.author?.name;
    const thumbnailUrl = extractThumbnailUrl((pl as any).header) || extractThumbnailUrl(pl);

    const tracks: YtTrack[] = [];
    const contents = (pl as any).items || (pl as any).contents || [];

    for (const item of contents) {
      if (item.id || item.video_id) {
        const tTitle = item.title?.text || item.title || 'Unknown Track';
        const tArtist = item.artists?.map((a: any) => a.name || a.text).join(', ') || item.author?.name || 'Unknown Artist';
        const tDuration = item.duration?.seconds ? item.duration.seconds * 1000 : 180000;
        const tThumb = extractThumbnailUrl(item);
        tracks.push({
          id: item.id || item.video_id,
          title: tTitle,
          artist: tArtist,
          durationMs: tDuration,
          thumbnailUrl: tThumb,
        });
      }
    }

    return {
      id: cleanId,
      title,
      description,
      author,
      thumbnailUrl,
      itemCount: tracks.length,
      tracks,
    };
  } catch (err: any) {
    throw new Error(`Failed to load playlist ${cleanId}: ${err.message}`);
  }
}

/**
 * Fetches user's library playlists
 */
export async function getUserPlaylists(): Promise<YtPlaylist[]> {
  const yt = await getYtMusicClient();
  const playlists: YtPlaylist[] = [];

  try {
    const library = await yt.music.getLibrary();
    const contents = (library as any).playlists?.contents || (library as any).contents || [];

    for (const item of contents) {
      const id = item.id || item.playlist_id || item.endpoint?.payload?.playlistId;
      if (id) {
        playlists.push({
          id,
          title: item.title?.text || item.title || 'Playlist',
          author: item.author?.name || 'You',
          itemCount: item.item_count ? parseInt(item.item_count, 10) : undefined,
          thumbnailUrl: extractThumbnailUrl(item),
        });
      }
    }
  } catch {
    // Return whatever collected or empty if not logged in
  }

  return playlists;
}

/**
 * Fetches user's Liked Songs playlist
 */
export async function getLikedSongs(): Promise<YtPlaylist> {
  return getYtPlaylist('LM');
}

/**
 * Fetches Up Next / Radio tracks for a song
 */
export async function getYtUpNext(videoId: string): Promise<YtTrack[]> {
  const yt = await getYtMusicClient();
  const tracks: YtTrack[] = [];

  try {
    const upNext = await yt.music.getUpNext(videoId);
    const contents = upNext.contents || [];

    for (const item of contents) {
      const rawItem = item as any;
      const id = rawItem.id || rawItem.video_id || rawItem.endpoint?.payload?.videoId;
      if (id && id !== videoId) {
        const title = rawItem.title?.text || rawItem.title || 'Unknown Track';
        const artist = rawItem.artists?.map((a: any) => a.name || a.text).join(', ') || 'Unknown Artist';
        const duration = rawItem.duration?.seconds ? rawItem.duration.seconds * 1000 : 180000;
        const thumb = extractThumbnailUrl(rawItem);
        tracks.push({
          id,
          title,
          artist,
          durationMs: duration,
          thumbnailUrl: thumb,
        });
      }
    }
  } catch {
    // Fallback search related
  }

  return tracks;
}

/**
 * Fetches Explore / Trending music categories
 */
export async function getExploreFeed(): Promise<YtExploreCategory[]> {
  const yt = await getYtMusicClient();
  const categories: YtExploreCategory[] = [];

  try {
    const home = await yt.music.getHomeFeed();
    const sections = (home as any).sections || [];

    for (const sec of sections) {
      const title = sec.title?.text || sec.title || 'Featured';
      const items: YtExploreCategory['items'] = [];
      const contents = sec.contents || [];

      for (const item of contents) {
        const id = item.id || item.video_id || item.playlist_id || item.endpoint?.payload?.videoId || item.endpoint?.payload?.playlistId;
        if (id) {
          items.push({
            id,
            title: item.title?.text || item.title || 'Untitled',
            subtitle: item.subtitle?.text || item.artists?.[0]?.name || item.author?.name,
            thumbnailUrl: extractThumbnailUrl(item),
            type: item.playlist_id ? 'playlist' : item.album_id ? 'album' : 'song',
          });
        }
      }

      if (items.length > 0) {
        categories.push({ title, items });
      }
    }
  } catch {
    // Return empty on error
  }

  return categories;
}

let cachedTrendingSuggestions: SearchResult[] = [];

/**
 * Fetches trending/suggested tracks for instant search modal suggestions
 */
export async function getTrendingSuggestions(): Promise<SearchResult[]> {
  if (cachedTrendingSuggestions.length > 0) {
    return cachedTrendingSuggestions;
  }

  try {
    const feed = await getExploreFeed();
    const suggestions: SearchResult[] = [];

    for (const cat of feed) {
      for (const item of cat.items) {
        if (item.id && !suggestions.some((s) => s.id === item.id)) {
          suggestions.push({
            id: item.id,
            title: item.title,
            artist: item.subtitle || 'YouTube Music',
            duration: 180,
            hasSynced: false,
            source: 'youtube',
            type: item.type as any,
            thumbnailUrl: item.thumbnailUrl,
          });
        }
      }
    }

    if (suggestions.length === 0) {
      const fallback = await searchYtMusic('Trending', 'song');
      suggestions.push(...fallback);
    }

    cachedTrendingSuggestions = suggestions;
    return suggestions;
  } catch {
    return [];
  }
}

/**
 * Fetches typeahead search suggestions for the TUI search dropdown
 */
export async function getSearchAutocomplete(query: string): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    const yt = await getYtMusicClient();
    const sections = await yt.music.getSearchSuggestions(trimmed);
    const out: string[] = [];

    for (const section of sections || []) {
      if (!section || typeof section !== 'object' || !('contents' in section)) continue;
      const contents = section.contents;
      if (!Array.isArray(contents)) continue;

      for (const item of contents) {
        if (!item || typeof item !== 'object') continue;
        let text = '';
        if ('suggestion' in item && item.suggestion != null) {
          text = String(item.suggestion);
        } else if ('query' in item && typeof item.query === 'string') {
          text = item.query;
        }
        const cleaned = text.trim();
        if (cleaned && !out.includes(cleaned)) {
          out.push(cleaned);
        }
      }
    }

    return out.slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Like / unlike a song
 */
export async function rateSong(videoId: string, status: 'LIKE' | 'DISLIKE' | 'INDIFFERENT'): Promise<boolean> {
  const yt = await getYtMusicClient();
  try {
    const endpoint = status === 'LIKE' ? '/like/like' : status === 'DISLIKE' ? '/like/dislike' : '/like/removelike';
    await yt.actions.execute(endpoint, { target: { videoId } });
    return true;
  } catch {
    return false;
  }
}

export function extractThumbnailUrl(item: unknown): string | undefined {
  if (!item) return undefined;
  if (typeof item === 'string') return item;
  if (typeof item !== 'object') return undefined;

  const obj = item as Record<string, unknown>;
  if (typeof obj.thumbnailUrl === 'string' && obj.thumbnailUrl) return obj.thumbnailUrl;

  if (Array.isArray(obj.thumbnails) && obj.thumbnails.length > 0) {
    const last = obj.thumbnails[obj.thumbnails.length - 1];
    if (typeof last === 'string') return last;
    if (last && typeof last === 'object' && typeof (last as Record<string, unknown>).url === 'string') {
      return (last as Record<string, unknown>).url as string;
    }
  }

  if (Array.isArray(obj.thumbnail) && obj.thumbnail.length > 0) {
    const last = obj.thumbnail[obj.thumbnail.length - 1];
    if (typeof last === 'string') return last;
    if (last && typeof last === 'object' && typeof (last as Record<string, unknown>).url === 'string') {
      return (last as Record<string, unknown>).url as string;
    }
  }

  if (obj.thumbnail && typeof obj.thumbnail === 'object') {
    const thumbObj = obj.thumbnail as Record<string, unknown>;
    if (Array.isArray(thumbObj.contents) && thumbObj.contents.length > 0) {
      const last = thumbObj.contents[thumbObj.contents.length - 1];
      if (typeof last === 'string') return last;
      if (last && typeof last === 'object' && typeof (last as Record<string, unknown>).url === 'string') {
        return (last as Record<string, unknown>).url as string;
      }
    }
    if (typeof thumbObj.url === 'string') {
      return thumbObj.url;
    }
  }

  if (obj.header && typeof obj.header === 'object') {
    const headerObj = obj.header as Record<string, unknown>;
    if (Array.isArray(headerObj.thumbnails) && headerObj.thumbnails.length > 0) {
      const last = headerObj.thumbnails[headerObj.thumbnails.length - 1];
      if (typeof last === 'string') return last;
      if (last && typeof last === 'object' && typeof (last as Record<string, unknown>).url === 'string') {
        return (last as Record<string, unknown>).url as string;
      }
    }
  }

  return undefined;
}
