import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { ChildProcess, spawn } from 'child_process';
import { findExecutable } from '../services/auth.js';
import { resolveAudioStreamUrl } from '../services/ytmusic.js';
export interface AudioBackendEvents {
  status: (state: { status: 'playing' | 'paused' | 'stopped' | 'ended'; currentMs: number; volume: number; spectrum?: number[] }) => void;
  ended: () => void;
  error: (err: Error) => void;
}

export interface IAudioBackend {
  play(url: string, startMs?: number): Promise<void>;
  pause(): void;
  resume(): void;
  seek(targetMs: number): void;
  setVolume(vol: number): void;
  stop(): void;
  destroy(): void;
  getName(): string;
}

/**
 * Native PulseAudio Backend (using compiled Go audio engine)
 */
export class NativeAudioBackend extends EventEmitter implements IAudioBackend {
  private proc: ChildProcess | null = null;
  private isReady: boolean = false;
  public currentMs: number = 0;
  public status: 'playing' | 'paused' | 'stopped' | 'ended' = 'stopped';
  public currentVolume: number = 100;
  private binaryPath: string;

  constructor(binaryPath?: string) {
    super();
    this.binaryPath = binaryPath || this.findAudioBinary();
    this.initProcess();
  }

  private findAudioBinary(): string {
    const currentFile = fileURLToPath(import.meta.url);
    const rootDir = path.resolve(path.dirname(currentFile), '../..');
    const localBin = path.join(rootDir, 'bin', 'lyrical-audio');
    if (fs.existsSync(localBin)) {
      return localBin;
    }
    const srcRootDir = path.resolve(path.dirname(currentFile), '../../..');
    const srcLocalBin = path.join(srcRootDir, 'bin', 'lyrical-audio');
    if (fs.existsSync(srcLocalBin)) {
      return srcLocalBin;
    }
    const homeBin = path.join(os.homedir(), '.local', 'bin', 'lyrical-audio');
    if (fs.existsSync(homeBin)) {
      return homeBin;
    }
    return findExecutable('lyrical-audio') || localBin;
  }
  private initProcess(): void {
    try {
      this.proc = spawn(this.binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (this.proc.stdout) {
        const rl = readline.createInterface({ input: this.proc.stdout });
        rl.on('line', (line) => {
          this.handleStdoutLine(line.trim());
        });
      }

      this.proc.on('error', (err) => {
        this.emit('error', err);
      });

      this.proc.on('exit', () => {
        this.isReady = false;
      });
    } catch (err: any) {
      this.emit('error', err);
    }
  }

  private handleStdoutLine(line: string): void {
    if (!line) return;

    if (line === 'READY') {
      this.isReady = true;
    } else if (line === 'PLAYING') {
      this.status = 'playing';
    } else if (line === 'PAUSED') {
      this.status = 'paused';
    } else if (line === 'RESUMED') {
      this.status = 'playing';
    } else if (line === 'STOPPED') {
      this.status = 'stopped';
    } else if (line === 'ENDED') {
      this.status = 'ended';
      this.emit('ended');
    } else if (line.startsWith('STATUS ')) {
      // Format: STATUS <status> <currentMs> <volume> <b0,b1,...>
      const parts = line.split(' ');
      if (parts.length >= 5) {
        const st = parts[1] as 'playing' | 'paused' | 'stopped' | 'ended';
        const ms = parseInt(parts[2], 10) || 0;
        const vol = parseInt(parts[3], 10) || 100;
        const rawBands = parts[4].split(',').map((b) => parseFloat(b) || 0);

        this.status = st;
        this.currentMs = ms;
        this.currentVolume = vol;

        this.emit('status', {
          status: st,
          currentMs: ms,
          volume: vol,
          spectrum: rawBands,
        });
      }
    }
  }

  public async play(url: string, startMs: number = 0): Promise<void> {
    if (!this.proc || this.proc.killed) {
      this.initProcess();
    }
    this.sendCmd(`PLAY ${url} ${Math.floor(startMs)}`);
    this.status = 'playing';
    this.currentMs = startMs;
  }

  public pause(): void {
    this.sendCmd('PAUSE');
    this.status = 'paused';
  }

  public resume(): void {
    this.sendCmd('RESUME');
    this.status = 'playing';
  }

  public seek(targetMs: number): void {
    this.sendCmd(`SEEK ${Math.floor(targetMs)}`);
    this.currentMs = targetMs;
  }

  public setVolume(vol: number): void {
    this.currentVolume = vol;
    this.sendCmd(`VOLUME ${Math.floor(vol)}`);
  }

  public stop(): void {
    this.sendCmd('STOP');
    this.status = 'stopped';
  }

  public destroy(): void {
    try {
      this.sendCmd('QUIT');
      if (this.proc && !this.proc.killed) {
        this.proc.kill();
      }
    } catch {
      // Ignore cleanup error
    }
  }
  private sendCmd(cmd: string): void {
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(cmd + '\n');
    }
  }

