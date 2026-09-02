import * as fs from 'fs';
import * as path from 'path';

import { execFile } from 'child_process';
import { promisify } from 'util';
import { DownloadedSong, LyricLine, Song } from '../types.js';
import { findExecutable } from './auth.js';
import { getConfig, getConfigDir } from './config.js';
import { parseLrc } from '../parser/lrc.js';

const execFileAsync = promisify(execFile);

let index: Record<string, DownloadedSong> = {};
let loaded = false;
const activeDownloads: Record<string, Promise<DownloadedSong | null>> = {};

function getDownloadsDir(): string {
  return path.join(getConfigDir(), 'downloads');
}

function getIndexFile(): string {
  return path.join(getDownloadsDir(), 'index.json');
}

export function resetDownloadsState(): void {
  index = {};
  loaded = false;
}

export function ensureDownloadsDir(): void {
  const dir = getDownloadsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadDownloadsIndex(): void {
  if (loaded) return;
  loaded = true;
  try {
    const indexFile = getIndexFile();
    if (!fs.existsSync(indexFile)) return;
    const raw: unknown = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    const next: Record<string, DownloadedSong> = {};
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Partial<DownloadedSong>;
      if (!v.filePath || !fs.existsSync(v.filePath)) continue;
      let size = v.fileSizeBytes || 0;
      try {
        if (!size) size = fs.statSync(v.filePath).size;
      } catch {
        // ignore
      }
      next[id] = {
        id: v.id || id,
        title: v.title || 'Unknown Title',
        artist: v.artist || 'Unknown Artist',
        album: v.album,
        durationMs: v.durationMs || 0,
        filePath: v.filePath,
        fileSizeBytes: size,
        downloadedAt: v.downloadedAt || Date.now(),
        lastUsed: v.lastUsed || Date.now(),
        thumbnailUrl: v.thumbnailUrl,
        rawLrc: v.rawLrc,
        plainLyrics: v.plainLyrics,
        source: 'local',
      };
    }
    index = next;
  } catch {
    index = {};
  }
}

export function saveDownloadsIndex(): void {
  ensureDownloadsDir();
  try {
    fs.writeFileSync(getIndexFile(), JSON.stringify(index, null, 2), { mode: 0o600 });
  } catch {
    // ignore
  }
}

export function getDownloadedSongs(): DownloadedSong[] {
  loadDownloadsIndex();
  return Object.values(index).sort((a, b) => b.lastUsed - a.lastUsed);
}

export function getDownloadedSong(id: string): DownloadedSong | undefined {
  loadDownloadsIndex();
  return index[id];
}

export function getDownloadedCount(): number {
  loadDownloadsIndex();
  return Object.keys(index).length;
}

