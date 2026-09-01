import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseLrc, parseTimestampToMs, formatMsToTime, createSongFromText } from '../src/parser/lrc.js';
import { LyricPlayer } from '../src/engine/player.js';
import { createAudioBackend, SimulatedAudioBackend, SystemAudioBackend } from '../src/engine/audioBackend.js';
import { AudioVisualizer } from '../src/engine/visualizer.js';
import { THEMES, ThemeManager } from '../src/ui/themes.js';
import { getVisualWidth, truncate, pad, gradientText, drawBox, stripAnsi, sliceVisualEnd } from '../src/ui/renderer.js';
import { renderHeader } from '../src/ui/components/Header.js';
import { formatMusicalNoteText, isMusicalNoteLine, renderLyricsViewport } from '../src/ui/components/LyricsViewport.js';
import { renderControlBar } from '../src/ui/components/ControlBar.js';
import { renderAlbumArt } from '../src/ui/components/AlbumArt.js';
import {
  renderAuthModal,
  renderExploreModal,
  renderHelpModal,
  renderPlaylistModal,
  renderQueueModal,
  renderReadingView,
  renderSearchModal,
} from '../src/ui/components/Modals.js';
import { LyricalApp } from '../src/app.js';
import { extractPlaylistId, extractThumbnailUrl, extractVideoId, isStreamRef } from '../src/services/ytmusic.js';
import { clearAuthCredentials, loadAuthCredentials, saveAuthCredentials } from '../src/services/auth.js';

const globalSong = createSongFromText(
  'Bohemian Rhapsody',
  'Queen',
  '[00:00.50] Is this the real life?\n[00:04.00] Is this just fantasy?\n[00:08.50] Caught in a landslide',
  'A Night at the Opera',
  355
);
describe('LRC Parser & Time Formatting', () => {
  it('should parse timestamp string to milliseconds accurately', () => {
    assert.strictEqual(parseTimestampToMs('00:00.50'), 500);
    assert.strictEqual(parseTimestampToMs('01:23.45'), 83450);
    assert.strictEqual(parseTimestampToMs('02:05'), 125000);
    assert.strictEqual(parseTimestampToMs('01:00:00'), 3600000);
  });

  it('should format milliseconds to readable time string', () => {
    assert.strictEqual(formatMsToTime(500), '00:00');
    assert.strictEqual(formatMsToTime(83450), '01:23');
    assert.strictEqual(formatMsToTime(83450, true), '01:23.45');
  });

  it('should parse metadata and synced lines from LRC text', () => {
    const lrc = `
[ti:Test Track]
[ar:Test Artist]
[al:Test Album]
[length:02:00]
[00:05.00]First line
[00:10.00]Second line
[00:20.00]Third line
    `;
    const parsed = parseLrc(lrc);
    assert.strictEqual(parsed.title, 'Test Track');
    assert.strictEqual(parsed.artist, 'Test Artist');
    assert.strictEqual(parsed.lines.length, 3);
    assert.strictEqual(parsed.lines[0].text, 'First line');
    assert.strictEqual(parsed.lines[0].startMs, 5000);
    assert.strictEqual(parsed.lines[1].text, 'Second line');
    assert.strictEqual(parsed.lines[1].startMs, 10000);
  });

  it('should create Song from plain text fallback', () => {
    const plain = 'Line 1\nLine 2\nLine 3';
    const song = createSongFromText('Song', 'Artist', plain);
    assert.strictEqual(song.lyrics.length, 3);
    assert.strictEqual(song.lyrics[0].text, 'Line 1');
  });
});