  public getIsReady(): boolean {
    return this.isReady;
  }

  public getName(): string {
    return 'Native PulseAudio';
  }
}

/**
 * Simulated Timer Audio Backend (fallback when no audio output device exists)
 */
export class SimulatedAudioBackend extends EventEmitter implements IAudioBackend {
  private timer: NodeJS.Timeout | null = null;
  private currentMs: number = 0;
  private status: 'playing' | 'paused' | 'stopped' | 'ended' = 'stopped';
  private volume: number = 100;
  private lastTime: number = 0;

  public async play(_url: string, startMs: number = 0): Promise<void> {
    this.currentMs = startMs;
    this.status = 'playing';
    this.lastTime = Date.now();

    clearInterval(this.timer!);
    this.timer = setInterval(() => this.tick(), 40);
  }

  public pause(): void {
    this.status = 'paused';
    clearInterval(this.timer!);
    this.timer = null;
  }

  public resume(): void {
    if (this.status === 'paused') {
      this.status = 'playing';
      this.lastTime = Date.now();
      if (!this.timer) {
        this.timer = setInterval(() => this.tick(), 40);
      }
    }
  }

  public seek(targetMs: number): void {
    this.currentMs = Math.max(0, targetMs);
    this.lastTime = Date.now();
    if (this.status === 'playing' && !this.timer) {
      this.timer = setInterval(() => this.tick(), 40);
    }
  }

  public setVolume(vol: number): void {
    this.volume = vol;
  }

  public stop(): void {
    this.status = 'stopped';
    clearInterval(this.timer!);
    this.timer = null;
  }

  public destroy(): void {
    this.stop();
  }

  public getName(): string {
    return 'Simulated / Visualizer Only';
  }

  private tick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTime;
    this.lastTime = now;

    if (this.status === 'playing') {
      this.currentMs += elapsed;
      this.emit('status', {
        status: this.status,
        currentMs: this.currentMs,
        volume: this.volume,
      });
    }
  }
}

/**
 * FFplay Native Audio Backend (Linux / Fedora / PipeWire / PulseAudio / ALSA / macOS / Windows)
 */
export class FfplayAudioBackend extends EventEmitter implements IAudioBackend {
  private proc: ChildProcess | null = null;
  public currentMs: number = 0;
  public status: 'playing' | 'paused' | 'stopped' | 'ended' = 'stopped';
  public currentVolume: number = 100;
  private timer: NodeJS.Timeout | null = null;
  private lastTime: number = 0;
  private currentTarget: string = '';
  private currentStreamUrl: string = '';
  private isSeeking: boolean = false;
  private playSessionId: number = 0;

  constructor() {
    super();
  }

