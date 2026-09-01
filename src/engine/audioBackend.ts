import { EventEmitter } from 'events';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { findExecutable } from '../services/auth.js';
import { isStreamRef, resolveAudioStreamUrl } from '../services/ytmusic.js';

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

type PlayerKind = 'ffplay' | 'mpv' | 'ffmpeg-pulse' | 'ffmpeg-alsa';

interface PlayerSpec {
  kind: PlayerKind;
  bin: string;
}

function detectPlayer(): PlayerSpec | null {
  const ffplay = findExecutable('ffplay');
  if (ffplay) return { kind: 'ffplay', bin: ffplay };

  const mpv = findExecutable('mpv');
  if (mpv) return { kind: 'mpv', bin: mpv };

  const ffmpeg = findExecutable('ffmpeg');
  if (ffmpeg && process.platform !== 'darwin') {
    return { kind: 'ffmpeg-pulse', bin: ffmpeg };
  }
  return null;
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
      block.includes('node.name = "ffplay"');
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

    const outFmt = kind === 'ffmpeg-alsa' ? 'alsa' : 'pulse';
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    ];
    if (startMs > 0) args.push('-ss', startSec);
    args.push('-i', streamUrl, '-vn', '-af', volumeFilter(this.currentVolume), '-f', outFmt, 'default');
    return args;
  }

  private async spawnPlayer(streamUrl: string, startMs: number, sessionId: number): Promise<void> {
    if (!this.spec) throw new Error('No audio engine');
    this.killProc();

    const generation = ++this.spawnGeneration;
    const args = this.playerArgs(streamUrl, startMs, this.spec.kind);

    await new Promise<void>((resolve, reject) => {
      const p = spawn(this.spec!.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = p;
      this.frozen = false;

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

  private async onProcClose(code: number | null, sessionId: number, generation: number): Promise<void> {
    if (generation !== this.spawnGeneration) return;
    if (sessionId !== this.playSessionId) return;
    if (this.status !== 'playing') return;
    if (this.proc) this.proc = null;
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
      if (this.spec?.kind === 'ffmpeg-pulse') {
        this.spec = { kind: 'ffmpeg-alsa', bin: this.spec.bin };
        await this.spawnPlayer(this.currentStreamUrl, this.currentMs, sessionId);
        this.retrying = false;
        return;
      }

      if (this.currentTarget && isStreamRef(this.currentTarget)) {
        const fresh = await resolveAudioStreamUrl(this.currentTarget);
        if (sessionId !== this.playSessionId) return;
        this.currentStreamUrl = fresh;
        await this.spawnPlayer(fresh, this.currentMs, sessionId);
        this.retrying = false;
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
    if (this.proc && this.proc.pid) {
      try {
        process.kill(this.proc.pid, 'SIGSTOP');
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
    this.currentMs = Math.max(0, targetMs);
    this.lastTime = Date.now();

    if (this.status === 'paused') {
      if (this.frozen) {
        this.killProc();
        this.frozen = false;
      }
      return;
    }

    if (this.status !== 'playing') return;

    const sessionId = ++this.playSessionId;
    if (!this.spec || !this.currentStreamUrl) {
      this.startClock();
      return;
    }

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
    this.startClock();
  }

  public setVolume(vol: number): void {
    this.currentVolume = Math.max(0, Math.min(150, vol));
    if (!setPulseVolume(this.proc?.pid ?? null, this.currentVolume)) {
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
        setPulseVolume(this.proc?.pid ?? null, this.currentVolume);
      }, delay));
    }
  }

  private killProc(): void {
    this.spawnGeneration++;
    this.frozen = false;
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try {
      p.kill('SIGKILL');
    } catch {}
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