describe('Lyric Player Engine', () => {
  const testSong = createSongFromText(
    'Test Song',
    'Test Artist',
    '[00:00.50] First line of test\n[00:10.00] Second line chorus\n[00:20.00] Third line outro',
    'Test Album',
    60
  );

  it('should load song and calculate active line on seek', () => {
    const player = new LyricPlayer(testSong);

    assert.strictEqual(player.getCurrentSong()?.title, 'Test Song');
    assert.strictEqual(player.getState().status, 'stopped');

    // Seek to 1 second (First line starts at 00:00.50)
    player.seek(1000);
    const state1 = player.getState();
    assert.strictEqual(state1.activeLineIndex, 0);
    assert.ok(state1.lineProgressRatio > 0);

    // Seek to chorus (00:12.00)
    player.seek(12000);
    const state2 = player.getState();
    assert.strictEqual(state2.activeLineIndex, 1);
    const activeLine = testSong.lyrics[state2.activeLineIndex];
    assert.ok(activeLine.text.includes('chorus'));

    player.destroy();
  });

  it('should handle speed and offset adjustments', () => {
    const player = new LyricPlayer(testSong);

    player.setSpeed(1.5);
    assert.strictEqual(player.getState().speed, 1.5);

    player.adjustOffset(200);
    assert.strictEqual(player.getState().offsetMs, 200);

    player.resetOffset();
    assert.strictEqual(player.getState().offsetMs, 0);

    player.toggleLoop();
    assert.strictEqual(player.getState().loop, true);

    player.destroy();
  });
});

describe('Audio Visualizer', () => {
  it('should render all visualizer modes without error', () => {
    const viz = new AudioVisualizer('bars');
    const theme = THEMES.cyberpunk;

    const modes = ['bars', 'wave', 'flame', 'particles', 'matrix', 'pulse', 'vinyl'] as const;
    for (const mode of modes) {
      viz.setType(mode);
      const lines = viz.render({
        width: 30,
        height: 6,
        timeMs: 15000,
        isPlaying: true,
        theme,
        bpm: 120,
      });

      assert.strictEqual(lines.length, 6);
      assert.ok(lines[0].length > 0);
    }
  });
});

describe('Theme Manager & ANSI Renderer', () => {
  it('should switch themes and cycle correctly', () => {
    const tm = new ThemeManager('cyberpunk');
    assert.strictEqual(tm.getTheme().id, 'cyberpunk');

    const next = tm.nextTheme();
    assert.strictEqual(next.id, 'tokyonight');

    const prev = tm.prevTheme();
    assert.strictEqual(prev.id, 'cyberpunk');
  });

  it('should calculate visual width and strip ANSI', () => {
    const styled = gradientText('Nickelback', [[0, 240, 255], [255, 0, 127]]);
    assert.strictEqual(stripAnsi(styled), 'Nickelback');
    assert.strictEqual(getVisualWidth(styled), 10);

    // Emoji and wide character width tests
    assert.strictEqual(getVisualWidth('⚡'), 1);
    assert.strictEqual(getVisualWidth('⏱'), 1);
    assert.strictEqual(getVisualWidth('🔁'), 2);
    assert.strictEqual(getVisualWidth('📊'), 2);
    assert.strictEqual(getVisualWidth('🕒'), 2);
    assert.strictEqual(getVisualWidth('🌸'), 2);
    assert.strictEqual(getVisualWidth('日本語'), 6);
  });

  it('should truncate and pad strings cleanly', () => {
    assert.strictEqual(truncate('Hello World!', 8), 'Hello W…');
    assert.strictEqual(pad('Hi', 6, 'center'), '  Hi  ');
    assert.strictEqual(getVisualWidth(pad('Test', 10, 'left')), 10);
  });

  it('should draw rounded boxes with titles and exact visual width', () => {
    const box = drawBox(['Line A', 'Line B', 'A'.repeat(18)], 20, [0, 240, 255], 'Test');
    assert.strictEqual(box.length, 5);
    assert.ok(stripAnsi(box[0]).includes('Test'));
    for (const row of box) {
      assert.strictEqual(getVisualWidth(row), 20);
    }
  });
});

