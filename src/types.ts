export type RGB = [number, number, number];

export interface LyricWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface LyricLine {
  id: number;
  text: string;
  startMs: number;
  endMs: number;
  words?: LyricWord[];
  isInstrumental?: boolean;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  album?: string;
  year?: string | number;
  durationMs: number;
  lyrics: LyricLine[];
  plainLyrics?: string;
  art?: string[]; // Array of ASCII / ANSI art lines
  thumbnailUrl?: string;
  coverColor?: RGB;
  bpm?: number;
  audioUrl?: string;
  isLive?: boolean;
  source?: 'youtube' | 'online' | 'local';
}

export interface Theme {
  id: string;
  name: string;
  icon: string;
  description: string;
  primary: RGB;
  secondary: RGB;
  accent: RGB;
  highlight: RGB;
  activeLine: RGB;
  dimmed: RGB;
  subtle: RGB;
  text: RGB;
  background: RGB;
  visualizer: RGB[];
  border: RGB;
  badge: {
    bg: RGB;
    fg: RGB;
  };
  gradient: RGB[];
}

export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'ended';

export interface PlayerState {
  status: PlaybackStatus;
  currentTimeMs: number;
  durationMs: number;
  activeLineIndex: number;
  activeWordIndex: number;
  speed: number;
  offsetMs: number;
  loop: boolean;
  volume: number;
  muted: boolean;
  progressRatio: number;
  lineProgressRatio: number; // Progress within the active line [0.0 - 1.0]
  backend: string;
  spectrum?: number[]; // 16 frequency bands [0.0 - 1.0]
  isBuffering?: boolean;
}

export type VisualizerType = 'bars' | 'wave' | 'particles' | 'matrix' | 'flame' | 'pulse' | 'vinyl';

export type ViewMode = 'karaoke' | 'reading' | 'help' | 'search' | 'playlists' | 'queue' | 'explore' | 'auth';

export interface SearchResult {
  id: string | number;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  hasSynced: boolean;
  source: 'youtube' | 'online' | 'local';
  rawLrc?: string;
  thumbnailUrl?: string;
  type?: 'song' | 'video' | 'album' | 'playlist' | 'artist';
}

export interface AuthCredentials {
  cookie?: string;
  oauthToken?: {
    access_token: string;
    refresh_token: string;
    expiry_date?: string;
    client_id?: string;
    client_secret?: string;
  };
  visitorData?: string;
  poToken?: string;
  accountInfo?: {
    name?: string;
    email?: string;
    photoUrl?: string;
    hasPremium?: boolean;
  };
  lastChecked?: number;
}

export interface YtTrack {
  id: string;
  title: string;
  artist: string;
  artists?: Array<{ name: string; id?: string }>;
  album?: { name: string; id?: string };
  durationMs: number;
  durationText?: string;
  thumbnailUrl?: string;
  isExplicit?: boolean;
  views?: string;
}

export interface YtPlaylist {
  id: string;
  title: string;
  description?: string;
  itemCount?: number;
  author?: string;
  thumbnailUrl?: string;
  tracks?: YtTrack[];
}

export interface YtAlbum {
  id: string;
  title: string;
  artist: string;
  year?: string | number;
  thumbnailUrl?: string;
  tracks?: YtTrack[];
}

export interface YtExploreCategory {
  title: string;
  items: Array<{
    id: string;
    title: string;
    subtitle?: string;
    thumbnailUrl?: string;
    type: 'playlist' | 'album' | 'song' | 'artist';
  }>;
}

export interface QueueItem {
  song: Song;
  addedAt: number;
}

export interface TerminalDimensions {
  width: number;
  height: number;
}
