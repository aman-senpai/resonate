import * as readline from 'readline';
import { AuthCredentials, SearchResult, Song, ViewMode, YtExploreCategory, YtPlaylist, YtTrack } from './types.js';
import { LyricPlayer } from './engine/player.js';
import { AudioVisualizer } from './engine/visualizer.js';
import { ThemeManager } from './ui/themes.js';
import { ANSI, colorText, fg, getVisualWidth, pad, ScreenBuffer, truncate } from './ui/renderer.js';
import { renderHeader } from './ui/components/Header.js';
import { renderLyricsViewport } from './ui/components/LyricsViewport.js';
import { renderControlBar } from './ui/components/ControlBar.js';
import { renderAlbumArt } from './ui/components/AlbumArt.js';
import {
  renderAuthModal,
  renderDownloadsModal,
  renderExploreModal,
  renderHelpModal,
  renderPlaylistModal,
  renderQueueModal,
  renderReadingView,
  renderSearchModal,
} from './ui/components/Modals.js';
import { fetchSongDetails, searchLyrics } from './services/lyricsApi.js';
import { ensurePlayableSong, getExploreFeed, getLikedSongs, getSearchAutocomplete, getTrendingSuggestions, getUserPlaylists, getYtPlaylist, getYtUpNext, isStreamRef, prefetchAudioStream, searchYtMusic } from './services/ytmusic.js';
import { getAlbumArtAnsi } from './services/albumArt.js';
import { loadAuthCredentials } from './services/auth.js';
import { formatStorageLimit, getConfig, saveConfig } from './services/config.js';
import {
  deleteAllDownloadedSongs,
  deleteDownloadedSong,
  downloadSong,
  findDownloadedMatch,
  getDownloadedCount,
  getDownloadedSong,
  getDownloadedSongs,
  getTotalDownloadedBytes,
  isSongDownloaded,
  toPlayableSong,
  touchDownloadedSong,
} from './services/downloadManager.js';

import { formatMsToTime } from './parser/lrc.js';

export interface AppOptions {
  initialSong?: Song;
  initialTheme?: string;
  autoPlay?: boolean;
  speed?: number;
  initialSearchQuery?: string;
  startView?: ViewMode;
}

export class LyricalApp {
  private screen: ScreenBuffer;
  private player: LyricPlayer;
  private visualizer: AudioVisualizer;
  private themeManager: ThemeManager;
  private viewMode: ViewMode = 'karaoke';

  private showTimestamps: boolean = false;
  private showAlbumArt: boolean = true;
  private isRunning: boolean = false;
  private renderTimer: NodeJS.Timeout | null = null;

  // Queue state
  private queue: Song[] = [];
  private currentQueueIndex: number = 0;
  private autoPlayRadio: boolean = true;
  private shuffleEnabled: boolean = false;

  // Search state
  private searchQuery: string = '';
  private searchResults: SearchResult[] = [];
  private searchSelectedIndex: number = 0;
  private searchType: 'all' | 'song' | 'album' | 'playlist' | 'video' = 'all';
  private isSearching: boolean = false;
  private searchError: string | null = null;
  private searchDebounceTimer: NodeJS.Timeout | null = null;
  private suggestedSongs: SearchResult[] = [];

  // Playlists state
  private playlists: YtPlaylist[] = [];
  private selectedPlaylistIndex: number = 0;
  private currentPlaylistTracks: YtTrack[] | null = null;
  private selectedPlaylistTrackIndex: number = 0;
  private isLoadingPlaylists: boolean = false;

  // Explore & Charts state
  private exploreCategories: YtExploreCategory[] = [];
  private selectedExploreCategoryIndex: number = 0;
  private selectedExploreItemIndex: number = 0;
  private isLoadingExplore: boolean = false;

  // Song selector (bundled) state
  private selectorSelectedIndex: number = 0;

  // Reading view state
  private readingScrollOffset: number = 0;

  // Downloads manager
  private downloadsSelectedIndex: number = 0;
  private downloadsConfirm: { mode: 'one' | 'all'; id?: string; title?: string } | null = null;


  // Auth info
  private authCreds: AuthCredentials | null = null;
  private notificationMessage: string | null = null;
  private notificationTimer: NodeJS.Timeout | null = null;

  constructor(opts: AppOptions = {}) {
    this.screen = new ScreenBuffer();
    this.visualizer = new AudioVisualizer('bars');
    this.themeManager = new ThemeManager(opts.initialTheme || getConfig().theme || 'ytmusic');

    const initialSong = opts.initialSong || {
      id: '',
      title: 'YouTube Music Player',
      artist: 'Press / or S to Search',
      durationMs: 0,
      lyrics: [],
      source: 'youtube',
    };
    this.player = new LyricPlayer(initialSong);

    this.queue = [initialSong];
    this.currentQueueIndex = 0;

    if (opts.speed) {
      this.player.setSpeed(opts.speed);
    }
    if (initialSong.thumbnailUrl) {
      this.fetchArtForSong(initialSong);
    }

    this.loadInitialSuggestions();

    if (opts.autoPlay && opts.initialSong && opts.initialSong.id) {
      void this.playSong(opts.initialSong);
    }

    if (opts.initialSearchQuery) {
      this.searchQuery = opts.initialSearchQuery;
      this.viewMode = 'search';
      this.triggerSearch();
    } else if (opts.startView === 'playlists') {
      this.openPlaylistsModal();
    } else if (opts.startView === 'explore') {
      this.openExploreModal();
    } else if (opts.startView === 'downloads') {
      this.openDownloadsModal();
    } else if (opts.startView === 'search' || !opts.initialSong) {
      this.openSearchModal();
    }
  }