describe('UI Components Rendering', () => {
  const song = createSongFromText(
    'Bohemian Rhapsody',
    'Queen',
    '[00:00.50] Is this the real life?\n[00:04.00] Is this just fantasy?\n[00:08.50] Caught in a landslide',
    'A Night at the Opera',
    355
  );
  const theme = THEMES.cyberpunk;
  const player = new LyricPlayer(song);
  player.seek(2000);
  const state = player.getState();

  it('should render Header component', () => {
    const lines = renderHeader({
      width: 80,
      song,
      state,
      theme,
      viewMode: 'karaoke',
    });
    assert.ok(lines.length >= 4);
    assert.ok(stripAnsi(lines.join('\n')).includes('Bohemian Rhapsody'));
  });

  it('should render LyricsViewport with karaoke active line highlight', () => {
    const lines = renderLyricsViewport({
      width: 60,
      height: 10,
      song,
      state,
      theme,
      showTimestamps: true,
    });
    assert.strictEqual(lines.length, 10);
    const combined = stripAnsi(lines.join('\n'));
    assert.ok(combined.includes('Is this the real life?'));
  });

  it('should render Indic and complex Unicode lyrics without splitting combining characters', () => {
    const indicSong = {
      id: 'indic-test',
      title: 'ना जा',
      artist: 'Pav Dharia',
      durationMs: 180000,
      lyrics: [
        { id: 1, text: 'ये ख़्दा रि याँ  तुझी  से जुड़ी  हैं मेरी', startMs: 1000, endMs: 5000 },
        { id: 2, text: 'ਨੱਚਦੀ ,  ਤੇ ਬੀ ਬਾ  ਨੱਚਦੀ', startMs: 5000, endMs: 9000 },
      ],
    };
    const indicPlayer = new LyricPlayer(indicSong);
    indicPlayer.seek(3000);

    for (let ratio = 0; ratio <= 1.0; ratio += 0.1) {
      const pState = { ...indicPlayer.getState(), lineProgressRatio: ratio };
      const lines = renderLyricsViewport({
        width: 60,
        height: 6,
        song: indicSong,
        state: pState,
        theme,
      });
      assert.strictEqual(lines.length, 6);
      for (const line of lines) {
        const w = getVisualWidth(line);
        assert.ok(w <= 58, `Line visual width ${w} must be <= 58`);
      }
    }
  });
  it('should render ControlBar component', () => {
    const lines = renderControlBar({
      width: 80,
      state,
      theme,
      visualizerType: 'bars',
      viewMode: 'karaoke',
      showTimestamps: false,
    });
    assert.strictEqual(lines.length, 5);
    assert.ok(stripAnsi(lines.join('\n')).toLowerCase().includes('play'));
  });

  it('should render AlbumArt component', () => {
    const lines = renderAlbumArt({
      width: 30,
      height: 8,
      song,
      theme,
    });
    assert.strictEqual(lines.length, 8);
    assert.ok(stripAnsi(lines.join('\n')).includes('BOHEMIAN RHAPSODY') || stripAnsi(lines.join('\n')).includes('YOUTUBE MUSIC'));
  });

  it('should render all visualizer types synchronized with spectrum data', () => {
    const viz = new AudioVisualizer('bars');
    const types = ['bars', 'wave', 'flame', 'particles', 'matrix', 'pulse', 'vinyl'] as const;
    const mockSpectrum = [0.9, 0.85, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.18, 0.15, 0.12, 0.1, 0.08];

    for (const t of types) {
      viz.setType(t);
      const lines = viz.render({
        width: 40,
        height: 6,
        timeMs: 1500,
        isPlaying: true,
        theme,
        bpm: 128,
        spectrum: mockSpectrum,
      });
      assert.strictEqual(lines.length, 6, `Visualizer type ${t} must render 6 lines`);
      for (let idx = 0; idx < lines.length; idx++) {
        const w = getVisualWidth(lines[idx]);
        assert.ok(w <= 40, `Visualizer ${t} line ${idx} width ${w} must be <= 40`);
      }
    }
  });

  it('should render Modals (Help, Search, Reading)', () => {
    const helpLines = renderHelpModal(theme, { width: 80, height: 24 });
    assert.ok(helpLines.length > 0);
    const helpText = stripAnsi(helpLines.join('\n'));
    assert.ok(helpText.includes('Playback & Views'));
    assert.ok(helpText.includes('Visuals & Navigation'));
    assert.ok(helpText.includes('0 / Home'));
    assert.ok(helpText.includes('R or M'));
    assert.ok(helpText.includes('P or L'));
    assert.ok(helpText.includes('Tab'));
    assert.ok(helpText.includes('? or H'));
    const searchLines = renderSearchModal('queen', [], 0, false, null, theme, { width: 80, height: 24 });
    assert.ok(searchLines.length > 0);
    const searchText = stripAnsi(searchLines.join('\n'));
    assert.ok(searchText.includes('queen'), 'typed query must appear in the search input');
    assert.ok(searchText.includes('YouTube Music Search'));
    assert.strictEqual(sliceVisualEnd('bohemian rhapsody', 8), 'rhapsody');

    const emptySearch = stripAnsi(renderSearchModal('', [], 0, false, null, theme, { width: 80, height: 24 }).join('\n'));
    assert.ok(emptySearch.includes('Search songs, artists, albums, or paste a URL'));

    const searchResultsRender = renderSearchModal(
      'que',
      [{ id: '1', title: 'Bohemian Rhapsody', artist: 'Queen', duration: 355, hasSynced: true, source: 'youtube' }],
      0,
      false,
      null,
      theme,
      { width: 80, height: 24 },
      'all'
    );
    const resultsText = stripAnsi(searchResultsRender.join('\n'));
    assert.ok(resultsText.includes('que'));
    assert.ok(!resultsText.includes('Suggestions'));
    assert.ok(!resultsText.includes('Results for'));
    assert.ok(resultsText.includes('Bohemian Rhapsody'));
    assert.ok(resultsText.includes('Queen'));
    const readingLines = renderReadingView(song, 0, 0, theme, { width: 80, height: 24 });
    assert.ok(readingLines.length > 0);
  });

  it('should render full frame within exact terminal bounds across multiple resolutions', () => {
    const testDimensions = [
      { width: 80, height: 24 },
      { width: 96, height: 24 },
      { width: 120, height: 35 },
      { width: 140, height: 35 },
      { width: 60, height: 20 },
    ];

    for (const dims of testDimensions) {
      const app = new LyricalApp({ initialSong: song, initialTheme: 'cyberpunk' });
      let capturedFrame = '';
      const appSeam = app as unknown as {
        screen: {
          getDimensions: () => { width: number; height: number };
          render: (output: string) => void;
        };
        render: () => void;
      };
      appSeam.screen = {
        getDimensions: () => dims,
        render: (output: string) => {
          capturedFrame = output;
        },
      };
      appSeam.render();
      const lines = capturedFrame.split('\n');
      assert.strictEqual(lines.length, dims.height, `Height should match ${dims.height}`);
      for (let idx = 0; idx < lines.length; idx++) {
        const lineW = getVisualWidth(lines[idx]);
        assert.strictEqual(lineW, dims.width, `Line ${idx} visual width ${lineW} must be exactly ${dims.width}`);
      }
    }
  });

  it('should maintain exact line width across modal transitions to prevent screen character persistence', () => {
    const dims = { width: 80, height: 24 };
    const app = new LyricalApp({ initialSong: song, initialTheme: 'cyberpunk' });
    let capturedFrame = '';
    const appSeam = app as unknown as {
      screen: {
        getDimensions: () => { width: number; height: number };
        render: (output: string) => void;
      };
      viewMode: string;
      render: () => void;
    };
    appSeam.screen = {
      getDimensions: () => dims,
      render: (output: string) => {
        capturedFrame = output;
      },
    };

    const modes = ['search', 'playlists', 'queue', 'explore', 'help', 'reading', 'karaoke'];
    for (const mode of modes) {
      appSeam.viewMode = mode;
      appSeam.render();
      const lines = capturedFrame.split('\n');
      assert.strictEqual(lines.length, dims.height, `Mode ${mode} height mismatch`);
      for (let idx = 0; idx < lines.length; idx++) {
        const lineW = getVisualWidth(lines[idx]);
        assert.strictEqual(lineW, dims.width, `Mode ${mode} line ${idx} width ${lineW} must be exactly ${dims.width}`);
      }
    }
  });
});