export function getTotalDownloadedBytes(): number {
  loadDownloadsIndex();
  let total = 0;
  for (const item of Object.values(index)) {
    total += item.fileSizeBytes || 0;
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

export function isSongDownloaded(id: string): boolean {
  loadDownloadsIndex();
  const entry = index[id];
  return Boolean(entry && fs.existsSync(entry.filePath));
}

function normalizeSearchText(str: string): string {
  return (str || '')
    .toLowerCase()
    .replace(/['’".,/#!$%^&*;:{}=\-_`~()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findDownloadedMatch(query: string): DownloadedSong | undefined {
  loadDownloadsIndex();
  const qNorm = normalizeSearchText(query);
  if (!qNorm) return undefined;

  const songs = Object.values(index);
  if (songs.length === 0) return undefined;

  if (index[query] && fs.existsSync(index[query].filePath)) {
    touchDownloadedSong(query);
    return index[query];
  }

  for (const s of songs) {
    const titleNorm = normalizeSearchText(s.title);
    const artistNorm = normalizeSearchText(s.artist);
    const fullNorm = `${titleNorm} ${artistNorm}`.trim();
    if (titleNorm === qNorm || fullNorm === qNorm) {
      touchDownloadedSong(s.id);
      return s;
    }
  }

  let best: DownloadedSong | undefined;
  for (const s of songs) {
    const titleNorm = normalizeSearchText(s.title);
    const artistNorm = normalizeSearchText(s.artist);
    const fullNorm = `${titleNorm} ${artistNorm}`.trim();
    if (titleNorm.includes(qNorm) || fullNorm.includes(qNorm) || (titleNorm.length >= 4 && qNorm.includes(titleNorm))) {
      best = s;
      break;
    }
  }
  if (best) touchDownloadedSong(best.id);
  return best;
}

export function searchDownloadedSongs(query: string): DownloadedSong[] {
  loadDownloadsIndex();
  const qNorm = normalizeSearchText(query);
  if (!qNorm) return getDownloadedSongs();

  return Object.values(index).filter((s) => {
    const titleNorm = normalizeSearchText(s.title);
    const artistNorm = normalizeSearchText(s.artist);
    const fullNorm = `${titleNorm} ${artistNorm}`.trim();
    return titleNorm.includes(qNorm) || artistNorm.includes(qNorm) || fullNorm.includes(qNorm);
  });
}

export function touchDownloadedSong(id: string): void {
  loadDownloadsIndex();
  if (index[id]) {
    index[id].lastUsed = Date.now();
    saveDownloadsIndex();
  }
}

export function upsertDownloadedSong(entry: DownloadedSong): DownloadedSong {
  loadDownloadsIndex();
  index[entry.id] = entry;
  evictToStorageLimit(entry.id);
  saveDownloadsIndex();
  return index[entry.id] || entry;
}

export function deleteDownloadedSong(id: string): boolean {
  loadDownloadsIndex();
  const entry = index[id];
  if (!entry) return false;

  try {
    if (entry.filePath && fs.existsSync(entry.filePath)) {
      fs.unlinkSync(entry.filePath);
    }
  } catch {
    // ignore
  }

  delete index[id];
  saveDownloadsIndex();
  return true;
}

export function deleteAllDownloadedSongs(): number {
  loadDownloadsIndex();
  const count = Object.keys(index).length;
  for (const entry of Object.values(index)) {
    try {
      if (entry.filePath && fs.existsSync(entry.filePath)) {
        fs.unlinkSync(entry.filePath);
      }
    } catch {
      // ignore
    }
  }
  index = {};
  saveDownloadsIndex();
  return count;
}

function evictToStorageLimit(keepId?: string): void {
  const cfg = getConfig();
  const limit = cfg.maxStorageBytes || 2 * 1024 * 1024 * 1024;
  let totalBytes = getTotalDownloadedBytes();
  while (totalBytes > limit) {
    const oldest = Object.values(index)
      .filter((s) => s.id !== keepId)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!oldest) break;
    deleteDownloadedSong(oldest.id);
    totalBytes = getTotalDownloadedBytes();
  }
}

export async function downloadSong(song: Song): Promise<DownloadedSong | null> {
  if (!song || !song.id) return null;
  const id = song.id;

  if (isSongDownloaded(id)) {
    touchDownloadedSong(id);
    return index[id];
  }

  const existingPath = song.audioUrl && !song.audioUrl.includes('://') && fs.existsSync(song.audioUrl)
    ? song.audioUrl
    : null;
  if (existingPath) {
    let size = 0;
    try {
      size = fs.statSync(existingPath).size;
    } catch {
      size = 0;
    }
    return upsertDownloadedSong({
      id,
      title: song.title || 'Unknown Title',
      artist: song.artist || 'Unknown Artist',
      album: song.album,
      durationMs: song.durationMs || 0,
      filePath: existingPath,
      fileSizeBytes: size,
      downloadedAt: Date.now(),
      lastUsed: Date.now(),
      thumbnailUrl: song.thumbnailUrl,
      rawLrc: serializeLyricsToLrc(song.lyrics, song.title, song.artist),
      plainLyrics: song.plainLyrics,
      source: 'local',
    });
  }

  if (id in activeDownloads) {
    return activeDownloads[id];
  }

  const ytDlp = findExecutable('yt-dlp');
  if (!ytDlp) return null;

  ensureDownloadsDir();
  const downloadsDir = getDownloadsDir();

  const promise = (async (): Promise<DownloadedSong | null> => {
    const outTemplate = path.join(downloadsDir, `${id}.%(ext)s`);
    const targetUrl = /^[a-zA-Z0-9_-]{11}$/.test(id)
      ? `https://music.youtube.com/watch?v=${id}`
      : song.audioUrl && /^[a-zA-Z0-9_-]{11}$/.test(song.audioUrl)
        ? `https://music.youtube.com/watch?v=${song.audioUrl}`
        : song.audioUrl || `https://music.youtube.com/watch?v=${id}`;

    try {
      await execFileAsync(
        ytDlp,
        [
          '-f', 'bestaudio/best',
          '--no-playlist',
          '--no-warnings',
          '--no-progress',
          '-o', outTemplate,
          targetUrl,
        ],
        { timeout: 180000 }
      );

      const matches = fs.readdirSync(downloadsDir).filter((f) => f === id || f.startsWith(`${id}.`));
      if (matches.length === 0) return null;
      const targetFile = path.join(downloadsDir, matches[0]);
      const stat = fs.statSync(targetFile);

      loadDownloadsIndex();
      const downloaded: DownloadedSong = {
        id,
        title: song.title || 'Unknown Title',
        artist: song.artist || 'Unknown Artist',
        album: song.album,
        durationMs: song.durationMs || 0,
        filePath: targetFile,
        fileSizeBytes: stat.size,
        downloadedAt: Date.now(),
        lastUsed: Date.now(),
        thumbnailUrl: song.thumbnailUrl,
        rawLrc: serializeLyricsToLrc(song.lyrics, song.title, song.artist),
        plainLyrics: song.plainLyrics,
        source: 'local',
      };

      return upsertDownloadedSong(downloaded);
    } catch {
      return null;
    }
  })();

  activeDownloads[id] = promise;
  void promise.finally(() => {
    delete activeDownloads[id];
  });

  return promise;
}


export function serializeLyricsToLrc(lyrics: LyricLine[] | undefined, title?: string, artist?: string): string {
  if (!lyrics || lyrics.length === 0) return '';
  const lines: string[] = [];
  if (title) lines.push(`[ti:${title}]`);
  if (artist) lines.push(`[ar:${artist}]`);
  for (const l of lyrics) {
    const m = Math.floor(l.startMs / 60000);
    const s = ((l.startMs % 60000) / 1000).toFixed(2);
    const padM = m < 10 ? `0${m}` : `${m}`;
    const padS = Number(s) < 10 ? `0${s}` : `${s}`;
    lines.push(`[${padM}:${padS}]${l.text || ''}`);
  }
  return lines.join('\n');
}

export function toPlayableSong(d: DownloadedSong): Song {
  let lyrics: LyricLine[] = [];
  if (d.rawLrc) {
    const parsed = parseLrc(d.rawLrc);
    lyrics = parsed.lines;

  }
  return {
    id: d.id,
    title: d.title,
    artist: d.artist,
    album: d.album,
    durationMs: d.durationMs,
    lyrics,
    plainLyrics: d.plainLyrics,
    thumbnailUrl: d.thumbnailUrl,
    audioUrl: d.filePath,
    source: 'local',
  };
}


