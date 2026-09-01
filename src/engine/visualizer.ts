import { RGB, Theme, VisualizerType } from '../types.js';

export interface VisualizerRenderOptions {
  width: number;
  height: number;
  timeMs: number;
  isPlaying: boolean;
  theme: Theme;
  bpm?: number;
  energy?: number; // 0.0 - 1.0
  spectrum?: number[]; // 16 frequency bands [0.0 - 1.0]
}

export class AudioVisualizer {
  private type: VisualizerType = 'bars';
  private peakHeights: number[] = [];
  private peakVelocities: number[] = [];
  private peakHoldFrames: number[] = [];
  private barHeights: number[] = [];
  private particles: Array<{ x: number; y: number; vx: number; vy: number; life: number; maxLife: number; char: string }> = [];
  private matrixStreams: Array<{ x: number; y: number; speed: number; chars: string[] }> = [];
  private flameGrid: number[][] = [];
  private vinylAngle: number = 0;
  private lastBeatIndex: number = -1;

  constructor(type: VisualizerType = 'bars') {
    this.type = type;
  }

  public setType(type: VisualizerType): void {
    this.type = type;
    this.reset();
  }

  public getType(): VisualizerType {
    return this.type;
  }

  public nextType(): VisualizerType {
    const types: VisualizerType[] = ['bars', 'wave', 'flame', 'particles', 'matrix', 'pulse', 'vinyl'];
    const currIdx = types.indexOf(this.type);
    const nextIdx = (currIdx + 1) % types.length;
    this.setType(types[nextIdx]);
    return this.type;
  }

  public reset(): void {
    this.peakHeights = [];
    this.peakVelocities = [];
    this.peakHoldFrames = [];
    this.barHeights = [];
    this.particles = [];
    this.matrixStreams = [];
    this.flameGrid = [];
    this.lastBeatIndex = -1;
  }
  /**
   * Generates rhythmic energy & simulated frequency bands based on song time & bpm
   */
  private generateFrequencyBands(numBands: number, timeMs: number, isPlaying: boolean, bpm: number = 120, realSpectrum?: number[]): number[] {
    if (!isPlaying) {
      return new Array(numBands).fill(0.04);
    }

    if (realSpectrum && realSpectrum.length > 0 && realSpectrum.some((b) => b > 0.01)) {
      const bands: number[] = [];
      const srcLen = realSpectrum.length;
      for (let i = 0; i < numBands; i++) {
        const norm = i / Math.max(1, numBands - 1);
        const srcPos = norm * (srcLen - 1);
        const idx0 = Math.floor(srcPos);
        const idx1 = Math.min(srcLen - 1, idx0 + 1);
        const frac = srcPos - idx0;
        // Smooth Hermite/Cosine interpolation across frequency bands
        const smoothFrac = 0.5 * (1 - Math.cos(frac * Math.PI));
        const val = realSpectrum[idx0] * (1 - smoothFrac) + realSpectrum[idx1] * smoothFrac;
        bands.push(Math.max(0.04, Math.min(1.0, val)));
      }
      return bands;
    }

    // High-precision musical 4/4 rhythm generator
    const safeBpm = Math.max(60, Math.min(220, bpm));
    const t = Math.max(0, timeMs) / 1000;
    const beatInterval = 60 / safeBpm;
    const totalBeats = t / beatInterval;
    const beatPhase = totalBeats % 1.0;
    const barPhase = (totalBeats % 4.0); // 0.0 to 4.0 in measure

    // Kick on beats 1 and 3
    const kickDist = Math.min(Math.abs(barPhase - 0.0), Math.abs(barPhase - 2.0));
    const kickPhase = kickDist < 1.0 ? kickDist : (barPhase < 1.0 ? barPhase : 4.0 - barPhase);
    const kickEnv = Math.exp(-kickPhase * 4.5);

    // Snare on beats 2 and 4
    const snareDist = Math.min(Math.abs(barPhase - 1.0), Math.abs(barPhase - 3.0));
    const snareEnv = Math.exp(-snareDist * 5.0);

    // 8th-note Hi-hats
    const eighthPhase = (totalBeats * 2) % 1.0;
    const hihatEnv = Math.exp(-eighthPhase * 7.0);

    const bands: number[] = [];
    for (let i = 0; i < numBands; i++) {
      const freqNorm = i / Math.max(1, numBands - 1);

      // Low frequencies: driven by kick drum
      const bassContrib = Math.max(0, 1 - freqNorm * 2.2) * kickEnv * 0.85;

      // Mid frequencies: driven by snare & vocal body
      const midPos = Math.abs(freqNorm - 0.45);
      const midContrib = Math.max(0, 1 - midPos * 3.0) * snareEnv * 0.75;

      // High frequencies: driven by hi-hats & snare snap
      const highContrib = Math.max(0, (freqNorm - 0.5) * 2.0) * hihatEnv * 0.65;

      // Gentle organic ambient floor
      const harmonicFloor = (Math.sin(t * 1.2 + i * 0.3) * 0.05 + 0.08);

      const combined = bassContrib + midContrib + highContrib + harmonicFloor;
      bands.push(Math.max(0.04, Math.min(1.0, combined)));
    }

    return bands;
  }

