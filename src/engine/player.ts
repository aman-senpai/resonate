import { EventEmitter } from 'events';
import { LyricLine, PlayerState, Song } from '../types.js';
import { createAudioBackend, IAudioBackend } from './audioBackend.js';
import { isStreamRef } from '../services/ytmusic.js';
export interface PlayerEvents {
  tick: (state: PlayerState) => void;
  lineChange: (index: number, line: LyricLine | null) => void;
  stateChange: (state: PlayerState) => void;
  ended: () => void;
  error: (err: Error) => void;
}

export class LyricPlayer extends EventEmitter {
  private song: Song | null = null;
  private status: PlayerState['status'] = 'stopped';
  private currentTimeMs: number = 0;
  private durationMs: number = 0;
  private speed: number = 1.0;
  private offsetMs: number = 0;
  private loop: boolean = false;
  private volume: number = 100;
  private isBuffering: boolean = false;

  private activeLineIndex: number = -1;
  private activeWordIndex: number = -1;

  private backend: IAudioBackend;
  private spectrumBands: number[] = new Array(16).fill(0);
  private timerHandle: NodeJS.Timeout | null = null;
  private lastHighResTimestamp: number = 0;
  private lastBackendSyncAt: number = 0;
  private seekHold: boolean = false;
  private targetFps: number = 30;
  constructor(song?: Song, customBackend?: IAudioBackend) {
    super();
    this.backend = customBackend || createAudioBackend();
    this.setupBackendEvents();

    if (song) {
      this.loadSong(song);
    }
  }

  private setupBackendEvents(): void {
    if (this.backend instanceof EventEmitter) {
      this.backend.on('status', (state: { status: 'playing' | 'paused' | 'stopped' | 'ended'; currentMs: number; volume: number; spectrum?: number[] }) => {
        if (this.status === 'playing') {
          this.seekHold = false;
          this.currentTimeMs = state.currentMs;
          this.lastHighResTimestamp = performance.now();
          this.lastBackendSyncAt = this.lastHighResTimestamp;
          if (state.spectrum && state.spectrum.length > 0) {
            this.spectrumBands = state.spectrum;
          }
          this.updateActiveIndices();
          this.emit('tick', this.getState());
        }
      });

      this.backend.on('ended', () => {
        if (this.status === 'playing') {
          if (this.durationMs <= 0 || this.currentTimeMs >= Math.max(0, this.durationMs - 2500)) {
            this.onPlaybackEnded();
          }
        }
      });

      this.backend.on('error', (err) => {
        this.isBuffering = false;
        if (this.status === 'playing') {
          this.status = 'paused';
          clearInterval(this.timerHandle!);
          this.timerHandle = null;
        }
        this.emit('error', err);
      });
    }
  }

  public async loadSong(song: Song, autoPlay: boolean = false): Promise<void> {
    this.stop();
    this.song = song;
    this.durationMs = song.durationMs;
    this.currentTimeMs = 0;
    this.activeLineIndex = -1;
    this.activeWordIndex = -1;

    this.updateActiveIndices();
    this.emitStateChange();

    if (autoPlay) {
      await this.play();
    }
  }

  public getCurrentSong(): Song | null {
    return this.song;
  }

  public async play(): Promise<void> {
    if (!this.song) return;
    if (this.status === 'playing') return;

    if (this.status === 'paused') {
      this.status = 'playing';
      this.lastHighResTimestamp = performance.now();
      this.lastBackendSyncAt = this.lastHighResTimestamp;
      this.backend.resume();
      if (!this.timerHandle) {
        const intervalMs = Math.floor(1000 / this.targetFps);
        this.timerHandle = setInterval(() => this.onTick(), intervalMs);
      }
      this.emitStateChange();
      return;
    }

    if (this.status === 'ended') {
      this.currentTimeMs = 0;
    }

    const playTarget = this.playableTarget();
    this.status = 'playing';
    this.lastHighResTimestamp = performance.now();
    this.lastBackendSyncAt = this.lastHighResTimestamp;

    try {
      await this.backend.play(playTarget, this.currentTimeMs);
    } catch (err: unknown) {
      this.status = 'paused';
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.emitStateChange();
      return;
    }

    this.lastHighResTimestamp = performance.now();
    this.lastBackendSyncAt = this.lastHighResTimestamp;
    clearInterval(this.timerHandle!);
    const intervalMs = Math.floor(1000 / this.targetFps);
    this.timerHandle = setInterval(() => this.onTick(), intervalMs);
    this.emitStateChange();
  }
  public pause(): void {
    if (this.status !== 'playing') return;

    this.status = 'paused';
    this.seekHold = false;
    this.backend.pause();

    clearInterval(this.timerHandle!);
    this.timerHandle = null;

    this.emitStateChange();
  }

