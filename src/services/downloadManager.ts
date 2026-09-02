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
let upgradeInFlight: Promise<number> | null = null;

const IMAGE_EXTS: Record<string, true> = {
  '.jpg': true,
  '.jpeg': true,
  '.png': true,
  '.webp': true,
  '.image': true,
};

function getDownloadsDir(): string {
  return path.join(getConfigDir(), 'downloads');
}

function getIndexFile(): string {
  return path.join(getDownloadsDir(), 'index.json');
}

export function resetDownloadsState(): void {
  index = {};
  loaded = false;
  upgradeInFlight = null;
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

export function sanitizeFilename(name: string): string {
  const cleaned = (name || '')
    .replace(/[/\\]/g, ' ')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/[\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  const sliced = cleaned.slice(0, 180);
  if (!sliced || sliced === '.' || sliced === '..') return 'Unknown';
  return sliced;
}

export function downloadBasename(artist: string, title: string): string {
  const a = sanitizeFilename(artist);
  const t = sanitizeFilename(title);
  const artistOk = a && a !== 'Unknown';
  const titleOk = t && t !== 'Unknown';
  if (artistOk && titleOk) return `${a} - ${t}`;
  if (titleOk) return t;
  if (artistOk) return a;
  return 'Unknown Track';
}

export function uniqueDownloadPath(dir: string, basename: string, ext: string, id?: string): string {
  const e = ext.replace(/^\./, '');
  const primary = path.join(dir, `${basename}.${e}`);
  if (!fs.existsSync(primary)) return primary;
  if (id) return path.join(dir, `${basename} [${sanitizeFilename(id)}].${e}`);
  let n = 2;
  while (fs.existsSync(path.join(dir, `${basename} (${n}).${e}`))) n += 1;
  return path.join(dir, `${basename} (${n}).${e}`);
}

export function upgradeThumbnailUrl(url: string): string {
  if (!url) return url;
  return url
    .replace(/\/vi\/([^/]+)\/(default|mqdefault|hqdefault|sddefault)\./, '/vi/$1/maxresdefault.')
    .replace(/=w\d+-h\d+/gi, '=w600-h600')
    .replace(/=s\d+/gi, '=s600');
}

export function cleanVideoTitle(title: string): string {
  return (title || '')
    .replace(/\s*[([【]\s*(official\s*)?(music\s*)?(hd\s*)?(lyric\s*)?(video|audio|visualizer|mv)(\s*\d+)?\s*[)\]】]/gi, '')
    .replace(/\s*[([【]\s*(lyrics|audio|visualizer|official)\s*[)\]】]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function asMetaString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(asMetaString).filter(Boolean).join(', ');
  return '';
}

export function resolveDownloadMetadata(
  song: Pick<Song, 'title' | 'artist' | 'album' | 'year' | 'id'>,
  info?: Record<string, unknown> | null
): { title: string; artist: string; album?: string; year?: string } {
  const infoTitle = cleanVideoTitle(asMetaString(info?.track) || asMetaString(info?.title));
  const infoArtist =
    asMetaString(info?.artist) ||
    asMetaString(info?.album_artist) ||
    asMetaString(info?.uploader) ||
    asMetaString(info?.channel);
  const infoAlbum = asMetaString(info?.album);
  let infoYear: string | undefined;
  if (info) {
    const y = info.release_year;
    if (typeof y === 'number' && y > 1900) infoYear = String(y);
    else {
      for (const key of ['release_date', 'upload_date']) {
        const v = info[key];
        if (typeof v === 'string' && /^\d{4}/.test(v)) {
          infoYear = v.slice(0, 4);
          break;
        }
      }
    }
  }

  const rawTitle = (song.title || '').trim();
  const genericTitle =
    !rawTitle ||
    /^unknown(\s+title)?$/i.test(rawTitle) ||
    rawTitle === song.id ||
    /^[a-zA-Z0-9_-]{11}$/.test(rawTitle);
  const rawArtist = (song.artist || '').trim();
  const genericArtist = !rawArtist || /^unknown(\s+artist)?$/i.test(rawArtist);

  const title = genericTitle ? infoTitle || song.title || 'Unknown Title' : song.title;
  const artist = genericArtist ? infoArtist || song.artist || 'Unknown Artist' : song.artist;
  const album = (song.album && song.album.trim()) || infoAlbum || undefined;
  const year = song.year != null && String(song.year).trim() ? String(song.year) : infoYear;
  return { title, artist, album, year };
}

function unlinkQuiet(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function cleanupStaging(dir: string, id: string): void {
  const prefix = `_tmp_${id}`;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === prefix || name.startsWith(`${prefix}.`)) {
        unlinkQuiet(path.join(dir, name));
      }
    }
  } catch {
    // ignore
  }
}

function imageExtension(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function readInfoJson(filePath: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

function metaArg(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').trim();
}

function metadataArgs(meta: { title: string; artist: string; album?: string; year?: string }): string[] {
  const args = ['-map_metadata', '-1', '-id3v2_version', '3', '-write_id3v1', '1'];
  if (meta.title) args.push('-metadata', `title=${metaArg(meta.title)}`);
  if (meta.artist) {
    args.push('-metadata', `artist=${metaArg(meta.artist)}`);
    args.push('-metadata', `album_artist=${metaArg(meta.artist)}`);
  }
  if (meta.album) args.push('-metadata', `album=${metaArg(meta.album)}`);
  if (meta.year) args.push('-metadata', `date=${metaArg(meta.year)}`);
  return args;
}

export async function convertToTaggedMp3(opts: {
  srcFile: string;
  destFile: string;
  title: string;
  artist: string;
  album?: string;
  year?: string;
  coverFile?: string;
}): Promise<boolean> {
  const ffmpeg = findExecutable('ffmpeg');
  if (!ffmpeg) return false;

  const tags = metadataArgs(opts);
  const attempts: string[][] = [];
  if (opts.coverFile) {
    attempts.push([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      opts.srcFile,
      '-i',
      opts.coverFile,
      '-map',
      '0:a:0',
      '-map',
      '1:0',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '2',
      '-c:v',
      'mjpeg',
      '-disposition:v',
      'attached_pic',
      ...tags,
      opts.destFile,
    ]);
  }
  attempts.push([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-vn',
    '-i',
    opts.srcFile,
    '-map',
    '0:a:0',
    '-c:a',
    'libmp3lame',
    '-q:a',
    '2',
    ...tags,
    opts.destFile,
  ]);

  for (const args of attempts) {
    try {
      await execFileAsync(ffmpeg, args, { timeout: 300000 });
      if (fs.existsSync(opts.destFile) && fs.statSync(opts.destFile).size > 0) return true;
    } catch {
      unlinkQuiet(opts.destFile);
    }
  }
  return false;
}

async function fetchCoverFile(url: string | undefined, destBase: string): Promise<string | undefined> {
  if (!url) return undefined;
  const candidates = [upgradeThumbnailUrl(url)];
  if (candidates[0] !== url) candidates.push(url);

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = imageExtension(buf);
      if (!ext) continue;
      const dest = `${destBase}${ext}`;
      fs.writeFileSync(dest, buf);
      return dest;
    } catch {
      // try next
    }
  }
  return undefined;
}

function moveOrCopy(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    unlinkQuiet(src);
  }
}