  private setupPlayerEvents(): void {
    this.player.on('ended', () => {
      this.handleSongEnded();
    });

    this.player.on('error', (err) => {
      this.showNotification(`Audio notice: ${err.message}`);
    });
  }

  public showNotification(msg: string, durationMs: number = 4000): void {
    this.notificationMessage = msg;
    clearTimeout(this.notificationTimer!);
    this.notificationTimer = setTimeout(() => {
      this.notificationMessage = null;
    }, durationMs);
  }

  private async handleSongEnded(): Promise<void> {
    if (this.currentQueueIndex < this.queue.length - 1) {
      // Next track in queue
      this.nextTrack();
    } else if (this.autoPlayRadio) {
      // Fetch related songs for auto-queue radio
      const currentSong = this.player.getCurrentSong();
      if (currentSong && currentSong.source === 'youtube') {
        try {
          this.showNotification('[...] Fetching next radio track...');
          const upNext = await getYtUpNext(currentSong.id);
          if (upNext.length > 0) {
            const nextTrackMeta = upNext[0];
            const song = await fetchSongDetails({
              id: nextTrackMeta.id,
              title: nextTrackMeta.title,
              artist: nextTrackMeta.artist,
              duration: Math.floor(nextTrackMeta.durationMs / 1000),
              hasSynced: false,
              source: 'youtube',
              thumbnailUrl: nextTrackMeta.thumbnailUrl,
            });
            if (song) {
              this.queue.push(song);
              this.nextTrack();
              return;
            }
          }
        } catch {
          // Fallback
        }
      }
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.screen.init();
    this.setupInput();
    this.setupPlayerEvents();

    this.renderTimer = setInterval(() => {
      this.render();
    }, 33);

    this.render();

    this.player.play().catch(() => {});
  }

  public stop(): void {
    this.isRunning = false;
    clearInterval(this.renderTimer!);
    this.renderTimer = null;
    clearTimeout(this.searchDebounceTimer!);
    clearTimeout(this.notificationTimer!);

    this.player.destroy();
    this.screen.destroy();
  }

  private setupInput(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf-8');

      readline.emitKeypressEvents(process.stdin);
      process.stdin.on('keypress', (str: string, key: readline.Key) => {
        if (!key && !str) return;
        this.handleKey(key || ({} as readline.Key), str || '');
      });
    }

    process.stdout.on('resize', () => {
      this.render();
    });
  }