describe('YouTube Music Services & URL Extraction', () => {
  it('should extract video IDs from various YouTube and YouTube Music URLs', () => {
    assert.strictEqual(extractVideoId('lYBUbBu4W08'), 'lYBUbBu4W08');
    assert.strictEqual(extractVideoId('https://music.youtube.com/watch?v=lYBUbBu4W08'), 'lYBUbBu4W08');
    assert.strictEqual(extractVideoId('https://www.youtube.com/watch?v=lYBUbBu4W08&feature=share'), 'lYBUbBu4W08');
    assert.strictEqual(extractVideoId('https://youtu.be/lYBUbBu4W08'), 'lYBUbBu4W08');

    assert.strictEqual(extractPlaylistId('PL1234567890abcdef'), 'PL1234567890abcdef');
    assert.strictEqual(extractPlaylistId('https://music.youtube.com/playlist?list=PL1234567890abcdef'), 'PL1234567890abcdef');
  });
});

describe('YouTube Music Auth Management', () => {
  it('should save, load, and clear auth credentials', () => {
    saveAuthCredentials({
      cookie: 'TEST_COOKIE=123',
      accountInfo: {
        name: 'Test User',
        email: 'test@example.com',
        hasPremium: true,
      },
    });

    const loaded = loadAuthCredentials();
    assert.ok(loaded);
    assert.strictEqual(loaded?.cookie, 'TEST_COOKIE=123');
    assert.strictEqual(loaded?.accountInfo?.hasPremium, true);

    clearAuthCredentials();
    const cleared = loadAuthCredentials();
    assert.strictEqual(cleared, null);
  });
});