  public async play(urlOrId: string, startMs: number = 0): Promise<void> {
    this.stopInternal(false);
    this.currentTarget = urlOrId;
    this.currentMs = Math.max(0, startMs);
    this.status = 'playing';
    this.lastTime = Date.now();
    const sessionId = ++this.playSessionId;

    try {
      let resolvedUrl = urlOrId;
      if (urlOrId && (urlOrId.startsWith('http://') || urlOrId.startsWith('https://') || /^[a-zA-Z0-9_-]{11}$/.test(urlOrId.trim()))) {
        resolvedUrl = await resolveAudioStreamUrl(urlOrId);
      }
      if (sessionId !== this.playSessionId) {
        return;
      }
      this.currentStreamUrl = resolvedUrl;
      this.spawnPlayer(resolvedUrl, this.currentMs, sessionId);
      this.startClock();
    } catch (err: unknown) {
      if (sessionId === this.playSessionId) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        this.startClock();
      }
    }
  }

  private spawnPlayer(streamUrl: string, startMs: number, sessionId: number): void {
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {}
      this.proc = null;
    }

    const args = [
      '-nodisp',
      '-autoexit',
      '-loglevel', 'error',
      '-volume', String(Math.max(0, Math.min(100, this.currentVolume))),
    ];

    if (startMs > 0) {
      args.push('-ss', (startMs / 1000).toFixed(3));
    }

    args.push(streamUrl);

    try {
      const p = spawn('ffplay', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      this.proc = p;

      p.on('error', (err) => {
        if (sessionId === this.playSessionId && !this.isSeeking) {
          this.emit('error', err);
        }
      });

      p.on('close', (code) => {
        if (sessionId === this.playSessionId && !this.isSeeking && this.status === 'playing') {
          if (code === 0) {
            this.status = 'ended';
            this.stopClock();
            this.emit('ended');
          }
        }
      });
    } catch (err: unknown) {
      if (sessionId === this.playSessionId) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  public pause(): void {
    if (this.status === 'playing') {
      this.status = 'paused';
      this.stopClock();
      if (this.proc && this.proc.pid) {
        try {
          process.kill(this.proc.pid, 'SIGSTOP');
        } catch {}
      }
    }
  }

  public resume(): void {
    if (this.status === 'paused') {
      this.status = 'playing';
      this.lastTime = Date.now();
      if (this.proc && this.proc.pid) {
        try {
          process.kill(this.proc.pid, 'SIGCONT');
        } catch {
          if (this.currentStreamUrl) {
            this.spawnPlayer(this.currentStreamUrl, this.currentMs, ++this.playSessionId);
          }
        }
      } else if (this.currentStreamUrl) {
        this.spawnPlayer(this.currentStreamUrl, this.currentMs, ++this.playSessionId);
      }
      this.startClock();
    }
  }

  public seek(targetMs: number): void {
    this.currentMs = Math.max(0, targetMs);
    this.lastTime = Date.now();

    if (this.status === 'playing') {
      this.isSeeking = true;
      const sessionId = ++this.playSessionId;
      if (this.currentStreamUrl) {
        this.spawnPlayer(this.currentStreamUrl, this.currentMs, sessionId);
      }
      this.isSeeking = false;
      this.startClock();
    }
  }

  public setVolume(vol: number): void {
    this.currentVolume = Math.max(0, Math.min(100, vol));
  }

  public stop(): void {
    this.stopInternal(true);
  }

  private stopInternal(resetPos: boolean): void {
    this.playSessionId++;
    this.status = 'stopped';
    this.stopClock();
    if (resetPos) {
      this.currentMs = 0;
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {}
      this.proc = null;
    }
  }

  public destroy(): void {
    this.stop();
    this.removeAllListeners();
  }

  public getName(): string {
    return 'FFplay Native Audio Engine';
  }

  private startClock(): void {
    if (this.timer) return;
    this.lastTime = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastTime;
      this.lastTime = now;
      if (this.status === 'playing') {
        this.currentMs += elapsed;
        this.emit('status', {
          status: this.status,
          currentMs: this.currentMs,
          volume: this.currentVolume,
        });
      }
    }, 40);
  }

  private stopClock(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Factory to create the best available audio backend
 */
export function createAudioBackend(): IAudioBackend {
  const binaryPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../bin/lyrical-audio');
  if (fs.existsSync(binaryPath) || findExecutable('lyrical-audio')) {
    try {
      const native = new NativeAudioBackend(fs.existsSync(binaryPath) ? binaryPath : undefined);
      return native;
    } catch {
      // Fallback
    }
  }

  if (findExecutable('ffplay') || fs.existsSync('/usr/bin/ffplay')) {
    return new FfplayAudioBackend();
  }

  return new SimulatedAudioBackend();
}