  private handleKey(key: readline.Key, str: string = ''): void {
    // Global Exit: Ctrl+C
    if (key.ctrl && (key.name === 'c' || str === '\x03')) {
      this.stop();
      process.exit(0);
    }

    // Modal Routing
    if (this.viewMode === 'search') {
      this.handleSearchInput(key, str);
      return;
    }

    if (this.viewMode === 'playlists') {
      this.handlePlaylistInput(key);
      return;
    }

    if (this.viewMode === 'queue') {
      this.handleQueueInput(key, str);
      return;
    }

    if (this.viewMode === 'explore') {
      this.handleExploreInput(key);
      return;
    }

    if (this.viewMode === 'downloads') {
      this.handleDownloadsInput(key, str);
      return;
    }



    if (this.viewMode === 'reading') {
      this.handleReadingInput(key);
      return;
    }

    if (this.viewMode === 'help' || this.viewMode === 'auth') {
      if (key.name === 'escape' || key.name === 'q' || key.name === 'return' || key.name === 'space' || str === 'q' || str === ' ') {
        this.viewMode = 'karaoke';
      }
      return;
    }

    const ch = str || key.sequence || '';
    const name = (key.name || '').toLowerCase();

    // Search Modal Trigger: '/' or 's' or 'S'
    if (ch === '/' || name === 'slash' || ch === 's' || ch === 'S' || name === 's') {
      this.openSearchModal();
      return;
    }

    // Playlists & Library Trigger: 'p' or 'l'
    if (ch === 'p' || ch === 'P' || ch === 'l' || ch === 'L' || name === 'p' || name === 'l') {
      this.openPlaylistsModal();
      return;
    }

    // Queue Trigger: 'q'
    if (ch === 'q' || ch === 'Q' || name === 'q') {
      this.openQueueModal();
      return;
    }

    // Explore Trigger: 'e'
    if (ch === 'e' || ch === 'E' || name === 'e') {
      this.openExploreModal();
      return;
    }

    // Downloads manager: 'd'
    if (ch === 'd' || ch === 'D' || name === 'd') {
      this.openDownloadsModal();
      return;
    }

    // Reading Lyrics Toggle: 'r' or 'm'
    if (ch === 'r' || ch === 'R' || ch === 'm' || ch === 'M' || name === 'r' || name === 'm') {
      this.viewMode = (this.viewMode as string) === 'reading' ? 'karaoke' : 'reading';
      return;
    }

    // Visualizer Mode Cycle: 'v'
    if (ch === 'v' || ch === 'V' || name === 'v') {
      const nextViz = this.visualizer.nextType();
      this.showNotification(`⚡ Visualizer: ${nextViz.toUpperCase()}`, 1500);
      return;
    }

    // Theme Cycle: 't' (Shift+T for prev theme)
    if (ch === 't' || ch === 'T' || name === 't') {
      if (key.shift || ch === 'T') {
        this.themeManager.prevTheme();
      } else {
        this.themeManager.nextTheme();
      }
      saveConfig({ theme: this.themeManager.getTheme().id });
      this.showNotification(`★ Theme: ${this.themeManager.getTheme().name}`, 1500);
      return;
    }

    // Album Art Toggle: 'a'
    if (ch === 'a' || ch === 'A' || name === 'a') {
      this.showAlbumArt = !this.showAlbumArt;
      this.showNotification(`■ Album Art: ${this.showAlbumArt ? 'ON' : 'OFF'}`, 1500);
      return;
    }

    // Audio/Lyrics Sync Offset Adjustment: '[' and ']'
    if (ch === '[' || name === 'bracketleft') {
      this.player.adjustOffset(-100);
      this.showNotification(`⏱ Sync Offset: ${(this.player.getState().offsetMs / 1000).toFixed(1)}s`, 1500);
      return;
    }
    if (ch === ']' || name === 'bracketright') {
      this.player.adjustOffset(100);
      this.showNotification(`⏱ Sync Offset: ${(this.player.getState().offsetMs / 1000).toFixed(1)}s`, 1500);
      return;
    }

    // Timestamps display toggle: 'i'
    if (ch === 'i' || ch === 'I' || name === 'i') {
      this.showTimestamps = !this.showTimestamps;
      this.showNotification(`⏱ Timestamps: ${this.showTimestamps ? 'ON' : 'OFF'}`, 1500);
      return;
    }

    // Play / Pause: Space
    if (ch === ' ' || name === 'space') {
      this.player.togglePlay();
      return;
    }

    // Next / Previous Track: 'n' / 'b'
    if (ch === 'n' || ch === 'N' || name === 'n') {
      this.nextTrack();
      return;
    }
    if (ch === 'b' || ch === 'B' || name === 'b') {
      this.prevTrack();
      return;
    }

    // Restart: '0' or Home
    if (ch === '0' || name === 'home' || name === '0') {
      this.player.seek(0);
      this.showNotification('⏮ Restarted from beginning', 1500);
      return;
    }

    // Seek Left / Right
    if (name === 'left') {
      this.player.seekDelta(key.shift ? -15000 : -5000);
      const st = this.player.getState();
      this.showNotification(`⏪ Seek: ${formatMsToTime(st.currentTimeMs)} / ${formatMsToTime(st.durationMs)}`, 1500);
      return;
    }
    if (name === 'right') {
      this.player.seekDelta(key.shift ? 15000 : 5000);
      const st = this.player.getState();
      this.showNotification(`⏩ Seek: ${formatMsToTime(st.currentTimeMs)} / ${formatMsToTime(st.durationMs)}`, 1500);
      return;
    }
    // Volume Up / Down
    if (name === 'up') {
      this.player.adjustVolume(5);
      this.showNotification(`VOL: ${this.player.getState().volume}%`, 1500);
      return;
    }
    if (name === 'down') {
      this.player.adjustVolume(-5);
      this.showNotification(`VOL: ${this.player.getState().volume}%`, 1500);
      return;
    }

    // Toggle Loop: 'o'
    if (ch === 'o' || ch === 'O' || name === 'o') {
      this.player.toggleLoop();
      this.showNotification(`LOOP: ${this.player.getState().loop ? 'ON' : 'OFF'}`, 1500);
      return;
    }

    // Toggle Shuffle: 'x'
    if (ch === 'x' || ch === 'X' || name === 'x') {
      this.toggleShuffle();
      return;
    }

    // Toggle Mute: 'u'
    if (ch === 'u' || ch === 'U' || name === 'u') {
      this.player.toggleMute();
      const st = this.player.getState();
      this.showNotification(st.muted ? 'VOL: MUTE' : `VOL: ${st.volume}%`, 1500);
      return;
    }

    // Speed Adjustment: ',' and '.'
    if (ch === ',' || name === 'comma') {
      this.player.adjustSpeed(-0.25);
      this.showNotification(`SPD: ${this.player.getState().speed.toFixed(2)}x`, 1500);
      return;
    }
    if (ch === '.' || name === 'period') {
      this.player.adjustSpeed(0.25);
      this.showNotification(`SPD: ${this.player.getState().speed.toFixed(2)}x`, 1500);
      return;
    }



    // Tab -> Open Search Modal
    if (name === 'tab') {
      this.openSearchModal();
      return;
    }

    // Help modal: '?' or 'h'
    if (ch === '?' || ch === 'h' || ch === 'H' || name === 'h') {
      this.viewMode = 'help';
      return;
    }

    // Escape
    if (name === 'escape') {
      this.viewMode = 'karaoke';
      return;
    }
  }

