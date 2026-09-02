import { EventEmitter } from 'events';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { findExecutable } from '../services/auth.js';
import { extractVideoId, isStreamRef, resolveAudioStreamUrl } from '../services/ytmusic.js';
import { getCachedMediaPath } from '../services/mediaCache.js';

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

export type PlayerKind =
  | 'ffplay'
  | 'mpv'
  | 'ffmpeg-pulse'
  | 'ffmpeg-alsa'
  | 'ffmpeg-coreaudio'
  | 'ffmpeg-paplay'
  | 'ffmpeg-pwplay';

export interface PlayerSpec {
  kind: PlayerKind;
  bin: string;
  sinkBin?: string;
}

const muxerCache = new Map<string, string>();

export function ffmpegMuxerListing(bin: string): string {
  const cached = muxerCache.get(bin);
  if (cached != null) return cached;
  const r = spawnSync(bin, ['-hide_banner', '-muxers'], { encoding: 'utf8', timeout: 8000 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  muxerCache.set(bin, text);
  return text;
}

export function muxerEnabled(listing: string, name: string): boolean {
  return new RegExp(`(^|\\n)\\s*E\\s+${name}\\b`, 'm').test(listing);
}

export function pickPlayerKind(opts: {
  platform: string;
  ffplay: string | null;
  mpv: string | null;
  ffmpeg: string | null;
  paplay: string | null;
  pwplay: string | null;
  muxers: string;
}): PlayerSpec | null {
  if (opts.ffplay) return { kind: 'ffplay', bin: opts.ffplay };
  if (opts.mpv) return { kind: 'mpv', bin: opts.mpv };
  if (!opts.ffmpeg) return null;

  if (opts.platform === 'darwin') {
    if (muxerEnabled(opts.muxers, 'coreaudio')) {
      return { kind: 'ffmpeg-coreaudio', bin: opts.ffmpeg };
    }
    return null;
  }

  if (muxerEnabled(opts.muxers, 'pulse')) {
    return { kind: 'ffmpeg-pulse', bin: opts.ffmpeg };
  }
  if (opts.paplay) return { kind: 'ffmpeg-paplay', bin: opts.ffmpeg, sinkBin: opts.paplay };
  if (opts.pwplay) return { kind: 'ffmpeg-pwplay', bin: opts.ffmpeg, sinkBin: opts.pwplay };
  if (muxerEnabled(opts.muxers, 'alsa')) {
    return { kind: 'ffmpeg-alsa', bin: opts.ffmpeg };
  }
  return null;
}

function detectPlayer(): PlayerSpec | null {
  const ffmpeg = findExecutable('ffmpeg');
  return pickPlayerKind({
    platform: process.platform,
    ffplay: findExecutable('ffplay'),
    mpv: findExecutable('mpv'),
    ffmpeg,
    paplay: findExecutable('paplay'),
    pwplay: findExecutable('pw-play'),
    muxers: ffmpeg ? ffmpegMuxerListing(ffmpeg) : '',
  });
}

function volumeFilter(vol: number): string {
  const linear = Math.max(0, Math.min(1.5, vol / 100));
  return `volume=${linear.toFixed(3)}`;
}

const PLAYER_APP_NAMES: Record<string, true> = {
  ffplay: true,
  mpv: true,
  ffmpeg: true,
  resonate: true,
  paplay: true,
  'pw-play': true,
};


function pulseIndexes(raw: unknown, pid: number | null): string[] {
  if (!Array.isArray(raw)) return [];
  const pidStr = pid != null ? String(pid) : '';
  const found: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (!('index' in item) || !('properties' in item)) continue;
    const index = item.index;
    const properties = item.properties;
    if (typeof index !== 'number' && typeof index !== 'string') continue;
    if (!properties || typeof properties !== 'object') continue;
    let match = false;
    if (pidStr && 'application.process.id' in properties) {
      const procId = properties['application.process.id'];
      if (procId === pidStr || procId === pid) match = true;
    }
    if ('application.name' in properties && typeof properties['application.name'] === 'string') {
      if (PLAYER_APP_NAMES[properties['application.name']]) match = true;
    }
    if ('node.name' in properties && typeof properties['node.name'] === 'string') {
      if (PLAYER_APP_NAMES[properties['node.name']]) match = true;
    }
    if (match) found.push(String(index));
  }
  return found;
}

function setPulseVolume(pid: number | null, vol: number): boolean {
  const pactl = findExecutable('pactl');
  if (!pactl) return false;
  const pct = `${Math.max(0, Math.min(150, Math.round(vol)))}%`;

  const jsonRun = spawnSync(pactl, ['--format=json', 'list', 'sink-inputs'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  if (jsonRun.status === 0 && jsonRun.stdout.trim().startsWith('[')) {
    try {
      const indexes = pulseIndexes(JSON.parse(jsonRun.stdout), pid);
      if (indexes.length > 0) {
        for (const index of indexes) {
          spawnSync(pactl, ['set-sink-input-volume', index, pct], { timeout: 2000 });
        }
        return true;
      }
    } catch {
      // text fallback
    }
  }

  const textRun = spawnSync(pactl, ['list', 'sink-inputs'], { encoding: 'utf8', timeout: 2000 });
  if (textRun.status !== 0 || !textRun.stdout) return false;
  const blocks = textRun.stdout.split(/Sink Input #/);
  let ok = false;
  for (const block of blocks) {
    const named =
      block.includes('application.name = "ffplay"') ||
      block.includes('application.name = "mpv"') ||
      block.includes('application.name = "ffmpeg"') ||
      block.includes('application.name = "paplay"') ||
      block.includes('application.name = "pw-play"') ||
      block.includes('node.name = "ffplay"') ||
      block.includes('node.name = "paplay"');

    const pidHit = pid != null && block.includes(`application.process.id = "${pid}"`);
    if (!named && !pidHit) continue;
    const id = parseInt(block, 10);
    if (!Number.isFinite(id)) continue;
    spawnSync(pactl, ['set-sink-input-volume', String(id), pct], { timeout: 2000 });
    ok = true;
  }
  return ok;
}

export class SimulatedAudioBackend extends EventEmitter implements IAudioBackend {
  private timer: NodeJS.Timeout | null = null;
  private currentMs: number = 0;
  private status: 'playing' | 'paused' | 'stopped' | 'ended' = 'stopped';
  private volume: number = 100;
  private lastTime: number = 0;

  public async play(_url: string, startMs: number = 0): Promise<void> {
    this.currentMs = Math.max(0, startMs);
    this.status = 'playing';
    this.lastTime = Date.now();
    this.startClock();
  }

  public pause(): void {
    this.status = 'paused';
    this.stopClock();
  }

  public resume(): void {
    if (this.status === 'paused') {
      this.status = 'playing';
      this.lastTime = Date.now();
      this.startClock();
    }
  }

  public seek(targetMs: number): void {
    this.currentMs = Math.max(0, targetMs);
    this.lastTime = Date.now();
    if (this.status === 'playing') this.startClock();
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(150, vol));
  }

  public stop(): void {
    this.status = 'stopped';
    this.currentMs = 0;
    this.stopClock();
  }

  public destroy(): void {
    this.stop();
    this.removeAllListeners();
  }

  public getName(): string {
    return 'Simulated / Visualizer Only';
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
        this.emit('status', { status: this.status, currentMs: this.currentMs, volume: this.volume });
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

export class SystemAudioBackend extends EventEmitter implements IAudioBackend {
  private proc: ChildProcess | null = null;
  private sinkProc: ChildProcess | null = null;

  public currentMs: number = 0;
  public status: 'playing' | 'paused' | 'stopped' | 'ended' = 'stopped';
  public currentVolume: number = 100;
  private timer: NodeJS.Timeout | null = null;
  private lastTime: number = 0;
  private currentTarget: string = '';
  private currentStreamUrl: string = '';
  private playSessionId: number = 0;
  private spec: PlayerSpec | null;
  private spawnGeneration: number = 0;
  private retrying: boolean = false;
  private frozen: boolean = false;
  private volumeTimers: NodeJS.Timeout[] = [];
  private cacheWatch: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.spec = detectPlayer();
  }

  public async play(urlOrId: string, startMs: number = 0): Promise<void> {
    this.killProc();
    this.currentTarget = urlOrId || '';
    this.currentMs = Math.max(0, startMs);
    this.lastTime = Date.now();
    const sessionId = ++this.playSessionId;

    if (!this.currentTarget || this.currentTarget === 'simulated' || !isStreamRef(this.currentTarget)) {
      this.status = 'playing';
      this.startClock();
      return;
    }

    if (!this.spec) {
      this.status = 'paused';
      const error = new Error('No audio engine (install ffmpeg or mpv)');
      this.emit('error', error);
      throw error;
    }

    try {
      const streamUrl = await resolveAudioStreamUrl(this.currentTarget);
      if (sessionId !== this.playSessionId) return;
      this.currentStreamUrl = streamUrl;
      this.status = 'playing';
      await this.spawnPlayer(streamUrl, this.currentMs, sessionId);
      if (sessionId !== this.playSessionId) return;
      this.startClock();
      this.startCacheWatch();
    } catch (err: unknown) {
      if (sessionId !== this.playSessionId) return;
      this.status = 'paused';
      this.stopClock();
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', error);
      throw error;
    }
  }

  private playerArgs(streamUrl: string, startMs: number, kind: PlayerKind): string[] {
    const startSec = startMs > 0 ? (startMs / 1000).toFixed(3) : '0';
    const vol = Math.max(0, Math.min(100, this.currentVolume));

    if (kind === 'ffplay') {
      const args = ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(vol)];
      if (startMs > 0) args.push('-ss', startSec);
      args.push('-i', streamUrl);
      return args;
    }

    if (kind === 'mpv') {
      return [
        '--no-video',
        '--really-quiet',
        '--no-terminal',
        `--volume=${vol}`,
        `--start=${startSec}`,
        streamUrl,
      ];
    }

    const common = [
      '-hide_banner',
      '-loglevel', 'error',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    ];
    if (startMs > 0) common.push('-ss', startSec);

    if (kind === 'ffmpeg-paplay' || kind === 'ffmpeg-pwplay') {
      return [
        ...common,
        '-i', streamUrl,
        '-vn',
        '-ac', '2',
        '-ar', '44100',
        '-af', volumeFilter(this.currentVolume),
        '-f', 'wav',
        'pipe:1',
      ];
    }

    const outFmt = kind === 'ffmpeg-alsa' ? 'alsa' : kind === 'ffmpeg-coreaudio' ? 'coreaudio' : 'pulse';
    return [...common, '-i', streamUrl, '-vn', '-af', volumeFilter(this.currentVolume), '-f', outFmt, 'default'];
  }

  private isPiped(): boolean {
    return this.spec?.kind === 'ffmpeg-paplay' || this.spec?.kind === 'ffmpeg-pwplay';
  }

  private nextFallbackSpec(): PlayerSpec | null {
    if (!this.spec) return null;
    const ffmpeg = this.spec.bin;
    if (this.spec.kind === 'ffmpeg-pulse') {
      const paplay = findExecutable('paplay');
      if (paplay) return { kind: 'ffmpeg-paplay', bin: ffmpeg, sinkBin: paplay };
      const pwplay = findExecutable('pw-play');
      if (pwplay) return { kind: 'ffmpeg-pwplay', bin: ffmpeg, sinkBin: pwplay };
      if (muxerEnabled(ffmpegMuxerListing(ffmpeg), 'alsa')) {
        return { kind: 'ffmpeg-alsa', bin: ffmpeg };
      }
    }
    if (this.spec.kind === 'ffmpeg-paplay') {
      const pwplay = findExecutable('pw-play');
      if (pwplay) return { kind: 'ffmpeg-pwplay', bin: ffmpeg, sinkBin: pwplay };
      if (muxerEnabled(ffmpegMuxerListing(ffmpeg), 'alsa')) {
        return { kind: 'ffmpeg-alsa', bin: ffmpeg };
      }
    }
    if (this.spec.kind === 'ffmpeg-pwplay') {
      if (muxerEnabled(ffmpegMuxerListing(ffmpeg), 'alsa')) {
        return { kind: 'ffmpeg-alsa', bin: ffmpeg };
      }
    }
    return null;
  }

  private async spawnPlayer(streamUrl: string, startMs: number, sessionId: number): Promise<void> {
    if (!this.spec) throw new Error('No audio engine');
    this.killProc();

    const generation = ++this.spawnGeneration;
    const args = this.playerArgs(streamUrl, startMs, this.spec.kind);

    if (this.isPiped() && this.spec.sinkBin) {
      await this.spawnPiped(args, this.spec.sinkBin, this.spec.kind, sessionId, generation);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const p = spawn(this.spec!.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = p;
      this.frozen = false;
      p.stderr?.resume();

      const onError = (err: Error) => {
        if (generation !== this.spawnGeneration) return;
        reject(err);
      };
      p.once('error', onError);
      p.once('spawn', () => {
        p.off('error', onError);
        p.on('error', (err) => {
          if (sessionId === this.playSessionId && this.status === 'playing') {
            this.emit('error', err);
          }
        });
        p.on('close', (code) => {
          void this.onProcClose(code, sessionId, generation);
        });
        this.scheduleVolumeApply();
        resolve();
      });
    });
  }

  private async spawnPiped(
    ffArgs: string[],
    sinkBin: string,
    kind: PlayerKind,
    sessionId: number,
    generation: number
  ): Promise<void> {
    const sinkArgs = kind === 'ffmpeg-pwplay' ? ['-'] : [];
    await new Promise<void>((resolve, reject) => {
      const ff = spawn(this.spec!.bin, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      const sink = spawn(sinkBin, sinkArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
      this.proc = ff;
      this.sinkProc = sink;
      this.frozen = false;
      ff.stderr?.resume();
      sink.stderr?.resume();
      if (ff.stdout && sink.stdin) {
        ff.stdout.pipe(sink.stdin);
        sink.stdin.on('error', () => {});
      }

      let spawned = 0;
      let settled = false;
      const fail = (err: Error) => {
        if (settled || generation !== this.spawnGeneration) return;
        settled = true;
        reject(err);
      };
      const ready = () => {
        spawned += 1;
        if (spawned < 2 || settled) return;
        settled = true;
        this.scheduleVolumeApply();
        resolve();
      };

      ff.once('error', fail);
      sink.once('error', fail);
      ff.once('spawn', ready);
      sink.once('spawn', ready);
      sink.on('close', (code) => {
        void this.onProcClose(code, sessionId, generation);
      });
      ff.on('close', (code) => {
        if (generation !== this.spawnGeneration) return;
        if (this.sinkProc && code && code !== 0) {
          try { this.sinkProc.kill('SIGKILL'); } catch {}
        }
      });
    });
  }

  private async onProcClose(code: number | null, sessionId: number, generation: number): Promise<void> {
    if (generation !== this.spawnGeneration) return;
    if (sessionId !== this.playSessionId) return;
    if (this.status !== 'playing') return;
    this.proc = null;
    this.sinkProc = null;
    this.frozen = false;

    if (code === 0) {
      this.status = 'ended';
      this.stopClock();
      this.emit('ended');
      return;
    }

    if (this.retrying) {
      this.status = 'paused';
      this.stopClock();
      this.emit('error', new Error('Audio playback stopped'));
      return;
    }

    this.retrying = true;
    try {
      const fallback = this.nextFallbackSpec();
      if (fallback) {
        this.spec = fallback;
        await this.spawnPlayer(this.currentStreamUrl, this.currentMs, sessionId);
        return;
      }

      if (this.currentTarget && isStreamRef(this.currentTarget)) {
        const fresh = await resolveAudioStreamUrl(this.currentTarget);
        if (sessionId !== this.playSessionId) return;
        this.currentStreamUrl = fresh;
        await this.spawnPlayer(fresh, this.currentMs, sessionId);
        return;
      }
    } catch (err: unknown) {
      this.status = 'paused';
      this.stopClock();
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.retrying = false;
    }
  }


  public pause(): void {
    if (this.status !== 'playing') return;
    this.status = 'paused';
    this.stopClock();
    const pids = [this.proc?.pid, this.sinkProc?.pid].filter((p): p is number => typeof p === 'number');
    if (pids.length > 0) {
      try {
        for (const pid of pids) process.kill(pid, 'SIGSTOP');
        this.frozen = true;
        return;
      } catch {
        this.frozen = false;
      }
    }
    this.playSessionId++;
    this.killProc();
  }


  public resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'playing';
    this.lastTime = Date.now();

    if (this.frozen && this.proc && this.proc.pid) {
      try {
        process.kill(this.proc.pid, 'SIGCONT');
        if (this.sinkProc?.pid) process.kill(this.sinkProc.pid, 'SIGCONT');
        this.frozen = false;
        this.startClock();
        return;
      } catch {
        this.frozen = false;
      }
    }


    const sessionId = ++this.playSessionId;
    if (this.currentStreamUrl && this.spec) {
      void this.spawnPlayer(this.currentStreamUrl, this.currentMs, sessionId).catch(async () => {
        if (sessionId !== this.playSessionId) return;
        if (!this.currentTarget || !isStreamRef(this.currentTarget)) return;
        try {
          const fresh = await resolveAudioStreamUrl(this.currentTarget);
          if (sessionId !== this.playSessionId) return;
          this.currentStreamUrl = fresh;
          await this.spawnPlayer(fresh, this.currentMs, sessionId);
        } catch (err: unknown) {
          this.status = 'paused';
          this.stopClock();
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      });
    }
    this.startClock();
  }

  public seek(targetMs: number): void {
    const target = Math.max(0, targetMs);
    this.currentMs = target;
    this.lastTime = Date.now();
    this.stopClock();

    if (this.status === 'paused') {
      if (this.frozen) {
        this.killProc();
        this.frozen = false;
      }
      return;
    }

    if (this.status !== 'playing') return;

    const sessionId = ++this.playSessionId;
    const id = extractVideoId(this.currentTarget);
    const local = /^[a-zA-Z0-9_-]{11}$/.test(id) ? getCachedMediaPath(id) : undefined;
    if (local) this.currentStreamUrl = local;
    const source = this.currentStreamUrl;

    if (!this.spec || !source) {
      this.startClock();
      return;
    }

    void this.spawnPlayer(source, target, sessionId)
      .then(() => {
        if (sessionId !== this.playSessionId) return;
        this.currentMs = target;
        this.lastTime = Date.now();
        this.startClock();
      })
      .catch(async () => {
        if (sessionId !== this.playSessionId) return;
        if (!this.currentTarget || !isStreamRef(this.currentTarget)) return;
        try {
          const fresh = await resolveAudioStreamUrl(this.currentTarget);
          if (sessionId !== this.playSessionId) return;
          this.currentStreamUrl = fresh;
          await this.spawnPlayer(fresh, target, sessionId);
          if (sessionId !== this.playSessionId) return;
          this.currentMs = target;
          this.lastTime = Date.now();
          this.startClock();
        } catch (err: unknown) {
          this.status = 'paused';
          this.stopClock();
          this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      });
  }

  public setVolume(vol: number): void {
    this.currentVolume = Math.max(0, Math.min(150, vol));
    const pid = this.sinkProc?.pid ?? this.proc?.pid ?? null;
    if (!setPulseVolume(pid, this.currentVolume)) {
      this.scheduleVolumeApply();
    }
  }


  public stop(): void {
    this.playSessionId++;
    this.status = 'stopped';
    this.currentMs = 0;
    this.frozen = false;
    this.stopClock();
    this.clearVolumeTimers();
    this.stopCacheWatch();
    this.killProc();
  }

  public destroy(): void {
    this.stop();
    this.removeAllListeners();
  }

  public getName(): string {
    if (!this.spec) return 'System Audio (unavailable)';
    if (this.spec.kind === 'ffplay') return 'FFplay';
    if (this.spec.kind === 'mpv') return 'mpv';
    if (this.spec.kind === 'ffmpeg-alsa') return 'ffmpeg/ALSA';
    if (this.spec.kind === 'ffmpeg-coreaudio') return 'ffmpeg/CoreAudio';
    if (this.spec.kind === 'ffmpeg-paplay') return 'ffmpeg/paplay';
    if (this.spec.kind === 'ffmpeg-pwplay') return 'ffmpeg/PipeWire';
    return 'ffmpeg/Pulse';
  }


  private clearVolumeTimers(): void {
    for (const t of this.volumeTimers) clearTimeout(t);
    this.volumeTimers = [];
  }

  private scheduleVolumeApply(): void {
    this.clearVolumeTimers();
    for (const delay of [60, 180, 400, 900]) {
      this.volumeTimers.push(setTimeout(() => {
        setPulseVolume(this.sinkProc?.pid ?? this.proc?.pid ?? null, this.currentVolume);
      }, delay));
    }
  }

  private startCacheWatch(): void {
    this.stopCacheWatch();
    const id = extractVideoId(this.currentTarget);
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return;
    const ready = getCachedMediaPath(id);
    if (ready) {
      this.currentStreamUrl = ready;
      return;
    }
    this.cacheWatch = setInterval(() => {
      const file = getCachedMediaPath(id);
      if (file) {
        this.currentStreamUrl = file;
        this.stopCacheWatch();
      }
    }, 800);
  }

  private stopCacheWatch(): void {
    if (this.cacheWatch) {
      clearInterval(this.cacheWatch);
      this.cacheWatch = null;
    }
  }

  private killProc(): void {
    this.spawnGeneration++;
    this.frozen = false;
    const ff = this.proc;
    const sink = this.sinkProc;
    this.proc = null;
    this.sinkProc = null;
    for (const p of [ff, sink]) {
      if (!p) continue;
      try { p.kill('SIGKILL'); } catch {}
    }
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

export function createAudioBackend(): IAudioBackend {
  if (detectPlayer()) return new SystemAudioBackend();
  return new SimulatedAudioBackend();
}