  public async togglePlay(): Promise<void> {
    if (this.status === 'playing') {
      this.pause();
    } else {
      await this.play();
    }
  }
  public stop(): void {
    this.status = 'stopped';
    this.seekHold = false;
    this.backend.stop();

    clearInterval(this.timerHandle!);
    this.timerHandle = null;

    this.currentTimeMs = 0;
    this.activeLineIndex = -1;
    this.activeWordIndex = -1;
    this.spectrumBands = new Array(16).fill(0);

    this.emitStateChange();
  }

  public async restart(): Promise<void> {
    this.seek(0);
    await this.play();
  }

  public seek(targetMs: number): void {
    const maxDuration = this.durationMs > 0 ? this.durationMs : 3600000;
    this.currentTimeMs = Math.max(0, Math.min(targetMs, maxDuration));
    this.lastHighResTimestamp = performance.now();
    this.lastBackendSyncAt = this.lastHighResTimestamp;
    this.seekHold = this.status === 'playing';
    this.backend.seek(this.currentTimeMs);
    this.updateActiveIndices();
    if (this.status === 'playing' && !this.timerHandle) {
      const intervalMs = Math.floor(1000 / this.targetFps);
      this.timerHandle = setInterval(() => this.onTick(), intervalMs);
    }
    this.emit('tick', this.getState());
    this.emitStateChange();
  }

  private playableTarget(): string {
    if (!this.song) return '';
    if (this.song.audioUrl && isStreamRef(this.song.audioUrl)) return this.song.audioUrl;
    if (isStreamRef(this.song.id)) return this.song.id;
    return '';
  }

  public seekDelta(deltaMs: number): void {
    this.seek(this.currentTimeMs + deltaMs);
  }

  public seekToLine(index: number): void {
    if (!this.song || index < 0 || index >= this.song.lyrics.length) return;
    const targetLine = this.song.lyrics[index];
    this.seek(targetLine.startMs);
  }

  public nextLine(): void {
    if (!this.song) return;
    const nextIdx = this.activeLineIndex + 1;
    if (nextIdx < this.song.lyrics.length) {
      this.seekToLine(nextIdx);
    }
  }

  public prevLine(): void {
    if (!this.song) return;
    const prevIdx = Math.max(0, this.activeLineIndex - 1);
    this.seekToLine(prevIdx);
  }

  public setSpeed(speed: number): void {
    this.speed = Math.max(0.25, Math.min(3.0, speed));
    this.lastHighResTimestamp = performance.now();
    this.emitStateChange();
  }

  public adjustSpeed(delta: number): void {
    const newSpeed = Math.round((this.speed + delta) * 100) / 100;
    this.setSpeed(newSpeed);
  }

  public adjustOffset(deltaMs: number): void {
    this.offsetMs += deltaMs;
    this.updateActiveIndices();
    this.emitStateChange();
  }

  public resetOffset(): void {
    this.offsetMs = 0;
    this.updateActiveIndices();
    this.emitStateChange();
  }