describe('Extended YouTube Music Modals', () => {
  it('should render Playlist, Queue, Explore, and Auth modals cleanly', () => {
    const theme = THEMES.ytmusic;
    const dims = { width: 80, height: 24 };

    const plLines = renderPlaylistModal(
      [{ id: 'LM', title: 'Liked Music', itemCount: 10 }],
      0,
      null,
      0,
      theme,
      dims
    );
    assert.ok(plLines.length > 0);
    assert.ok(stripAnsi(plLines.join('\n')).includes('Liked Music'));

    const queueLines = renderQueueModal([globalSong], 0, 0, theme, dims);
    assert.ok(queueLines.length > 0);
    assert.ok(stripAnsi(queueLines.join('\n')).includes('Playback Queue'));

    const exploreLines = renderExploreModal(
      [{ title: 'Top Charts', items: [{ id: '123', title: 'Trending Track', type: 'song' }] }],
      0,
      0,
      theme,
      dims
    );
    assert.ok(exploreLines.length > 0);
    assert.ok(stripAnsi(exploreLines.join('\n')).includes('Trending Track'));

    const authLines = renderAuthModal(
      { accountInfo: { name: 'Premium User', email: 'user@gmail.com', hasPremium: true } },
      null,
      theme,
      dims
    );
    assert.ok(authLines.length > 0);
    assert.ok(stripAnsi(authLines.join('\n')).includes('PREMIUM'));
  });
});

