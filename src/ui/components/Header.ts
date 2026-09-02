import { PlayerState, Song, Theme } from '../../types.js';
import { ANSI, colorText, fg, getVisualWidth, gradientText, truncate } from '../renderer.js';

export interface HeaderOptions {
  width: number;
  song: Song | null;
  state: PlayerState;
  theme: Theme;
  viewMode: string;
  downloadedCount?: number;
}

export function renderHeader(opts: HeaderOptions): string[] {
  const { width, song, state, theme, viewMode } = opts;
  const downloadedCount = opts.downloadedCount ?? 0;
  const lines: string[] = [];

  const bFg = fg(theme.border);
  const reset = ANSI.RESET;
  const innerWidth = Math.max(10, width - 2);

  // Top border: download count (left), logo, view mode (right)
  const logo = ` RESONATE `;
  const modeBadge = ` [${viewMode.toUpperCase()}] `;
  const dlText = ` ⬇ ${downloadedCount} `;
  const logoWidth = getVisualWidth(logo);
  const modeWidth = getVisualWidth(modeBadge);
  const dlWidth = getVisualWidth(dlText);

  let headerTop: string;
  const logoStyled = `${ANSI.BOLD}${gradientText(logo, theme.gradient, true)}${reset}`;
  const modeStyled = colorText(modeBadge, theme.secondary, true);
  const dlStyled = colorText(dlText, theme.accent, true);

  if (innerWidth >= dlWidth + logoWidth + modeWidth + 3) {
    const topFillLen = Math.max(0, innerWidth - dlWidth - logoWidth - modeWidth - 3);
    headerTop = `${bFg}╭─${reset}${dlStyled}${bFg}─${reset}${logoStyled}${bFg}${'─'.repeat(topFillLen)}${reset}${modeStyled}${bFg}─╮${reset}`;
  } else if (innerWidth >= dlWidth + logoWidth + 2) {
    const topFillLen = Math.max(0, innerWidth - dlWidth - logoWidth - 2);
    headerTop = `${bFg}╭─${reset}${dlStyled}${bFg}─${reset}${logoStyled}${bFg}${'─'.repeat(topFillLen)}╮${reset}`;
  } else if (innerWidth >= dlWidth + 2) {
    const topFillLen = Math.max(0, innerWidth - dlWidth - 2);
    headerTop = `${bFg}╭─${reset}${dlStyled}${bFg}${'─'.repeat(topFillLen)}╮${reset}`;
  } else {
    headerTop = `${bFg}╭${'─'.repeat(innerWidth)}╮${reset}`;
  }
  lines.push(headerTop);

  // Song Title & Playback Status Line
  let statusBadge: string;
  if (state.isBuffering) {
    statusBadge = ` ${colorText('⟳ BUFFERING', [255, 180, 0], true)} `;
  } else if (state.status === 'playing') {
    statusBadge = ` ${colorText('●', theme.accent, true)} ${colorText('PLAYING', theme.accent, true)} `;
  } else if (state.status === 'paused') {
    statusBadge = ` ${colorText('⏸ PAUSED', theme.secondary, true)} `;
  } else if (state.status === 'ended') {
    statusBadge = ` ${colorText('⏹ ENDED', theme.dimmed, true)} `;
  } else {
    statusBadge = ` ${colorText('⏹ READY', theme.dimmed, true)} `;
  }

  const titleText = song ? `${song.title}` : 'No Track Loaded (Press / or S to search YouTube Music)';
  const titleRowRight = `${statusBadge}`;
  const maxTitleLen = Math.max(4, innerWidth - getVisualWidth(titleRowRight) - 4);
  const truncTitle = truncate(titleText, maxTitleLen);
  const styledTitle = `${ANSI.BOLD}${gradientText(truncTitle, [theme.primary, theme.accent], true)}${reset}`;

  const titleRowLeft = `  ${styledTitle}`;
  const titleSpacing = Math.max(0, innerWidth - getVisualWidth(titleRowLeft) - getVisualWidth(titleRowRight));
  lines.push(`${bFg}│${reset}${titleRowLeft}${' '.repeat(titleSpacing)}${titleRowRight}${bFg}│${reset}`);

  // Artist & Album & Source Line
  const sourceTag = song?.source === 'youtube' ? colorText('YT-MUSIC ', [255, 50, 50]) : colorText('LOCAL ', theme.secondary);
  const artistText = song ? `by ${song.artist}` : 'Press / to search, P for playlists, Q for queue, E for explore';
  const albumText = song?.album ? ` • ${song.album}` : '';
  const fullMeta = `${artistText}${albumText}`;

  const volBadge = colorText(`VOL ${state.volume}% `, theme.accent);
  const themeBadge = `${theme.icon} ${theme.name}`;
  const styledTheme = `${volBadge}${colorText(`${themeBadge} `, theme.secondary)}`;

  const maxMetaLen = Math.max(4, innerWidth - getVisualWidth(styledTheme) - 14);
  const truncMeta = truncate(fullMeta, maxMetaLen);
  const styledMeta = `  ${sourceTag}${colorText(truncMeta, theme.subtle || theme.dimmed)}`;

  const metaSpacing = Math.max(0, innerWidth - getVisualWidth(styledMeta) - getVisualWidth(styledTheme));
  lines.push(`${bFg}│${reset}${styledMeta}${' '.repeat(metaSpacing)}${styledTheme}${bFg}│${reset}`);

  // Bottom border
  lines.push(`${bFg}╰${'─'.repeat(innerWidth)}╯${reset}`);
  return lines;
}
