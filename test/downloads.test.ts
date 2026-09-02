import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSongFromText } from '../src/parser/lrc.js';
import { LyricalApp } from '../src/app.js';
import { renderHeader } from '../src/ui/components/Header.js';
import { renderDownloadsModal } from '../src/ui/components/Modals.js';
import { THEMES } from '../src/ui/themes.js';
import { LyricPlayer } from '../src/engine/player.js';
import { SimulatedAudioBackend } from '../src/engine/audioBackend.js';
import { stripAnsi } from '../src/ui/renderer.js';
import { formatStorageLimit, getConfig, parseStorageBytes, resetConfigCache, saveConfig } from '../src/services/config.js';
import {
  deleteAllDownloadedSongs,
  deleteDownloadedSong,
  findDownloadedMatch,
  formatBytes,
  getDownloadedCount,
  getDownloadedSongs,
  resetDownloadsState,
  toPlayableSong,
  upsertDownloadedSong,
} from '../src/services/downloadManager.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-dl-'));
process.env.RESONATE_CONFIG_DIR = tmp;
resetConfigCache();
resetDownloadsState();

function seedSong(id: string, title: string, artist: string, bytes = 128): string {
  const dir = path.join(tmp, 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.opus`);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
  upsertDownloadedSong({
    id,
    title,
    artist,
    durationMs: 180000,
    filePath,
    fileSizeBytes: bytes,
    downloadedAt: Date.now(),
    lastUsed: Date.now(),
    source: 'local',
  });
  return filePath;
}

describe('Config persistence', () => {
  before(() => {
    process.env.RESONATE_CONFIG_DIR = tmp;
    resetConfigCache();
  });

  it('defaults auto-download on and 2 GB limit', () => {
    const cfg = getConfig();
    assert.strictEqual(cfg.autoDownload, true);
    assert.strictEqual(cfg.maxStorageBytes, 2 * 1024 * 1024 * 1024);
  });

  it('parses storage limits', () => {
    assert.strictEqual(parseStorageBytes('2G'), 2 * 1024 ** 3);
    assert.strictEqual(parseStorageBytes('512MB'), 512 * 1024 ** 2);
    assert.strictEqual(parseStorageBytes('1.5gb'), Math.floor(1.5 * 1024 ** 3));
    assert.ok(formatStorageLimit(2 * 1024 ** 3).includes('GB'));
  });

  it('persists theme across app sessions', () => {
    saveConfig({ theme: 'nord' });
    resetConfigCache();
    const app = new LyricalApp({ initialSong: createSongFromText('A', 'B', '[00:00.00] hi', undefined, 10) });
    const seam = app as unknown as { themeManager: { getTheme: () => { id: string } }; handleKey: Function };
    assert.strictEqual(seam.themeManager.getTheme().id, 'nord');
    seam.handleKey({ name: 't' }, 't');
    resetConfigCache();
    assert.notStrictEqual(getConfig().theme, 'nord');
  });
});

describe('Offline downloads library', () => {
  before(() => {
    process.env.RESONATE_CONFIG_DIR = tmp;
    resetConfigCache();
    resetDownloadsState();
    deleteAllDownloadedSongs();
  });

  after(() => {
    resetDownloadsState();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('matches partial titles like CLI queries', () => {
    seedSong('vid11111111', "We Don't Talk Anymore", 'Charlie Puth', 256);
    const exact = findDownloadedMatch("We Don't Talk Anymore");
    assert.ok(exact);
    assert.strictEqual(exact?.artist, 'Charlie Puth');
    const partial = findDownloadedMatch("we don't talk");
    assert.ok(partial);
    assert.strictEqual(partial?.id, 'vid11111111');
    const playable = toPlayableSong(partial!);
    assert.strictEqual(playable.source, 'local');
    assert.ok(fs.existsSync(playable.audioUrl || ''));
  });

  it('deletes one song and all songs', () => {
    seedSong('aaaa1111111', 'Song One', 'Artist', 64);
    seedSong('bbbb2222222', 'Song Two', 'Artist', 64);
    assert.ok(getDownloadedCount() >= 2);
    assert.strictEqual(deleteDownloadedSong('aaaa1111111'), true);
    assert.strictEqual(getDownloadedSongs().some((s) => s.id === 'aaaa1111111'), false);
    const n = deleteAllDownloadedSongs();
    assert.ok(n >= 1);
    assert.strictEqual(getDownloadedCount(), 0);
  });

  it('formats byte sizes', () => {
    assert.strictEqual(formatBytes(0), '0 B');
    assert.ok(formatBytes(2048).includes('KB'));
  });

  it('shows download count in the header', () => {
    seedSong('cccc3333333', 'Header Track', 'Artist', 32);
    const player = new LyricPlayer(createSongFromText('T', 'A', '[00:00.00] x', undefined, 10), new SimulatedAudioBackend());
    const lines = renderHeader({
      width: 80,
      song: player.getCurrentSong(),
      state: player.getState(),
      theme: THEMES.ytmusic,
      viewMode: 'karaoke',
      downloadedCount: getDownloadedCount(),
    });
    const text = stripAnsi(lines.join('\n'));
    assert.ok(text.includes('⬇'));
    assert.ok(text.includes(String(getDownloadedCount())));
    player.destroy();
  });

  it('renders downloads modal and confirms bulk delete copy', () => {
    const songs = getDownloadedSongs();
    const modal = stripAnsi(
      renderDownloadsModal(songs, 0, THEMES.ytmusic, { width: 80, height: 24 }, {
        autoDownload: true,
        maxStorageBytes: 2 * 1024 ** 3,
        usedBytes: 1024,
        confirm: { mode: 'all' },
      }).join('\n')
    );
    assert.ok(/Delete ALL/i.test(modal));
    assert.ok(/y: confirm/i.test(modal));
  });

  it('requires confirmation before deleting from the downloads view', () => {
    resetDownloadsState();
    deleteAllDownloadedSongs();
    seedSong('dddd4444444', 'Confirm Me', 'Artist', 32);
    const song = createSongFromText('Confirm Me', 'Artist', '[00:00.00] x', undefined, 10);
    const app = new LyricalApp({ initialSong: song, initialTheme: 'ytmusic' });
    const seam = app as unknown as {
      viewMode: string;
      downloadsConfirm: { mode: string } | null;
      handleKey: (key: { name?: string }, str?: string) => void;
    };
    seam.handleKey({ name: 'd' }, 'd');
    assert.strictEqual(seam.viewMode, 'downloads');
    seam.handleKey({ name: 'd' }, 'd');
    assert.ok(seam.downloadsConfirm);
    assert.strictEqual(seam.downloadsConfirm?.mode, 'one');
    assert.strictEqual(getDownloadedCount(), 1);
    seam.handleKey({ name: 'n' }, 'n');
    assert.strictEqual(seam.downloadsConfirm, null);
    assert.strictEqual(getDownloadedCount(), 1);
    seam.handleKey({ name: 'd' }, 'd');
    seam.handleKey({ name: 'y' }, 'y');
    assert.strictEqual(getDownloadedCount(), 0);
  });
});