describe('Interactive Keypress & Search Handling', () => {
  it('should open search modal on / keypress and s keypress', () => {
    const app = new LyricalApp({ initialSong: globalSong, initialTheme: 'ytmusic' });
    const appSeam = app as unknown as {
      viewMode: string;
      searchQuery: string;
      searchType: string;
      handleKey: (key: { name?: string; sequence?: string }, str?: string) => void;
    };
    assert.strictEqual(appSeam.viewMode, 'karaoke');

    appSeam.handleKey({ sequence: '/' }, '/');
    assert.strictEqual(appSeam.viewMode, 'search');

    appSeam.handleKey({ sequence: 'q' }, 'q');
    appSeam.handleKey({ sequence: 'u' }, 'u');
    appSeam.handleKey({ sequence: 'e' }, 'e');
    appSeam.handleKey({ sequence: 'e' }, 'e');
    appSeam.handleKey({ sequence: 'n' }, 'n');
    assert.strictEqual(appSeam.searchQuery, 'queen');

    assert.strictEqual(appSeam.searchType, 'all');
    appSeam.handleKey({ name: 'tab' }, '\t');
    assert.strictEqual(appSeam.searchType, 'song');

    appSeam.handleKey({ name: 'escape' }, '\x1b');
    assert.strictEqual(appSeam.viewMode, 'karaoke');

    appSeam.handleKey({ sequence: 'p' }, 'p');
    assert.strictEqual(appSeam.viewMode, 'playlists');

    appSeam.handleKey({ name: 'escape' }, '\x1b');
    assert.strictEqual(appSeam.viewMode, 'karaoke');

    appSeam.handleKey({ sequence: 'q' }, 'q');
    assert.strictEqual(appSeam.viewMode, 'queue');

    appSeam.handleKey({ name: 'escape' }, '\x1b');
    assert.strictEqual(appSeam.viewMode, 'karaoke');

    appSeam.handleKey({ sequence: 'e' }, 'e');
    assert.strictEqual(appSeam.viewMode, 'explore');
  });

  it('should render typed search text and direct results in the TUI frame', () => {
    const app = new LyricalApp({ initialSong: globalSong, initialTheme: 'ytmusic' });
    let capturedFrame = '';
    const appSeam = app as unknown as {
      screen: {
        getDimensions: () => { width: number; height: number };
        render: (output: string) => void;
      };
      searchQuery: string;
      searchResults: unknown[];
      searchSelectedIndex: number;
      handleKey: (key: { name?: string; sequence?: string }, str?: string) => void;
      loadSearchResult: (item: { title: string }) => void;
      render: () => void;
    };
    appSeam.screen = {
      getDimensions: () => ({ width: 80, height: 24 }),
      render: (output: string) => {
        capturedFrame = output;
      },
    };
    appSeam.handleKey({ sequence: '/' }, '/');
    appSeam.handleKey({ name: 'b' }, '');
    appSeam.handleKey({ name: 'o' }, '');
    appSeam.handleKey({ name: 'h' }, '');
    assert.strictEqual(appSeam.searchQuery, 'boh');

    appSeam.searchResults = [
      { id: '1', title: 'Bohemian Rhapsody', artist: 'Queen', duration: 355, hasSynced: true, source: 'youtube' },
    ];
    appSeam.render();

    const lines = capturedFrame.split('\n');
    assert.strictEqual(lines.length, 24);
    const combined = stripAnsi(capturedFrame);
    assert.ok(combined.includes('boh'), 'input field must show the typed query');
    assert.ok(!combined.includes('Suggestions'));
    assert.ok(!combined.includes('Results for'));
    assert.ok(combined.includes('Bohemian Rhapsody'));
    for (let idx = 0; idx < lines.length; idx++) {
      const lineW = getVisualWidth(lines[idx]);
      assert.strictEqual(lineW, 80, `Line ${idx} visual width ${lineW} must be 80`);
    }

    let loadedItem: { title: string } | null = null;
    appSeam.loadSearchResult = (item: { title: string }) => {
      loadedItem = item;
    };
    appSeam.searchSelectedIndex = 0;
    appSeam.handleKey({ name: 'return' }, '\r');
    assert.strictEqual(loadedItem?.title, 'Bohemian Rhapsody');
  });
});