  private getEnergyMetrics(spectrum?: number[], bpm: number = 120, timeMs: number = 0): {
    bass: number;
    mid: number;
    treble: number;
    energy: number;
  } {
    if (spectrum && spectrum.length >= 16 && spectrum.some((b) => b > 0.01)) {
      const bass = (spectrum[0] * 1.2 + spectrum[1] * 1.1 + spectrum[2] + spectrum[3] * 0.8) / 4.1;
      const mid = (spectrum[4] + spectrum[5] + spectrum[6] + spectrum[7] + spectrum[8]) / 5;
      const treble = (spectrum[9] + spectrum[10] + spectrum[11] + spectrum[12] + spectrum[13] + spectrum[14] + spectrum[15]) / 7;
      const energy = (bass * 1.3 + mid * 1.0 + treble * 0.9) / 3.2;
      return {
        bass: Math.min(1.0, Math.max(0, bass)),
        mid: Math.min(1.0, Math.max(0, mid)),
        treble: Math.min(1.0, Math.max(0, treble)),
        energy: Math.min(1.0, Math.max(0, energy)),
      };
    }

    const safeBpm = Math.max(60, Math.min(220, bpm));
    const t = Math.max(0, timeMs) / 1000;
    const beatInterval = 60 / safeBpm;
    const totalBeats = t / beatInterval;
    const barPhase = totalBeats % 4.0;

    const kickDist = Math.min(Math.abs(barPhase - 0.0), Math.abs(barPhase - 2.0));
    const kickEnv = Math.exp(-kickDist * 4.5);

    const snareDist = Math.min(Math.abs(barPhase - 1.0), Math.abs(barPhase - 3.0));
    const snareEnv = Math.exp(-snareDist * 5.0);

    const eighthPhase = (totalBeats * 2) % 1.0;
    const hihatEnv = Math.exp(-eighthPhase * 7.0);

    const bass = 0.12 + kickEnv * 0.78;
    const mid = 0.15 + snareEnv * 0.65;
    const treble = 0.12 + hihatEnv * 0.6;
    return { bass, mid, treble, energy: (bass * 1.2 + mid + treble) / 3.2 };
  }
  /**
   * Renders the visualizer as an array of colored ANSI string lines
   */
  public render(opts: VisualizerRenderOptions): string[] {
    const { width, height, timeMs, isPlaying, theme, bpm = 120, spectrum } = opts;
    const effectiveWidth = Math.max(1, width);
    const effectiveHeight = Math.max(1, height);
    switch (this.type) {
      case 'bars':
        return this.renderBars(effectiveWidth, effectiveHeight, timeMs, isPlaying, theme, bpm, spectrum);
      case 'wave':
        return this.renderWave(effectiveWidth, effectiveHeight, timeMs, isPlaying, theme, bpm, spectrum);
      case 'flame':
        return this.renderFlame(effectiveWidth, effectiveHeight, timeMs, isPlaying, theme, bpm, spectrum);
      case 'particles':
        return this.renderParticles(effectiveWidth, effectiveHeight, timeMs, isPlaying, theme, bpm, spectrum);
      case 'matrix':
        return this.renderMatrix(effectiveWidth, effectiveHeight, timeMs, isPlaying, theme, spectrum);
      case 'pulse':
        return this.renderPulse(effectiveWidth, effectiveHeight, timeMs, isPlaying, theme, bpm, spectrum);
      case 'vinyl':
        return this.renderVinyl(effectiveWidth, effectiveHeight, timeMs, isPlaying, theme, spectrum);
      default:
        return this.renderBars(effectiveWidth, effectiveHeight, timeMs, isPlaying, theme, bpm, spectrum);
    }
  }

