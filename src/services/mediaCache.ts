import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { findExecutable } from './auth.js';

const execFileAsync = promisify(execFile);

const ROOT = path.join(os.homedir(), '.config', 'resonate');
const MEDIA_DIR = path.join(ROOT, 'media');
const INDEX_PATH = path.join(ROOT, 'cache', 'media.json');
const MAX_FILES = 8;

interface MediaEntry {
  url?: string;
  expiresAt?: number;
  file?: string;
  lastUsed: number;
}

let index: Record<string, MediaEntry> = {};
let loaded = false;
const downloads: Record<string, Promise<void>> = {};

function loadIndex(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!fs.existsSync(INDEX_PATH)) return;
    const raw: unknown = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    const next: Record<string, MediaEntry> = {};
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      const lastUsed = 'lastUsed' in value && typeof value.lastUsed === 'number' ? value.lastUsed : Date.now();
      const entry: MediaEntry = { lastUsed };
      if ('url' in value && typeof value.url === 'string') entry.url = value.url;
      if ('expiresAt' in value && typeof value.expiresAt === 'number') entry.expiresAt = value.expiresAt;
      if ('file' in value && typeof value.file === 'string') entry.file = value.file;
      next[id] = entry;
    }
    index = next;
  } catch {
    index = {};
  }
}

function saveIndex(): void {
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index));
}

function touch(id: string): MediaEntry {
  loadIndex();
  const entry = index[id] || { lastUsed: Date.now() };
  entry.lastUsed = Date.now();
  index[id] = entry;
  return entry;
}

function mediaFileFor(id: string): string | undefined {
  if (!fs.existsSync(MEDIA_DIR)) return undefined;
  const names = fs.readdirSync(MEDIA_DIR).filter((name) => name === id || name.startsWith(`${id}.`));
  if (names.length === 0) return undefined;
  return path.join(MEDIA_DIR, names[0]);
}

function evict(): void {
  const files = Object.entries(index).filter(([, entry]) => entry.file);
  if (files.length <= MAX_FILES) return;
  files.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const extra = files.length - MAX_FILES;
  for (let i = 0; i < extra; i++) {
    const [id, entry] = files[i];
    if (entry.file) {
      try {
        fs.unlinkSync(entry.file);
      } catch {
        // ignore
      }
    }
    delete entry.file;
    if (!entry.url) delete index[id];
  }
}

export function getCachedMediaPath(id: string): string | undefined {
  loadIndex();
  const fromIndex = index[id]?.file;
  if (fromIndex && fs.existsSync(fromIndex)) {
    touch(id);
    saveIndex();
    return fromIndex;
  }
  const found = mediaFileFor(id);
  if (found) {
    const entry = touch(id);
    entry.file = found;
    saveIndex();
    return found;
  }
  return undefined;
}

export function getCachedStreamUrl(id: string): string | undefined {
  loadIndex();
  const entry = index[id];
  if (entry?.url && entry.expiresAt && entry.expiresAt > Date.now()) {
    touch(id);
    return entry.url;
  }
  return undefined;
}

export function rememberStreamUrl(id: string, url: string, expiresAt: number): void {
  const entry = touch(id);
  entry.url = url;
  entry.expiresAt = expiresAt;
  saveIndex();
}

export function prefetchMediaFile(id: string): void {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return;
  if (getCachedMediaPath(id)) return;
  if (id in downloads) return;

  const ytDlp = findExecutable('yt-dlp');
  if (!ytDlp) return;

  downloads[id] = (async () => {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const out = path.join(MEDIA_DIR, `${id}.%(ext)s`);
    try {
      await execFileAsync(
        ytDlp,
        [
          '-f', 'bestaudio/best',
          '--no-playlist',
          '--no-warnings',
          '--no-progress',
          '-o', out,
          `https://music.youtube.com/watch?v=${id}`,
        ],
        { timeout: 120000 }
      );
      const file = mediaFileFor(id);
      if (file) {
        const entry = touch(id);
        entry.file = file;
        evict();
        saveIndex();
      }
    } catch {
      // Stream URL playback still works
    }
  })();

  void downloads[id].finally(() => {
    delete downloads[id];
  });
}