describe('Seek, Album Art & Musical Note UX Fixes', () => {
  it('should maintain playing status when seeking during active playback', async () => {
    const player = new LyricPlayer(globalSong, new SimulatedAudioBackend());
    await player.play();
    assert.strictEqual(player.getState().status, 'playing');

    player.seek(50000);
    assert.strictEqual(player.getState().status, 'playing');
    assert.strictEqual(player.getState().currentTimeMs, 50000);

    player.seekDelta(15000);
    assert.strictEqual(player.getState().status, 'playing');
    assert.strictEqual(player.getState().currentTimeMs, 65000);

    player.seekDelta(-30000);
    assert.strictEqual(player.getState().status, 'playing');
    assert.strictEqual(player.getState().currentTimeMs, 35000);
    player.stop();
  });

  it('should resume from pause without leaving playing state', async () => {
    const player = new LyricPlayer(globalSong, new SimulatedAudioBackend());
    await player.play();
    player.pause();
    assert.strictEqual(player.getState().status, 'paused');
    await player.play();
    assert.strictEqual(player.getState().status, 'playing');
    player.setVolume(40);
    assert.strictEqual(player.getState().status, 'playing');
    assert.strictEqual(player.getState().volume, 40);
    player.stop();
  });

  it('should robustly extract thumbnail URLs from various metadata formats', () => {
    assert.strictEqual(extractThumbnailUrl('https://example.com/art.jpg'), 'https://example.com/art.jpg');
    assert.strictEqual(extractThumbnailUrl({ thumbnailUrl: 'https://example.com/art2.jpg' }), 'https://example.com/art2.jpg');
    assert.strictEqual(
      extractThumbnailUrl({ thumbnails: [{ url: 'https://example.com/small.jpg' }, { url: 'https://example.com/large.jpg' }] }),
      'https://example.com/large.jpg'
    );
    assert.strictEqual(
      extractThumbnailUrl({ thumbnail: [{ url: 'https://example.com/t1.jpg' }, { url: 'https://example.com/t2.jpg' }] }),
      'https://example.com/t2.jpg'
    );
    assert.strictEqual(
      extractThumbnailUrl({ thumbnail: { contents: [{ url: 'https://example.com/c1.jpg' }, { url: 'https://example.com/c2.jpg' }] } }),
      'https://example.com/c2.jpg'
    );
    assert.strictEqual(
      extractThumbnailUrl({ header: { thumbnails: [{ url: 'https://example.com/h1.jpg' }] } }),
      'https://example.com/h1.jpg'
    );
    assert.strictEqual(extractThumbnailUrl(null), undefined);
  });

  it('should render musical note with shimmer instead of musical progress bar', () => {
    const instrumentalSong = {
      id: 'inst-1',
      title: 'Solo Track',
      artist: 'Guitarist',
      durationMs: 120000,
      lyrics: [
        { id: 0, text: '♪', startMs: 0, endMs: 10000, isInstrumental: true },
        { id: 1, text: '♫ Guitar Solo', startMs: 10000, endMs: 25000, isInstrumental: true },
        { id: 2, text: 'Singing line', startMs: 25000, endMs: 40000, isInstrumental: false },
      ],
    };

    const player = new LyricPlayer(instrumentalSong);
    player.seek(5000);
    const state = player.getState();

    const lines = renderLyricsViewport({
      width: 70,
      height: 8,
      song: instrumentalSong,
      state,
      theme: THEMES.ytmusic,
      showTimestamps: false,
    });

    const rendered = stripAnsi(lines.join('\n'));
    // Must NOT contain the old progress bar characters
    assert.ok(!rendered.includes('━'), 'Should not contain progress bar fill ━');
    assert.ok(!rendered.includes('●'), 'Should not contain progress bar dot ●');
    assert.ok(!rendered.includes('Musical Interlude'), 'Should not contain old Musical Interlude label');

    // Must contain musical note symbol
    assert.ok(rendered.includes('♪'), 'Should contain musical note symbol ♪');

    // formatMusicalNoteText and isMusicalNoteLine helpers
    assert.strictEqual(isMusicalNoteLine(instrumentalSong.lyrics[0]), true);
    assert.strictEqual(isMusicalNoteLine(instrumentalSong.lyrics[1]), true);
    assert.strictEqual(isMusicalNoteLine(instrumentalSong.lyrics[2]), false);
    assert.strictEqual(formatMusicalNoteText(instrumentalSong.lyrics[0]), '♪');
    assert.strictEqual(formatMusicalNoteText({ id: 99, text: '', startMs: 0, endMs: 1000, isInstrumental: true }), '♪   ♪   ♪');
    assert.strictEqual(formatMusicalNoteText({ id: 100, text: '(Instrumental)', startMs: 0, endMs: 1000, isInstrumental: true }), '♪   ♪   ♪');
  });

  it('should instantiate system audio backend without spawning playback', () => {
    const backend = createAudioBackend();
    assert.ok(backend !== null);
    assert.ok(backend.getName().length > 0);

    const system = new SystemAudioBackend();
    assert.ok(system.getName().length > 0);
    assert.strictEqual(system.status, 'stopped');
    system.setVolume(75);
    assert.strictEqual(system.currentVolume, 75);
    system.seek(12000);
    assert.strictEqual(system.currentMs, 12000);
    system.stop();
    system.destroy();

    assert.strictEqual(isStreamRef('dQw4w9WgXcQ'), true);
    assert.strictEqual(isStreamRef('queen-bohemian-rhapsody'), false);
    assert.strictEqual(isStreamRef('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), true);
  });
});