  private renderBars(
    width: number,
    height: number,
    timeMs: number,
    isPlaying: boolean,
    theme: Theme,
    bpm: number,
    spectrum?: number[]
  ): string[] {
    const numBars = Math.min(64, Math.floor(width / 2));
    const rawBands = this.generateFrequencyBands(numBars, timeMs, isPlaying, bpm, spectrum);

    // Initialize smoothing arrays if size changed
    if (this.barHeights.length !== numBars) {
      this.barHeights = new Array(numBars).fill(0);
      this.peakHeights = new Array(numBars).fill(0);
      this.peakVelocities = new Array(numBars).fill(0);
      this.peakHoldFrames = new Array(numBars).fill(0);
    }

    // Smooth heights with studio-grade attack, exponential decay & peak gravity hold
    for (let i = 0; i < numBars; i++) {
      const target = rawBands[i] * height;

      if (target >= this.barHeights[i]) {
        // Fast, punchy attack
        this.barHeights[i] = this.barHeights[i] * 0.25 + target * 0.75;
      } else {
        // Smooth exponential analog decay
        this.barHeights[i] = Math.max(0, this.barHeights[i] * 0.88 - 0.03);
      }

      // Studio Peak Hold & Gravity Drop
      if (this.barHeights[i] >= this.peakHeights[i]) {
        this.peakHeights[i] = this.barHeights[i];
        this.peakVelocities[i] = 0;
        this.peakHoldFrames[i] = 8; // Hold peak cap for 8 frames (~250ms)
      } else {
        if (this.peakHoldFrames[i] > 0) {
          this.peakHoldFrames[i]--;
        } else {
          // Accelerate downward with gravity
          this.peakVelocities[i] += 0.04;
          this.peakHeights[i] = Math.max(0, this.peakHeights[i] - this.peakVelocities[i]);
        }
      }
    }

    const subBlockChars = [' ', ' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const lines: string[] = [];

    for (let y = height - 1; y >= 0; y--) {
      let lineStr = '';
      for (let i = 0; i < numBars; i++) {
        const val = this.barHeights[i];
        const peakVal = this.peakHeights[i];
        const color = theme.visualizer[i % theme.visualizer.length] || theme.primary;
        const fg = `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`;
        const reset = '\x1b[0m';

        let char = ' ';
        if (Math.floor(peakVal) === y && isPlaying && y > 0) {
          char = '▔'; // Peak hold cap
          const peakColor = theme.highlight;
          const peakFg = `\x1b[38;2;${peakColor[0]};${peakColor[1]};${peakColor[2]}m`;
          lineStr += `${peakFg}${char}${reset} `;
        } else if (val >= y + 1) {
          char = '█';
          lineStr += `${fg}${char}${reset} `;
        } else if (val > y) {
          const frac = val - y;
          const subIdx = Math.min(8, Math.max(1, Math.floor(frac * 8)));
          char = subBlockChars[subIdx];
          lineStr += `${fg}${char}${reset} `;
        } else {
          lineStr += '  ';
        }
      }
      lines.push(lineStr);
    }

    return lines;
  }
  private renderWave(
    width: number,
    height: number,
    timeMs: number,
    isPlaying: boolean,
    theme: Theme,
    bpm: number,
    spectrum?: number[]
  ): string[] {
    const t = Math.max(0, timeMs) / 1000;
    const midY = Math.floor(height / 2);
    const grid: string[][] = Array.from({ length: height }, () => new Array(width).fill(' '));
    const { bass, mid, treble, energy } = this.getEnergyMetrics(spectrum, bpm, timeMs);

    // Calm, rhythmic wave motion
    const ampScale = isPlaying ? Math.max(0.12, (0.2 + bass * 0.45 + energy * 0.35)) : 0.05;
    const waveSpeed = t * 1.5;

    for (let x = 0; x < width; x++) {
      const normX = x / width;
      const y1 = Math.round(
        midY + Math.sin(normX * Math.PI * 3 + waveSpeed) * (height * ampScale * 0.8) +
          Math.cos(normX * Math.PI * 6 - waveSpeed * 0.7) * (height * (0.05 + mid * 0.2))
      );
      const y2 = Math.round(
        midY + Math.sin(normX * Math.PI * 4.5 - waveSpeed * 0.85) * (height * ampScale * 0.6)
      );
      const y3 = Math.round(
        midY + Math.cos(normX * Math.PI * 7 + waveSpeed * 1.2) * (height * ampScale * (0.2 + treble * 0.3))
      );

      const color1 = theme.primary;
      const color2 = theme.accent;
      const color3 = theme.secondary;
      const fg1 = `\x1b[38;2;${color1[0]};${color1[1]};${color1[2]}m`;
      const fg2 = `\x1b[38;2;${color2[0]};${color2[1]};${color2[2]}m`;
      const fg3 = `\x1b[38;2;${color3[0]};${color3[1]};${color3[2]}m`;
      const reset = '\x1b[0m';

      if (y1 >= 0 && y1 < height) {
        grid[y1][x] = `${fg1}◆${reset}`;
      }
      if (y2 >= 0 && y2 < height && y2 !== y1) {
        grid[y2][x] = `${fg2}∿${reset}`;
      }
      if (y3 >= 0 && y3 < height && y3 !== y1 && y3 !== y2) {
        grid[y3][x] = `${fg3}·${reset}`;
      }
    }

    return grid.map((row) => row.join(''));
  }

  private renderFlame(
    width: number,
    height: number,
    timeMs: number,
    isPlaying: boolean,
    theme: Theme,
    bpm: number,
    spectrum?: number[]
  ): string[] {
    if (this.flameGrid.length !== height || (this.flameGrid[0] && this.flameGrid[0].length !== width)) {
      this.flameGrid = Array.from({ length: height }, () => new Array(width).fill(0));
    }

    const { bass, energy } = this.getEnergyMetrics(spectrum, bpm, timeMs);
    const bands = this.generateFrequencyBands(width, timeMs, isPlaying, bpm, spectrum);

    // Bottom fire row driven by music energy
    for (let x = 0; x < width; x++) {
      const bandVal = bands[x] || 0.1;
      this.flameGrid[height - 1][x] = isPlaying
        ? Math.max(0, Math.min(1.0, bandVal * 0.75 + (Math.random() * 0.25) * (0.5 + bass * 0.8)))
        : 0.08;
    }

    // Upward heat propagation with smooth cooling
    const cooling = isPlaying ? 0.86 + energy * 0.06 : 0.75;
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width; x++) {
        const left = x > 0 ? this.flameGrid[y + 1][x - 1] : this.flameGrid[y + 1][x];
        const center = this.flameGrid[y + 1][x];
        const right = x < width - 1 ? this.flameGrid[y + 1][x + 1] : this.flameGrid[y + 1][x];
        this.flameGrid[y][x] = Math.max(0, Math.min(1.0, ((left + center * 2.4 + right) / 4.4) * cooling));
      }
    }

