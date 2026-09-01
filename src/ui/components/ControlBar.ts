import { PlayerState, Theme, VisualizerType } from '../../types.js';
import { formatMsToTime } from '../../parser/lrc.js';
import { ANSI, colorText, fg, getVisualWidth, gradientText, truncate } from '../renderer.js';

export interface ControlBarOptions {
  width: number;
  state: PlayerState;
  theme: Theme;
  visualizerType: VisualizerType;
  viewMode: string;
  showTimestamps: boolean;
}

export function renderControlBar(opts: ControlBarOptions): string[] {
  const { width, state, theme, visualizerType, showTimestamps } = opts;
  const lines: string[] = [];
  const bFg = fg(theme.border);
  const reset = ANSI.RESET;
  const innerWidth = Math.max(10, width - 2);

  // Top border
  lines.push(`${bFg}╭${'─'.repeat(innerWidth)}╮${reset}`);

  // Row 1: Progress Scrub Bar
  const curTimeStr = formatMsToTime(state.currentTimeMs);
  const durTimeStr = formatMsToTime(state.durationMs);
  const percentStr = `${Math.round(state.progressRatio * 100)}%`;

  const timePrefix = ` ${colorText(curTimeStr, theme.accent, true)} `;
  const timeSuffix = ` ${colorText(durTimeStr, theme.primary)} ${colorText(`(${percentStr})`, theme.subtle)} `;

  const fixedLen = getVisualWidth(timePrefix) + getVisualWidth(timeSuffix);
  const barLen = Math.max(1, innerWidth - fixedLen);

  const filledCount = Math.round(state.progressRatio * barLen);
  const emptyCount = Math.max(0, barLen - filledCount);

  let progressBar: string;
  if (filledCount > 0) {
    const filledStr = '━'.repeat(filledCount);
    const coloredFilled = gradientText(filledStr, [theme.primary, theme.accent]);
    const knob = `${ANSI.BOLD}${fg(theme.highlight)}●${reset}`;
    const emptyStr = colorText('─'.repeat(Math.max(0, emptyCount - 1)), theme.subtle);
    progressBar = `${coloredFilled}${knob}${emptyStr}`;
  } else {
    progressBar = colorText('─'.repeat(barLen), theme.subtle);
  }

  const progressRow = `${timePrefix}${progressBar}${timeSuffix}`;
  const safeProgressRow = getVisualWidth(progressRow) > innerWidth ? truncate(progressRow, innerWidth) : progressRow;
  const padProgress = Math.max(0, innerWidth - getVisualWidth(safeProgressRow));
  lines.push(`${bFg}│${reset}${safeProgressRow}${' '.repeat(padProgress)}${bFg}│${reset}`);

  // Row 2: Status Badges (Speed, Offset, Loop, Visualizer, Volume, Backend)
  const speed = typeof state.speed === 'number' ? state.speed : 1.0;
  const speedBadge = colorText(`SPD: ${speed.toFixed(2)}x`, theme.primary);
  const offset = state.offsetMs ?? 0;
  const offsetSign = offset >= 0 ? '+' : '';
  const offsetBadge = colorText(`SYNC: ${offsetSign}${(offset / 1000).toFixed(1)}s`, offset !== 0 ? theme.accent : theme.subtle);
  const loopBadge = state.loop ? colorText('LOOP: ON', theme.accent, true) : colorText('LOOP: OFF', theme.subtle);
  const vizBadge = colorText(`VIZ: ${visualizerType.toUpperCase()}`, theme.secondary);
  const volBadge = colorText(`VOL: ${state.volume}%`, theme.accent);
  const backendBadge = colorText(`AUDIO: ${state.backend || 'Native'}`, theme.dimmed);
  const timeToggleBadge = showTimestamps ? colorText('TIME: ON', theme.accent) : colorText('TIME: OFF', theme.subtle);
  const statusItems = [speedBadge, offsetBadge, loopBadge, vizBadge, volBadge, backendBadge, timeToggleBadge];
  let statusLineLeft = `  ${statusItems.join('  │  ')}`;
  if (getVisualWidth(statusLineLeft) > innerWidth) {
    statusLineLeft = `  ${statusItems.slice(0, 4).join('  ')}`;
  }
  const safeStatus = getVisualWidth(statusLineLeft) > innerWidth ? truncate(statusLineLeft, innerWidth) : statusLineLeft;
  const statusPad = Math.max(0, innerWidth - getVisualWidth(safeStatus));
  lines.push(`${bFg}│${reset}${safeStatus}${' '.repeat(statusPad)}${bFg}│${reset}`);

  // Row 3: Keybind Shortcuts
  const shortcuts = [
    `${colorText('Space', theme.accent)}:Play/Pause`,
    `${colorText('←/→', theme.accent)}:Seek`,
    `${colorText('↑/↓', theme.accent)}:Vol`,
    `${colorText('N/B', theme.accent)}:Next/Prev`,
    `${colorText('/', theme.accent)}:Search`,
    `${colorText('P', theme.accent)}:Playlists`,
    `${colorText('Q', theme.accent)}:Queue`,
    `${colorText('E', theme.accent)}:Explore`,
    `${colorText('R', theme.accent)}:Lyrics`,
    `${colorText('V', theme.accent)}:Visualizer`,
    `${colorText('T', theme.accent)}:Theme`,
    `${colorText('?', theme.accent)}:Help`,
  ];

  let shortcutStr = `  ${shortcuts.join('  ')}`;
  if (getVisualWidth(shortcutStr) > innerWidth) {
    const essential = shortcuts.slice(0, 7);
    shortcutStr = `  ${essential.join('  ')}`;
  }

  const safeShortcutStr = getVisualWidth(shortcutStr) > innerWidth ? truncate(shortcutStr, innerWidth) : shortcutStr;
  const shortcutPad = Math.max(0, innerWidth - getVisualWidth(safeShortcutStr));
  lines.push(`${bFg}│${reset}${safeShortcutStr}${' '.repeat(shortcutPad)}${bFg}│${reset}`);

  // Bottom Border
  lines.push(`${bFg}╰${'─'.repeat(innerWidth)}╯${reset}`);

  return lines;
}