  public async playSong(song: Song): Promise<void> {
    const query = `${song.title || ''} ${song.artist || ''}`.trim();
    const local = (song.id ? getDownloadedSong(song.id) : undefined)
      || (query ? findDownloadedMatch(query) : undefined)
      || (song.title ? findDownloadedMatch(song.title) : undefined);

    let playable = song;
    if (local) {
      playable = toPlayableSong(local);
      if (song.lyrics && song.lyrics.length > 0) {
        playable.lyrics = song.lyrics;
        playable.plainLyrics = song.plainLyrics || playable.plainLyrics;
      }
      playable.thumbnailUrl = playable.thumbnailUrl || song.thumbnailUrl;
      playable.art = song.art;
      playable.coverColor = song.coverColor;
      touchDownloadedSong(local.id);
    }

    const existingIdx = this.queue.findIndex((s) => s.id === playable.id || s.id === song.id);
    if (existingIdx !== -1) {
      this.currentQueueIndex = existingIdx;
      this.queue[existingIdx] = playable;
    } else {
      this.queue.push(playable);
      this.currentQueueIndex = this.queue.length - 1;
    }

    if (!local) {
      await ensurePlayableSong(playable);
      const playTarget = playable.audioUrl && isStreamRef(playable.audioUrl) ? playable.audioUrl : playable.id;
      if (isStreamRef(playTarget)) prefetchAudioStream(playTarget);
    }

    await this.player.loadSong(playable, true);
    this.fetchArtForSong(playable);
    this.prefetchNeighbors();

    const ytId = /^[a-zA-Z0-9_-]{11}$/.test(song.id)
      ? song.id
      : (playable.id && /^[a-zA-Z0-9_-]{11}$/.test(playable.id) ? playable.id : '');

    if (getConfig().autoDownload && ytId && !isSongDownloaded(ytId) && !local) {
      void downloadSong({ ...playable, id: ytId }).then((d) => {
        if (d) this.showNotification(`⬇ Saved offline: ${d.title}`, 2000);
      });
    }

    if (ytId) {
      getYtUpNext(ytId).then((related) => {
        for (const item of related.slice(0, 5)) {
          const isAlreadyInQueue = this.queue.some((q) => q.id === item.id);
          if (!isAlreadyInQueue) {
            fetchSongDetails({
              id: item.id,
              title: item.title,
              artist: item.artist,
              duration: Math.floor(item.durationMs / 1000),
              hasSynced: false,
              source: 'youtube',
              thumbnailUrl: item.thumbnailUrl,
            }).then((s) => {
              if (s && !this.queue.some((q) => q.id === s.id)) {
                this.queue.push(s);
                this.prefetchNeighbors();
              }
            }).catch(() => {});
          }
        }
      }).catch(() => {});
    }
  }


  private nextTrack(): void {
    if (this.queue.length === 0) return;
    if (this.currentQueueIndex < this.queue.length - 1) {
      this.currentQueueIndex++;
      const next = this.queue[this.currentQueueIndex];
      this.playSong(next);
      this.showNotification(`▶ Next: ${next.title} - ${next.artist}`);
    } else {
      this.showNotification('Reached end of queue');
    }
  }

  private prevTrack(): void {
    if (this.queue.length === 0) return;
    if (this.currentQueueIndex > 0) {
      this.currentQueueIndex--;
      const prev = this.queue[this.currentQueueIndex];
      this.playSong(prev);
      this.showNotification(`◀ Previous: ${prev.title} - ${prev.artist}`);
    } else {
      this.player.seek(0);
    }
  }

  private prefetchNeighbors(): void {
    for (const offset of [-1, 1, 2, 3]) {
      const idx = this.currentQueueIndex + offset;
      if (idx < 0 || idx >= this.queue.length) continue;
      const item = this.queue[idx];
      void ensurePlayableSong(item).then((song) => {
        const target = song.audioUrl && isStreamRef(song.audioUrl) ? song.audioUrl : song.id;
        if (isStreamRef(target)) prefetchAudioStream(target);
      });
    }
  }

  private toggleShuffle(): void {
    this.shuffleEnabled = !this.shuffleEnabled;
    if (this.shuffleEnabled && this.currentQueueIndex < this.queue.length - 1) {
      const upcoming = this.queue.slice(this.currentQueueIndex + 1);
      for (let i = upcoming.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
      }
      this.queue.splice(this.currentQueueIndex + 1, upcoming.length, ...upcoming);
    }
    this.showNotification(`Shuffle: ${this.shuffleEnabled ? 'ON' : 'OFF'}`, 1500);
  }

  private openDownloadsModal(): void {
    this.viewMode = 'downloads';
    this.downloadsSelectedIndex = 0;
    this.downloadsConfirm = null;
  }