  public toggleLoop(): void {
    this.loop = !this.loop;
    this.emitStateChange();
  }

  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(150, volume));
    this.backend.setVolume(this.volume);
    this.emitStateChange();
  }

  public adjustVolume(delta: number): void {
    this.setVolume(this.volume + delta);
  }

  public getSpectrum(): number[] {
    return this.spectrumBands;
  }

  public getState(): PlayerState {
    const effectiveTime = Math.max(0, this.currentTimeMs + this.offsetMs);
    let lineProgressRatio = 0;

    if (this.song && this.activeLineIndex >= 0 && this.activeLineIndex < this.song.lyrics.length) {
      const line = this.song.lyrics[this.activeLineIndex];
      const lineSpan = line.endMs - line.startMs;
      if (lineSpan > 0) {
        lineProgressRatio = Math.max(0, Math.min(1, (effectiveTime - line.startMs) / lineSpan));
      }
    }

    const progressRatio = this.durationMs > 0 ? Math.max(0, Math.min(1, this.currentTimeMs / this.durationMs)) : 0;

    return {
      status: this.status,
      currentTimeMs: this.currentTimeMs,
      durationMs: this.durationMs,
      activeLineIndex: this.activeLineIndex,
      activeWordIndex: this.activeWordIndex,
      speed: this.speed,
      offsetMs: this.offsetMs,
      loop: this.loop,
      volume: this.volume,
      progressRatio,
      lineProgressRatio,
      backend: this.backend.getName(),
      spectrum: this.spectrumBands,
      isBuffering: this.isBuffering,
    };
  }

  private onTick(): void {
    const now = performance.now();
    const elapsed = (now - this.lastHighResTimestamp) * this.speed;
    this.lastHighResTimestamp = now;

    if (this.seekHold) {
      if (now - this.lastBackendSyncAt > 3000) this.seekHold = false;
      else {
        this.updateActiveIndices();
        this.emit('tick', this.getState());
        return;
      }
    }

    if (now - this.lastBackendSyncAt > 250) {
      this.currentTimeMs += elapsed;
    }
    if (this.durationMs > 0 && this.currentTimeMs >= this.durationMs) {
      this.onPlaybackEnded();
      return;
    }

    const prevLine = this.activeLineIndex;
    this.updateActiveIndices();

    if (prevLine !== this.activeLineIndex) {
      const line = this.song && this.activeLineIndex >= 0 ? this.song.lyrics[this.activeLineIndex] : null;
      this.emit('lineChange', this.activeLineIndex, line);
    }

    this.emit('tick', this.getState());
  }

  private onPlaybackEnded(): void {
    if (this.loop) {
      this.currentTimeMs = 0;
      this.seek(0);
      this.updateActiveIndices();
    } else {
      this.currentTimeMs = this.durationMs;
      this.status = 'ended';
      clearInterval(this.timerHandle!);
      this.timerHandle = null;
      this.emit('ended');
      this.emitStateChange();
    }
  }

  private updateActiveIndices(): void {
    if (!this.song || this.song.lyrics.length === 0) {
      this.activeLineIndex = -1;
      this.activeWordIndex = -1;
      return;
    }

    const effectiveTime = Math.max(0, this.currentTimeMs + this.offsetMs);
    const lyrics = this.song.lyrics;

    // Find active line
    let foundIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
      const line = lyrics[i];
      if (effectiveTime >= line.startMs && effectiveTime <= line.endMs) {
        foundIndex = i;
        break;
      }
      if (effectiveTime < line.startMs) {
        foundIndex = Math.max(0, i - 1);
        break;
      }
    }

    if (foundIndex === -1 && effectiveTime >= lyrics[lyrics.length - 1].endMs) {
      foundIndex = lyrics.length - 1;
    }

    this.activeLineIndex = foundIndex;

    // Find active word in karaoke line
    if (foundIndex >= 0 && lyrics[foundIndex]?.words && lyrics[foundIndex].words!.length > 0) {
      const words = lyrics[foundIndex].words!;
      let wordIdx = -1;
      for (let w = 0; w < words.length; w++) {
        const word = words[w];
        if (effectiveTime >= word.startMs && effectiveTime <= word.endMs) {
          wordIdx = w;
          break;
        }
        if (effectiveTime > word.endMs) {
          wordIdx = w;
        }
      }
      this.activeWordIndex = wordIdx;
    } else {
      this.activeWordIndex = -1;
    }
  }

  private emitStateChange(): void {
    this.emit('stateChange', this.getState());
  }

  public destroy(): void {
    this.stop();
    this.backend.destroy();
  }
}