    const chars = [' ', '░', '▒', '▓', '█'];
    const lines: string[] = [];

    for (let y = 0; y < height; y++) {
      let line = '';
      for (let x = 0; x < width; x++) {
        const heat = Math.max(0, Math.min(1.0, this.flameGrid[y][x]));
        const charIdx = Math.min(chars.length - 1, Math.floor(heat * chars.length));
        const colorIdx = Math.min(theme.visualizer.length - 1, Math.floor(heat * theme.visualizer.length));
        const c = theme.visualizer[colorIdx] || theme.primary;
        line += `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${chars[charIdx]}\x1b[0m`;
      }
      lines.push(line);
    }

    return lines;
  }

  private renderParticles(
    width: number,
    height: number,
    timeMs: number,
    isPlaying: boolean,
    theme: Theme,
    bpm: number,
    spectrum?: number[]
  ): string[] {
    const symbols = ['✦', '✧', '★', '·', '•', '°', '¤', '*'];
    const maxParticles = Math.floor((width * height) / 7);
    const { bass, treble, energy } = this.getEnergyMetrics(spectrum, bpm, timeMs);

    // Spawn on beats
    const safeBpm = Math.max(60, Math.min(220, bpm));
    const currentBeat = Math.floor((timeMs / 1000) / (60 / safeBpm));
    if (isPlaying && currentBeat !== this.lastBeatIndex) {
      this.lastBeatIndex = currentBeat;
      const count = bass > 0.4 ? 4 : 2;
      for (let b = 0; b < count; b++) {
        if (this.particles.length < maxParticles) {
          this.particles.push({
            x: Math.floor(Math.random() * width),
            y: height - 1,
            vx: (Math.random() - 0.5) * (0.6 + treble * 0.8),
            vy: -(Math.random() * 0.4 + 0.3 + bass * 0.4),
            life: 1.0,
            maxLife: 1.0,
            char: symbols[Math.floor(Math.random() * symbols.length)],
          });
        }
      }
    }

    // Update particles smoothly
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.02; // ~50 frames lifetime (1.5 seconds)
      if (p.life <= 0 || p.y < 0 || p.x < 0 || p.x >= width) {
        this.particles.splice(i, 1);
      }
    }

    const grid: string[][] = Array.from({ length: height }, () => new Array(width).fill(' '));

    for (const p of this.particles) {
      const px = Math.floor(p.x);
      const py = Math.floor(p.y);
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const color = p.life > 0.6 ? theme.highlight : p.life > 0.3 ? theme.primary : theme.dimmed;
        grid[py][px] = `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${p.char}\x1b[0m`;
      }
    }

    return grid.map((r) => r.join(''));
  }

  private renderMatrix(
    width: number,
    height: number,
    timeMs: number,
    isPlaying: boolean,
    theme: Theme,
    spectrum?: number[]
  ): string[] {
    const chars = '0123456789ABCDEF$#@%&*+-/<>~ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ';
    const { treble, energy } = this.getEnergyMetrics(spectrum, 120, timeMs);

    if (this.matrixStreams.length !== width) {
      this.matrixStreams = Array.from({ length: width }, (_, x) => ({
        x,
        y: Math.floor(Math.random() * height * 2) - height,
        speed: 0.15 + Math.random() * 0.25,
        chars: Array.from({ length: height }, () => chars[Math.floor(Math.random() * chars.length)]),
      }));
    }

    const grid: string[][] = Array.from({ length: height }, () => new Array(width).fill(' '));

    if (isPlaying) {
      const speedMul = 0.8 + treble * 0.6 + energy * 0.4;
      for (const s of this.matrixStreams) {
        s.y += s.speed * speedMul;
        if (s.y > height + 5) {
          s.y = -Math.floor(Math.random() * 6);
          s.chars = Array.from({ length: height }, () => chars[Math.floor(Math.random() * chars.length)]);
        }

        const headY = Math.floor(s.y);
        for (let y = 0; y < height; y++) {
          const dist = headY - y;
          if (dist >= 0 && dist < 5) {
            const char = s.chars[y % s.chars.length];
            const c = dist === 0 ? theme.highlight : dist < 3 ? theme.primary : theme.dimmed;
            grid[y][s.x] = `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${char}\x1b[0m`;
          }
        }
      }
    }

    return grid.map((r) => r.join(''));
  }

  private renderPulse(
    width: number,
    height: number,
    timeMs: number,
    isPlaying: boolean,
    theme: Theme,
    bpm: number,
    spectrum?: number[]
  ): string[] {
    const midX = Math.floor(width / 2);
    const midY = Math.floor(height / 2);
    const maxRadius = Math.min(midX, midY * 2);
    const t = Math.max(0, timeMs) / 1000;
    const { bass, energy } = this.getEnergyMetrics(spectrum, bpm, timeMs);
    const safeBpm = Math.max(60, Math.min(220, bpm));
    const beatInterval = 60 / safeBpm;
    const beatPhase = (t % beatInterval) / beatInterval;

    const grid: string[][] = Array.from({ length: height }, () => new Array(width).fill(' '));

    const rings = isPlaying ? [beatPhase, (beatPhase + 0.5) % 1.0] : [0.5];

    for (const phase of rings) {
      const radius = phase * maxRadius * (0.6 + energy * 0.4);
      const color = phase < 0.4 ? theme.highlight : phase < 0.7 ? theme.primary : theme.dimmed;
      const fg = `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`;
      const reset = '\x1b[0m';

      for (let theta = 0; theta < Math.PI * 2; theta += 0.1) {
        const x = Math.round(midX + Math.cos(theta) * radius * 1.8);
        const y = Math.round(midY + Math.sin(theta) * radius);
        if (x >= 0 && x < width && y >= 0 && y < height) {
          grid[y][x] = `${fg}◎${reset}`;
        }
      }
    }

    // Center pulse icon reacting to bass
    const centerIcon = isPlaying && bass > 0.4 ? '◉' : '○';
    const cColor = isPlaying && bass > 0.4 ? theme.highlight : theme.accent;
    if (midY >= 0 && midY < height && midX >= 0 && midX < width) {
      grid[midY][midX] = `\x1b[38;2;${cColor[0]};${cColor[1]};${cColor[2]}m${centerIcon}\x1b[0m`;
    }

    return grid.map((r) => r.join(''));
  }
  private renderVinyl(
    width: number,
    height: number,
    timeMs: number,
    isPlaying: boolean,
    theme: Theme,
    spectrum?: number[]
  ): string[] {
    const midX = Math.floor(width / 2);
    const midY = Math.floor(height / 2);
    const radius = Math.min(midX - 2, midY * 2 - 1);
    const { energy, bass } = this.getEnergyMetrics(spectrum, 120, timeMs);

    if (isPlaying) {
      // 33.3 RPM rotation rate
      this.vinylAngle = ((timeMs / 1000) * 3.5) % (Math.PI * 2);
    }

    const grid: string[][] = Array.from({ length: height }, () => new Array(width).fill(' '));

    const grooveChars = ['░', '▒', '▓', '█'];
    const pColor = theme.dimmed;
    const aColor = theme.accent;
    const hColor = theme.highlight;
    const reset = '\x1b[0m';

    // Draw vinyl rings
    for (let r = 2; r < radius; r += 2) {
      for (let theta = 0; theta < Math.PI * 2; theta += 0.12) {
        const x = Math.round(midX + Math.cos(theta) * r * 1.7);
        const y = Math.round(midY + Math.sin(theta) * (r / 2));
        if (x >= 0 && x < width && y >= 0 && y < height) {
          const char = grooveChars[Math.floor((theta + this.vinylAngle) % grooveChars.length)];
          const ringColor = (r % 4 === 0 && bass > 0.45) ? aColor : pColor;
          grid[y][x] = `\x1b[38;2;${ringColor[0]};${ringColor[1]};${ringColor[2]}m${char}${reset}`;
        }
      }
    }

    // Draw turntable label center
    if (midY >= 0 && midY < height && midX >= 1 && midX + 1 < width) {
      grid[midY][midX - 1] = `\x1b[38;2;${aColor[0]};${aColor[1]};${aColor[2]}m(${reset}`;
      grid[midY][midX] = `\x1b[38;2;${hColor[0]};${hColor[1]};${hColor[2]}m◉${reset}`;
      grid[midY][midX + 1] = `\x1b[38;2;${aColor[0]};${aColor[1]};${aColor[2]}m)${reset}`;
    }

    return grid.map((r) => r.join(''));
  }
}