  private handleDownloadsInput(key: readline.Key, str: string = ''): void {
    const name = (key.name || '').toLowerCase();
    let ch = str || key.sequence || '';
    if (!ch && name.length === 1 && !key.ctrl && !key.meta) {
      ch = key.shift ? name.toUpperCase() : name;
    }

    if (this.downloadsConfirm) {
      if (name === 'y' || ch === 'y' || ch === 'Y') {
        if (this.downloadsConfirm.mode === 'all') {
          const n = deleteAllDownloadedSongs();
          this.showNotification(`Deleted ${n} downloaded song${n === 1 ? '' : 's'}`, 2000);
        } else if (this.downloadsConfirm.id) {
          const title = this.downloadsConfirm.title || 'song';
          deleteDownloadedSong(this.downloadsConfirm.id);
          this.showNotification(`Deleted "${title}"`, 2000);
        }
        this.downloadsConfirm = null;
        const remaining = getDownloadedSongs();
        this.downloadsSelectedIndex = Math.min(this.downloadsSelectedIndex, Math.max(0, remaining.length - 1));
        return;
      }
      if (name === 'n' || ch === 'n' || ch === 'N' || name === 'escape') {
        this.downloadsConfirm = null;
        return;
      }
      return;
    }

    if (name === 'escape' || ch === '\x1b') {
      this.viewMode = 'karaoke';
      return;
    }

    const songs = getDownloadedSongs();
    if (name === 'up') {
      this.downloadsSelectedIndex = Math.max(0, this.downloadsSelectedIndex - 1);
      return;
    }
    if (name === 'down') {
      this.downloadsSelectedIndex = Math.min(Math.max(0, songs.length - 1), this.downloadsSelectedIndex + 1);
      return;
    }

    if (name === 'return' || name === 'enter' || ch === '\r' || ch === '\n') {
      const item = songs[this.downloadsSelectedIndex];
      if (item) {
        this.viewMode = 'karaoke';
        void this.playSong(toPlayableSong(item));
        this.showNotification(`▶ Offline: ${item.title} - ${item.artist}`);
      }
      return;
    }

    if (ch === 'd' || name === 'd' || name === 'delete' || name === 'backspace') {
      const item = songs[this.downloadsSelectedIndex];
      if (item) {
        this.downloadsConfirm = { mode: 'one', id: item.id, title: item.title };
      }
      return;
    }

    if (ch === 'c' || ch === 'C' || name === 'c') {
      if (songs.length === 0) {
        this.showNotification('No downloaded songs to clear', 1500);
        return;
      }
      this.downloadsConfirm = { mode: 'all' };
      return;
    }

    if (ch === 'a' || ch === 'A' || name === 'a') {
      const next = !getConfig().autoDownload;
      saveConfig({ autoDownload: next });
      this.showNotification(`Auto-download: ${next ? 'ON' : 'OFF'}`, 1500);
      return;
    }

    if (ch === '+' || ch === '=' || name === 'equal') {
      const cur = getConfig().maxStorageBytes;
      const next = Math.min(50 * 1024 ** 3, cur + 512 * 1024 ** 2);
      saveConfig({ maxStorageBytes: next });
      this.showNotification(`Download limit: ${formatStorageLimit(next)}`, 1500);
      return;
    }
    if (ch === '-' || name === 'minus') {
      const cur = getConfig().maxStorageBytes;
      const next = Math.max(512 * 1024 ** 2, cur - 512 * 1024 ** 2);
      saveConfig({ maxStorageBytes: next });
      this.showNotification(`Download limit: ${formatStorageLimit(next)}`, 1500);
      return;
    }
  }


  private async fetchArtForSong(song: Song): Promise<void> {
    if (!song) return;
    let url = song.thumbnailUrl;
    if (!url && song.title && song.artist) {
      try {
        const query = `${song.title} ${song.artist}`.trim();
        const results = await searchYtMusic(query, 'song');
        if (results.length > 0 && results[0].thumbnailUrl) {
          url = results[0].thumbnailUrl;
          song.thumbnailUrl = url;
        }
      } catch {
        // Fallback search failure non-fatal
      }
    }
    if (!url) return;

    try {
      const { lines, dominantColor } = await getAlbumArtAnsi(url, 26, 13);
      song.art = lines;
      song.coverColor = dominantColor;
    } catch {
      // Album art fetch failure non-fatal
    }
  }

  private async loadInitialSuggestions(): Promise<void> {
    try {
      const suggestions = await getTrendingSuggestions();
      this.suggestedSongs = suggestions;
      if (this.viewMode === 'search' && !this.searchQuery.trim() && this.searchResults.length === 0) {
        this.searchResults = suggestions;
      }
    } catch {
      // Fallback
    }
  }

  // --- Modal Opening & Handlers ---

  private openSearchModal(): void {
    this.viewMode = 'search';
    this.searchQuery = '';
    this.searchResults = this.suggestedSongs;
    this.searchSelectedIndex = 0;
    this.searchError = null;
    if (this.suggestedSongs.length === 0) {
      this.loadInitialSuggestions();
    }
  }

  private handleSearchInput(key: readline.Key, str: string = ''): void {
    const name = (key.name || '').toLowerCase();
    let ch = str || key.sequence || '';
    if (!ch && name.length === 1 && !key.ctrl && !key.meta) {
      ch = key.shift ? name.toUpperCase() : name;
    }

    if (name === 'escape' || ch === '\x1b') {
      this.viewMode = 'karaoke';
      return;
    }

    if (name === 'tab') {
      const types: Array<'all' | 'song' | 'album' | 'playlist' | 'video'> = ['all', 'song', 'album', 'playlist', 'video'];
      const curIdx = types.indexOf(this.searchType);
      this.searchType = types[(curIdx + 1) % types.length];
      this.triggerSearch();
      return;
    }

    const totalResults = this.searchResults.length;

    if (name === 'up') {
      this.searchSelectedIndex = Math.max(0, this.searchSelectedIndex - 1);
      return;
    }

    if (name === 'down') {
      this.searchSelectedIndex = Math.min(Math.max(0, totalResults - 1), this.searchSelectedIndex + 1);
      return;
    }

    if (name === 'return' || name === 'enter' || ch === '\r' || ch === '\n') {
      const item = this.searchResults[this.searchSelectedIndex];
      if (item) {
        this.loadSearchResult(item);
      }
      return;
    }

    if (name === 'backspace' || ch === '\x08' || ch === '\x7f') {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.debounceSearch();
      return;
    }

    if (key.ctrl && name === 'u') {
      this.searchQuery = '';
      this.debounceSearch();
      return;
    }

    const reserved = ['up', 'down', 'left', 'right', 'return', 'enter', 'escape', 'tab', 'backspace', 'delete'];
    if (key.ctrl || key.meta || reserved.includes(name)) {
      return;
    }

    const printable = [...ch].filter((c) => c >= ' ').join('');
    if (printable.length > 0) {
      this.searchQuery += printable;
      this.searchSelectedIndex = 0;
      this.debounceSearch();
    }
  }

