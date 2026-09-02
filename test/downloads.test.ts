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
  cleanVideoTitle,
  convertToTaggedMp3,
  deleteAllDownloadedSongs,
  deleteDownloadedSong,
  downloadBasename,
  findDownloadedMatch,
  formatBytes,
  getDownloadedCount,
  getDownloadedSong,
  getDownloadedSongs,
  needsDownloadUpgrade,
  resetDownloadsState,
  resolveDownloadMetadata,
  sanitizeFilename,
  toPlayableSong,
  uniqueDownloadPath,
  upgradeLegacyDownloads,
  upgradeThumbnailUrl,
  upsertDownloadedSong,
} from '../src/services/downloadManager.js';
import { findExecutable } from '../src/services/auth.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

describe('Download filenames and metadata', () => {
  it('builds a readable Artist - Title filename', () => {
    assert.strictEqual(sanitizeFilename('Night/Changes: (Live)?'), 'Night Changes (Live)');
    assert.strictEqual(downloadBasename('One Direction', 'Night Changes'), 'One Direction - Night Changes');
    assert.strictEqual(downloadBasename('', 'Night Changes'), 'Night Changes');
    assert.strictEqual(cleanVideoTitle('Night Changes (Official Video)'), 'Night Changes');
  });

  it('avoids colliding filenames with a video id suffix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-name-'));
    fs.writeFileSync(path.join(dir, 'One Direction - Night Changes.mp3'), 'x');
    const next = uniqueDownloadPath(dir, 'One Direction - Night Changes', 'mp3', 'abcde123456');
    assert.strictEqual(path.basename(next), 'One Direction - Night Changes [abcde123456].mp3');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades tiny YouTube and Google thumbnail URLs', () => {
    assert.ok(upgradeThumbnailUrl('https://i.ytimg.com/vi/abcde123456/hqdefault.jpg').includes('maxresdefault'));
    assert.ok(upgradeThumbnailUrl('https://lh3.googleusercontent.com/x=w60-h60-p-l90-rj').includes('w600-h600'));
  });

  it('prefers YT Music title and fills gaps from yt-dlp info', () => {
    const tagged = resolveDownloadMetadata({
      id: 'abcde123456',
      title: 'Night Changes',
      artist: 'One Direction',
      album: 'Four',
      year: 2014,
    }, { title: 'Night Changes (Official Video)', artist: 'Other' });
    assert.strictEqual(tagged.title, 'Night Changes');
    assert.strictEqual(tagged.artist, 'One Direction');
    assert.strictEqual(tagged.album, 'Four');
    assert.strictEqual(tagged.year, '2014');

    const fromInfo = resolveDownloadMetadata({
      id: 'abcde123456',
      title: 'abcde123456',
      artist: 'Unknown Artist',
    }, {
      track: 'Steal My Girl',
      artist: 'One Direction',
      album: 'Four',
      upload_date: '20141008',
    });
    assert.strictEqual(fromInfo.title, 'Steal My Girl');
    assert.strictEqual(fromInfo.artist, 'One Direction');
    assert.strictEqual(fromInfo.album, 'Four');
    assert.strictEqual(fromInfo.year, '2014');
  });

  it('converts audio to a tagged MP3 with album art', async () => {
    const ffmpeg = findExecutable('ffmpeg');
    if (!ffmpeg) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-mp3-'));
    const wav = path.join(dir, 'src.wav');
    const cover = path.join(dir, 'cover.jpg');
    const dest = path.join(dir, 'One Direction - Night Changes.mp3');
    await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-y', wav], { timeout: 20000 });
    await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', '-y', cover], { timeout: 20000 });

    const ok = await convertToTaggedMp3({
      srcFile: wav,
      destFile: dest,
      title: 'Night Changes',
      artist: 'One Direction',
      album: 'Four',
      year: '2014',
      coverFile: cover,
    });
    assert.strictEqual(ok, true);
    const buf = fs.readFileSync(dest);
    assert.ok(buf.length > 100);
    assert.strictEqual(buf.subarray(0, 3).toString('ascii'), 'ID3');
    const compact = Buffer.from(buf.filter((b) => b !== 0)).toString('latin1');
    assert.ok(compact.includes('Night Changes'));
    assert.ok(compact.includes('One Direction'));
    assert.ok(compact.includes('Four'));
    assert.ok(compact.includes('APIC') || buf.includes(Buffer.from([0xff, 0xd8, 0xff])));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags id-named files and skips already tagged MP3s', () => {
    resetDownloadsState();
    deleteAllDownloadedSongs();
    const filePath = seedSong('vid99999999', 'Night Changes', 'One Direction');
    const legacy = getDownloadedSong('vid99999999');
    assert.ok(legacy);
    assert.strictEqual(needsDownloadUpgrade(legacy!), true);

    const mp3 = path.join(tmp, 'downloads', 'One Direction - Night Changes.mp3');
    fs.writeFileSync(mp3, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 1)]));
    upsertDownloadedSong({ ...legacy!, filePath: mp3, fileSizeBytes: 67 });
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
    assert.strictEqual(needsDownloadUpgrade(getDownloadedSong('vid99999999')!), false);
  });

  it('upgrades a legacy id-named file to a tagged MP3', async () => {
    const ffmpeg = findExecutable('ffmpeg');
    if (!ffmpeg) return;

    resetDownloadsState();
    deleteAllDownloadedSongs();
    const dir = path.join(tmp, 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'abcde123456.wav');
    await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-y', src], { timeout: 20000 });
    upsertDownloadedSong({
      id: 'abcde123456',
      title: 'Night Changes',
      artist: 'One Direction',
      album: 'Four',
      durationMs: 250,
      filePath: src,
      fileSizeBytes: fs.statSync(src).size,
      downloadedAt: Date.now(),
      lastUsed: Date.now(),
      source: 'local',
    });

    const n = await upgradeLegacyDownloads();
    assert.ok(n >= 1);
    const upgraded = getDownloadedSong('abcde123456');
    assert.ok(upgraded);
    assert.strictEqual(path.basename(upgraded!.filePath), 'One Direction - Night Changes.mp3');
    assert.strictEqual(fs.existsSync(src), false);
    assert.ok(fs.existsSync(upgraded!.filePath));
    const buf = fs.readFileSync(upgraded!.filePath);
    assert.strictEqual(buf.subarray(0, 3).toString('ascii'), 'ID3');
    const compact = Buffer.from(buf.filter((b) => b !== 0)).toString('latin1');
    assert.ok(compact.includes('Night Changes'));
    assert.ok(compact.includes('One Direction'));
    assert.strictEqual(needsDownloadUpgrade(upgraded!), false);
  });
});