function buildDownloadedEntry(
  song: Song,
  meta: { title: string; artist: string; album?: string },
  filePath: string
): DownloadedSong {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = 0;
  }
  return {
    id: song.id,
    title: meta.title,
    artist: meta.artist,
    album: meta.album || song.album,
    durationMs: song.durationMs || 0,
    filePath,
    fileSizeBytes: size,
    downloadedAt: Date.now(),
    lastUsed: Date.now(),
    thumbnailUrl: song.thumbnailUrl,
    rawLrc: serializeLyricsToLrc(song.lyrics, meta.title, meta.artist),
    plainLyrics: song.plainLyrics,
    source: 'local',
  };
}

export async function downloadSong(song: Song): Promise<DownloadedSong | null> {
  if (!song || !song.id) return null;
  const id = song.id;

  if (isSongDownloaded(id)) {
    touchDownloadedSong(id);
    return index[id];
  }

  const existingPath =
    song.audioUrl && !song.audioUrl.includes('://') && fs.existsSync(song.audioUrl) ? song.audioUrl : null;
  if (existingPath) {
    const meta = resolveDownloadMetadata(song);
    return upsertDownloadedSong(buildDownloadedEntry(song, meta, existingPath));
  }

  if (id in activeDownloads) {
    return activeDownloads[id];
  }

  const ytDlp = findExecutable('yt-dlp');
  if (!ytDlp) return null;

  ensureDownloadsDir();
  const downloadsDir = getDownloadsDir();

  const promise = (async (): Promise<DownloadedSong | null> => {
    const prefix = `_tmp_${id}`;
    try {
      const outTemplate = path.join(downloadsDir, `${prefix}.%(ext)s`);
      const targetUrl = /^[a-zA-Z0-9_-]{11}$/.test(id)
        ? `https://music.youtube.com/watch?v=${id}`
        : song.audioUrl && /^[a-zA-Z0-9_-]{11}$/.test(song.audioUrl)
          ? `https://music.youtube.com/watch?v=${song.audioUrl}`
          : song.audioUrl || `https://music.youtube.com/watch?v=${id}`;

      await execFileAsync(
        ytDlp,
        [
          '-f',
          'bestaudio/best',
          '--no-playlist',
          '--no-warnings',
          '--no-progress',
          '--no-mtime',
          '--write-info-json',
          '-o',
          outTemplate,
          targetUrl,
        ],
        { timeout: 180000 }
      );

      const staged = fs.readdirSync(downloadsDir).filter((f) => f === prefix || f.startsWith(`${prefix}.`));
      const audioName = staged.find((f) => {
        const ext = path.extname(f).toLowerCase();
        if (!ext || ext === '.json' || ext === '.part' || ext === '.ytdl') return false;
        return !IMAGE_EXTS[ext];
      });
      if (!audioName) return null;
      const audioPath = path.join(downloadsDir, audioName);
      const infoName = staged.find((f) => f.endsWith('.info.json'));
      const info = infoName ? readInfoJson(path.join(downloadsDir, infoName)) : null;

      const meta = resolveDownloadMetadata(song, info);
      const basename = downloadBasename(meta.artist, meta.title);
      const mp3Path = uniqueDownloadPath(downloadsDir, basename, 'mp3', id);
      const coverFile = await fetchCoverFile(song.thumbnailUrl, path.join(downloadsDir, `${prefix}.cover`));

      const converted = await convertToTaggedMp3({
        srcFile: audioPath,
        destFile: mp3Path,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        year: meta.year,
        coverFile,
      });

      if (converted) {
        unlinkQuiet(audioPath);
        return upsertDownloadedSong(buildDownloadedEntry(song, meta, mp3Path));
      }

      const fallbackExt = (path.extname(audioPath).replace(/^\./, '') || 'opus').toLowerCase();
      const fallbackPath = uniqueDownloadPath(downloadsDir, basename, fallbackExt, id);
      if (path.resolve(audioPath) !== path.resolve(fallbackPath)) {
        moveOrCopy(audioPath, fallbackPath);
      }
      return upsertDownloadedSong(buildDownloadedEntry(song, meta, fallbackPath));
    } catch {
      return null;
    } finally {
      cleanupStaging(downloadsDir, id);
    }
  })();

  activeDownloads[id] = promise;
  void promise.finally(() => {
    delete activeDownloads[id];
  });

  return promise;
}