  private debounceSearch(): void {
    clearTimeout(this.searchDebounceTimer!);
    const q = this.searchQuery.trim();
    if (!q) {
      this.searchResults = this.suggestedSongs;
      this.isSearching = false;
      this.searchSelectedIndex = 0;
      return;
    }

    const qLower = q.toLowerCase();
    const localHits = this.suggestedSongs.filter(
      (s) => s.title.toLowerCase().includes(qLower) || s.artist.toLowerCase().includes(qLower)
    );
    if (localHits.length > 0) {
      this.searchResults = localHits;
    }
    this.isSearching = true;
    this.searchDebounceTimer = setTimeout(() => {
      this.triggerSearch();
    }, 160);
  }

  private async triggerSearch(): Promise<void> {
    const q = this.searchQuery.trim();
    if (!q) return;

    this.isSearching = true;
    this.searchError = null;

    try {
      const results = await (this.searchType === 'all' ? searchLyrics(q) : searchYtMusic(q, this.searchType));
      this.searchResults = results;
      this.searchSelectedIndex = 0;
    } catch (err: unknown) {
      this.searchError = err instanceof Error ? err.message : 'Search failed';
    } finally {
      this.isSearching = false;
    }
  }

  private async loadSearchResult(item: SearchResult): Promise<void> {
    this.viewMode = 'karaoke';
    this.showNotification(`⟳ Loading ${item.title}...`);

    try {
      const song = await fetchSongDetails(item);
      if (song) {
        await this.playSong(song);
        this.showNotification(`▶ Playing: ${song.title} - ${song.artist}`);
      } else {
        this.showNotification(`✕ Could not load details for ${item.title}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load song';
      this.showNotification(`✕ Error: ${msg}`);
    }
  }

  private async openPlaylistsModal(): Promise<void> {
    this.viewMode = 'playlists';
    this.selectedPlaylistIndex = 0;
    this.currentPlaylistTracks = null;
    this.selectedPlaylistTrackIndex = 0;

    if (this.playlists.length === 0 && !this.isLoadingPlaylists) {
      this.isLoadingPlaylists = true;
      try {
        const [userPl, likedPl] = await Promise.allSettled([getUserPlaylists(), getLikedSongs()]);
        const list: YtPlaylist[] = [];
        if (likedPl.status === 'fulfilled' && likedPl.value.tracks && likedPl.value.tracks.length > 0) {
          list.push(likedPl.value);
        }
        if (userPl.status === 'fulfilled') {
          for (const p of userPl.value) {
            list.push(p);
          }
        }
        this.playlists = list;
      } catch {
        // Fallback
      } finally {
        this.isLoadingPlaylists = false;
      }
    }
  }

  private handlePlaylistInput(key: readline.Key): void {
    if (key.name === 'escape') {
      if (this.currentPlaylistTracks) {
        this.currentPlaylistTracks = null;
      } else {
        this.viewMode = 'karaoke';
      }
      return;
    }

    if (this.currentPlaylistTracks) {
      // Inside playlist track list
      if (key.name === 'left') {
        this.currentPlaylistTracks = null;
        return;
      }
      if (key.name === 'up') {
        this.selectedPlaylistTrackIndex = Math.max(0, this.selectedPlaylistTrackIndex - 1);
        return;
      }
      if (key.name === 'down') {
        this.selectedPlaylistTrackIndex = Math.min(this.currentPlaylistTracks.length - 1, this.selectedPlaylistTrackIndex + 1);
        return;
      }
      if (key.name === 'return') {
        const track = this.currentPlaylistTracks[this.selectedPlaylistTrackIndex];
        if (track) {
          this.viewMode = 'karaoke';
          this.loadSearchResult({
            id: track.id,
            title: track.title,
            artist: track.artist,
            duration: Math.floor(track.durationMs / 1000),
            hasSynced: false,
            source: 'youtube',
            thumbnailUrl: track.thumbnailUrl,
          });
        }
        return;
      }
      return;
    }

    // In playlist collection list
    if (key.name === 'up') {
      this.selectedPlaylistIndex = Math.max(0, this.selectedPlaylistIndex - 1);
      return;
    }
    if (key.name === 'down') {
      this.selectedPlaylistIndex = Math.min(this.playlists.length - 1, this.selectedPlaylistIndex + 1);
      return;
    }
    if (key.name === 'return' || key.name === 'right') {
      const pl = this.playlists[this.selectedPlaylistIndex];
      if (pl) {
        this.showNotification(`⟳ Loading playlist ${pl.title}...`);
        getYtPlaylist(pl.id).then((fullPl) => {
          this.currentPlaylistTracks = fullPl.tracks || [];
          this.selectedPlaylistTrackIndex = 0;
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.showNotification(`✕ Error: ${msg}`);
        });
      }
      return;
    }
  }

  private openQueueModal(): void {
    this.viewMode = 'queue';
  }

  private handleQueueInput(key: readline.Key, str: string = ''): void {
    const ch = str || key.sequence || '';
    const name = (key.name || '').toLowerCase();

    if (name === 'escape' || ch === 'q' || name === 'q') {
      this.viewMode = 'karaoke';
      return;
    }

    if (ch === 'x' || ch === 'X' || name === 'x') {
      this.toggleShuffle();
      return;
    }

    if (key.name === 'up') {
      this.currentQueueIndex = Math.max(0, this.currentQueueIndex - 1);
      return;
    }
    if (key.name === 'down') {
      this.currentQueueIndex = Math.min(this.queue.length - 1, this.currentQueueIndex + 1);
      return;
    }
    if (key.name === 'return') {
      const target = this.queue[this.currentQueueIndex];
      if (target) {
        this.viewMode = 'karaoke';
        this.playSong(target);
      }
      return;
    }
    if (key.name === 'd' || key.name === 'delete') {
      if (this.queue.length > 1) {
        this.queue.splice(this.currentQueueIndex, 1);
        this.currentQueueIndex = Math.min(this.queue.length - 1, this.currentQueueIndex);
        this.showNotification('Track removed from queue');
      }
      return;
    }
  }

  private async openExploreModal(): Promise<void> {
    this.viewMode = 'explore';
    if (this.exploreCategories.length === 0 && !this.isLoadingExplore) {
      this.isLoadingExplore = true;
      try {
        const feed = await getExploreFeed();
        this.exploreCategories = feed;
      } catch {
        // Fallback
      } finally {
        this.isLoadingExplore = false;
      }
    }
  }

  private handleExploreInput(key: readline.Key): void {
    if (key.name === 'escape') {
      this.viewMode = 'karaoke';
      return;
    }

    if (key.name === 'tab') {
      if (this.exploreCategories.length > 0) {
        this.selectedExploreCategoryIndex = (this.selectedExploreCategoryIndex + 1) % this.exploreCategories.length;
        this.selectedExploreItemIndex = 0;
      }
      return;
    }

    const cat = this.exploreCategories[this.selectedExploreCategoryIndex];
    const items = cat?.items || [];

    if (key.name === 'up') {
      this.selectedExploreItemIndex = Math.max(0, this.selectedExploreItemIndex - 1);
      return;
    }
    if (key.name === 'down') {
      this.selectedExploreItemIndex = Math.min(items.length - 1, this.selectedExploreItemIndex + 1);
      return;
    }
    if (key.name === 'return') {
      const item = items[this.selectedExploreItemIndex];
      if (item) {
        this.viewMode = 'karaoke';
        this.loadSearchResult({
          id: item.id,
          title: item.title,
          artist: item.subtitle || 'YouTube Music',
          duration: 180,
          hasSynced: false,
          source: 'youtube',
          thumbnailUrl: item.thumbnailUrl,
        });
      }
    }
  }


  private handleReadingInput(key: readline.Key): void {
    const song = this.player.getCurrentSong();
    const maxScroll = song ? Math.max(0, song.lyrics.length - 5) : 0;

    switch (key.name) {
      case 'escape':
      case 'r':
      case 'm':
        this.viewMode = 'karaoke';
        break;

      case 'up':
        this.readingScrollOffset = Math.max(0, this.readingScrollOffset - 1);
        break;

      case 'down':
        this.readingScrollOffset = Math.min(maxScroll, this.readingScrollOffset + 1);
        break;

      case 'pageup':
        this.readingScrollOffset = Math.max(0, this.readingScrollOffset - 10);
        break;

      case 'pagedown':
        this.readingScrollOffset = Math.min(maxScroll, this.readingScrollOffset + 10);
        break;

      case 'space':
        this.player.togglePlay();
        break;
    }
  }

  // --- Rendering Pipeline ---

  private render(): void {
    const dims = this.screen.getDimensions();
    const width = dims.width;
    const height = dims.height;

    const theme = this.themeManager.getTheme();
    const song = this.player.getCurrentSong();
    const state = this.player.getState();

    // 1. Render Header (4 lines)
    const headerLines = renderHeader({
      width,
      song,
      state,
      theme,
      viewMode: this.viewMode,
      downloadedCount: getDownloadedCount(),
    });

    // 2. Render Control Bar (5 lines)
    const controlBarLines = renderControlBar({
      width,
      state,
      theme,
      visualizerType: this.visualizer.getType(),
      viewMode: this.viewMode,
      showTimestamps: this.showTimestamps,
      shuffle: this.shuffleEnabled,
    });

    const headerHeight = headerLines.length;
    const controlHeight = controlBarLines.length;
    const viewportHeight = Math.max(2, height - headerHeight - controlHeight);

    let middleLines: string[] = [];
    const viewportDims = { width, height: viewportHeight };

    if (this.viewMode === 'karaoke') {
      const showArt = this.showAlbumArt && width >= 70;
      const artWidth = showArt ? Math.min(30, Math.floor(width * 0.32)) : 0;
      const lyricsWidth = width - artWidth;
      const vizHeight = Math.min(6, Math.max(3, Math.floor(viewportHeight * 0.3)));
      const lyricsHeight = Math.max(2, viewportHeight - vizHeight);

      const artLines = showArt
        ? renderAlbumArt({
            width: artWidth,
            height: viewportHeight,
            song,
            theme,
          })
        : [];

      const lyricsLines = renderLyricsViewport({
        width: lyricsWidth,
        height: lyricsHeight,
        song,
        state,
        theme,
        showTimestamps: this.showTimestamps,
      });

      const vizLines = this.visualizer.render({
        width: lyricsWidth,
        height: vizHeight,
        timeMs: state.currentTimeMs,
        isPlaying: state.status === 'playing',
        theme,
        bpm: song?.bpm || 120,
        spectrum: state.spectrum,
      });

      const rightColLines: string[] = [...lyricsLines, ...vizLines];
      while (rightColLines.length < viewportHeight) {
        rightColLines.push(' '.repeat(lyricsWidth));
      }

      for (let y = 0; y < viewportHeight; y++) {
        if (showArt) {
          const leftPart = artLines[y] || ' '.repeat(artWidth);
          const rightPart = rightColLines[y] || ' '.repeat(lyricsWidth);
          const rightPadded = pad(rightPart, lyricsWidth, 'left');
          middleLines.push(`${leftPart}${rightPadded}`);
        } else {
          const rightPart = rightColLines[y] || ' '.repeat(width);
          middleLines.push(pad(rightPart, width, 'left'));
        }
      }
    } else if (this.viewMode === 'reading') {
      middleLines = renderReadingView(song, state.activeLineIndex, this.readingScrollOffset, theme, viewportDims);
    } else if (this.viewMode === 'search') {
      middleLines = renderSearchModal(
        this.searchQuery,
        this.searchResults,
        this.searchSelectedIndex,
        this.isSearching,
        this.searchError,
        theme,
        viewportDims,
        this.searchType
      );
    } else if (this.viewMode === 'playlists') {
      middleLines = this.fitModalInViewport(
        renderPlaylistModal(
          this.playlists,
          this.selectedPlaylistIndex,
          this.currentPlaylistTracks,
          this.selectedPlaylistTrackIndex,
          theme,
          viewportDims
        ),
        width,
        viewportHeight
      );
    } else if (this.viewMode === 'queue') {
      middleLines = this.fitModalInViewport(
        renderQueueModal(this.queue, this.currentQueueIndex, this.currentQueueIndex, theme, viewportDims),
        width,
        viewportHeight
      );
    } else if (this.viewMode === 'explore') {
      middleLines = this.fitModalInViewport(
        renderExploreModal(
          this.exploreCategories,
          this.selectedExploreCategoryIndex,
          this.selectedExploreItemIndex,
          theme,
          viewportDims
        ),
        width,
        viewportHeight
      );
    } else if (this.viewMode === 'auth') {
      middleLines = this.fitModalInViewport(
        renderAuthModal(this.authCreds, this.notificationMessage, theme, viewportDims),
        width,
        viewportHeight
      );
    } else if (this.viewMode === 'help') {
      middleLines = this.fitModalInViewport(renderHelpModal(theme, viewportDims), width, viewportHeight);
    } else if (this.viewMode === 'downloads') {
      const cfg = getConfig();
      middleLines = this.fitModalInViewport(
        renderDownloadsModal(getDownloadedSongs(), this.downloadsSelectedIndex, theme, viewportDims, {
          autoDownload: cfg.autoDownload,
          maxStorageBytes: cfg.maxStorageBytes,
          usedBytes: getTotalDownloadedBytes(),
          confirm: this.downloadsConfirm,
        }),
        width,
        viewportHeight
      );
    }

    while (middleLines.length < viewportHeight) {
      middleLines.push(' '.repeat(Math.max(0, width)));
    }
    if (middleLines.length > viewportHeight) {
      middleLines = middleLines.slice(0, viewportHeight);
    }

    const allLines: string[] = [...headerLines, ...middleLines, ...controlBarLines].map((line) => {
      const vLen = getVisualWidth(line);
      if (vLen < width) {
        return line + ANSI.RESET + ' '.repeat(width - vLen);
      } else if (vLen > width) {
        return truncate(line, width);
      }
      return line;
    });
    while (allLines.length < height) {
      allLines.push(' '.repeat(Math.max(0, width)));
    }
    if (allLines.length > height) {
      allLines.length = height;
    }

    if (this.notificationMessage && allLines.length > 0) {
      const toast = ` ℹ ${this.notificationMessage} `;
      const styledToast = `${ANSI.BOLD}${fg([255, 255, 255])}${colorText(toast, theme.primary, true)}${ANSI.RESET}`;
      const lineIdx = Math.min(allLines.length - 2, headerHeight);
      if (lineIdx >= 0 && lineIdx < allLines.length) {
        const rawToast = `  ${styledToast}`;
        allLines[lineIdx] = pad(truncate(rawToast, width), width, 'left');
      }
    }
    this.screen.render(allLines.join('\n'));
  }

  private fitModalInViewport(modalLines: string[], width: number, viewportHeight: number): string[] {
    const fitted: string[] = [];
    const modalH = Math.min(modalLines.length, viewportHeight);
    const startY = Math.max(0, Math.floor((viewportHeight - modalH) / 2));

    for (let i = 0; i < viewportHeight; i++) {
      if (i >= startY && i < startY + modalH) {
        const line = modalLines[i - startY];
        const w = getVisualWidth(line);
        if (w >= width) {
          fitted.push(w > width ? truncate(line, width) : line);
        } else {
          const left = Math.floor((width - w) / 2);
          fitted.push(`${' '.repeat(left)}${line}${' '.repeat(width - left - w)}`);
        }
      } else {
        fitted.push(' '.repeat(width));
      }
    }
    return fitted;
  }
}