export function needsDownloadUpgrade(entry: DownloadedSong): boolean {
  if (!entry.filePath || !fs.existsSync(entry.filePath)) return false;
  const parsed = path.parse(entry.filePath);
  const expected = downloadBasename(entry.artist || '', entry.title || '');
  const taggedName = `${expected} [${sanitizeFilename(entry.id)}]`;
  const nameOk = parsed.name === expected || parsed.name === taggedName;
  return parsed.ext.toLowerCase() !== '.mp3' || !nameOk;
}

export async function upgradeDownloadedSong(entry: DownloadedSong): Promise<DownloadedSong | null> {
  if (!needsDownloadUpgrade(entry)) return entry;
  if (!findExecutable('ffmpeg')) return null;

  ensureDownloadsDir();
  const dir = getDownloadsDir();
  const src = entry.filePath;
  const meta = resolveDownloadMetadata({
    id: entry.id,
    title: entry.title,
    artist: entry.artist,
    album: entry.album,
  });
  const basename = downloadBasename(meta.artist, meta.title);
  const wanted = path.join(dir, `${basename}.mp3`);
  const srcResolved = path.resolve(src);
  const finalPath =
    fs.existsSync(wanted) && path.resolve(wanted) !== srcResolved
      ? path.join(dir, `${basename} [${sanitizeFilename(entry.id)}].mp3`)
      : wanted;
  const stagingMp3 = path.join(dir, `_tmp_${entry.id}.mp3`);

  try {
    const coverFile = await fetchCoverFile(entry.thumbnailUrl, path.join(dir, `_tmp_${entry.id}.cover`));
    const converted = await convertToTaggedMp3({
      srcFile: src,
      destFile: stagingMp3,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      year: meta.year,
      coverFile,
    });
    if (!converted) return null;

    try {
      fs.renameSync(stagingMp3, finalPath);
    } catch {
      fs.copyFileSync(stagingMp3, finalPath);
      unlinkQuiet(stagingMp3);
    }
    if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size <= 0) return null;
    if (srcResolved !== path.resolve(finalPath)) {
      unlinkQuiet(src);
    }

    loadDownloadsIndex();
    if (!index[entry.id]) return null;
    let size = 0;
    try {
      size = fs.statSync(finalPath).size;
    } catch {
      size = 0;
    }
    const next: DownloadedSong = {
      ...index[entry.id],
      title: meta.title,
      artist: meta.artist,
      album: meta.album || index[entry.id].album,
      filePath: finalPath,
      fileSizeBytes: size,
    };
    index[entry.id] = next;
    saveDownloadsIndex();
    return next;
  } catch {
    return null;
  } finally {
    cleanupStaging(dir, entry.id);
  }
}

export function upgradeLegacyDownloads(playing?: { id?: string; audioUrl?: string } | null): Promise<number> {
  if (upgradeInFlight) return upgradeInFlight;
  const skipId = playing?.id;
  const skipFile =
    playing?.audioUrl && !playing.audioUrl.includes('://') ? path.resolve(playing.audioUrl) : '';
  const work = (async () => {
    let n = 0;
    for (const song of getDownloadedSongs()) {
      if (skipId && song.id === skipId) continue;
      if (skipFile && path.resolve(song.filePath) === skipFile) continue;
      if (!needsDownloadUpgrade(song)) continue;
      const next = await upgradeDownloadedSong(song);
      if (next && !needsDownloadUpgrade(next)) n += 1;
    }
    return n;
  })();
  upgradeInFlight = work.finally(() => {
    upgradeInFlight = null;
  });
  return work;
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
