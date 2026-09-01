import { AuthCredentials, SearchResult, Song, Theme, YtExploreCategory, YtPlaylist, YtTrack } from '../../types.js';
import { ANSI, bg, colorText, drawBox, fg, getVisualWidth, pad, sliceVisualEnd, truncate } from '../renderer.js';
import { formatMusicalNoteText, isMusicalNoteLine } from './LyricsViewport.js';
export interface ModalDimensions {
  width: number;
  height: number;
}

export function renderSearchModal(
  query: string,
  results: SearchResult[],
  selectedIndex: number,
  isLoading: boolean,
  errorMessage: string | null,
  theme: Theme,
  dims: ModalDimensions,
  searchType: string = 'all'
): string[] {
  const modalW = Math.max(24, dims.width);
  const modalH = Math.max(8, dims.height);
  const innerW = Math.max(10, modalW - 2);
  const contentW = Math.max(8, innerW);
  const contentLines: string[] = [];

  const tabs = ['all', 'song', 'album', 'playlist', 'video'];
  const tabStr = tabs.map((t) => {
    const active = t === searchType;
    const label = ` ${t.toUpperCase()} `;
    if (active) {
      return `${bg(theme.primary)}${fg([0, 0, 0])}${ANSI.BOLD}${label}${ANSI.RESET}`;
    }
    return colorText(label, theme.dimmed);
  }).join(' ');
  const searchStatus = isLoading ? colorText(' ⟳', theme.accent) : colorText('   ', theme.subtle);
  contentLines.push(truncate(` ${tabStr}${searchStatus}  ${colorText('Tab: category', theme.subtle)}`, contentW));

  contentLines.push(renderSearchInputField(query, contentW, theme));

  const hint = query.trim()
    ? colorText(' Enter: play highlighted track   ↑↓ navigate   Esc: close', theme.subtle)
    : colorText(' Type to search · trending below · Enter plays highlighted track', theme.subtle);
  contentLines.push(truncate(hint, contentW));
  contentLines.push(colorText('─'.repeat(contentW), theme.subtle));

  const listH = Math.max(1, modalH - 6);

  if (results.length === 0) {
    if (isLoading) {
      contentLines.push(colorText('  ⟳ Searching YouTube Music & LRCLIB...', theme.primary));
    } else if (errorMessage) {
      contentLines.push(colorText(`  ✕ ${errorMessage}`, [255, 100, 100]));
    } else if (query.trim()) {
      contentLines.push(colorText(`  No matches for "${query}". Try another query.`, theme.dimmed));
    } else {
      contentLines.push(colorText('  ⟳ Loading suggested & trending tracks...', theme.dimmed));
    }
  } else {
    const startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(listH / 2), Math.max(0, results.length - listH)));
    const endIdx = Math.min(results.length, startIdx + listH);

    for (let i = startIdx; i < endIdx; i++) {
      const r = results[i];
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? colorText('▶ ', theme.accent, true) : '  ';
      const typeBadge = r.type && r.type !== 'song' ? colorText(`[${r.type.toUpperCase()}] `, theme.secondary) : '';
      const sourceBadge = r.source === 'youtube' ? colorText('YT ', [255, 50, 50]) : colorText('LRC ', [30, 215, 96]);
      const titleStr = isSelected
        ? `${ANSI.BOLD}${fg([0, 0, 0])}${bg(theme.highlight)} ${r.title} ${ANSI.RESET}`
        : colorText(r.title, theme.text);
      const artistStr = colorText(` - ${r.artist}`, theme.dimmed);
      const durStr = r.duration ? colorText(` (${formatDuration(r.duration)})`, theme.subtle) : '';
      const line = `${prefix}${sourceBadge}${typeBadge}${titleStr}${artistStr}${durStr}`;
      contentLines.push(truncate(line, contentW));
    }
  }

  while (contentLines.length < modalH - 2) {
    contentLines.push('');
  }
  if (contentLines.length > modalH - 2) {
    contentLines.length = modalH - 2;
  }

  const badgeText = isLoading
    ? '⟳ Searching...'
    : results.length > 0
      ? `${Math.min(selectedIndex + 1, results.length)}/${results.length}`
      : 'Live Search';
  return drawBox(contentLines, modalW, theme.border, 'YouTube Music Search', {
    text: badgeText,
    bg: theme.primary,
    fg: [0, 0, 0],
  });
}

function renderSearchInputField(query: string, width: number, theme: Theme): string {
  const fieldBg: [number, number, number] = [36, 36, 46];
  const textFg: [number, number, number] = [255, 255, 255];
  const placeholderFg: [number, number, number] = [168, 168, 184];
  const prefix = '> ';
  const cursor = '█';
  const placeholder = 'Search songs, artists, albums, or paste a URL';
  const prefixW = getVisualWidth(prefix);
  const maxText = Math.max(1, width - prefixW - 1);
  const restore = `${ANSI.RESET}${bg(fieldBg)}`;

  let inner: string;
  if (query.length > 0) {
    const shown = sliceVisualEnd(query, maxText);
    const fill = Math.max(0, maxText - getVisualWidth(shown));
    inner = `${ANSI.BOLD}${fg(textFg)}${shown}${restore}${fg(theme.accent)}${cursor}${restore}${' '.repeat(fill)}`;
  } else {
    const phShown = getVisualWidth(placeholder) > maxText ? truncate(placeholder, maxText) : placeholder;
    const fill = Math.max(0, maxText - getVisualWidth(phShown));
    inner = `${fg(theme.accent)}${cursor}${restore}${fg(placeholderFg)}${phShown}${restore}${' '.repeat(fill)}`;
  }

  const line = `${bg(fieldBg)}${fg(theme.accent)}${prefix}${restore}${inner}${ANSI.RESET}`;
  const visual = getVisualWidth(line);
  if (visual < width) {
    return `${line.slice(0, line.length - ANSI.RESET.length)}${' '.repeat(width - visual)}${ANSI.RESET}`;
  }
  return line;
}

export function renderPlaylistModal(
  playlists: YtPlaylist[],
  selectedPlaylistIdx: number,
  currentTracks: YtTrack[] | null,
  selectedTrackIdx: number,
  theme: Theme,
  dims: ModalDimensions
): string[] {
  const modalW = Math.min(80, Math.max(24, dims.width - 4));
  const modalH = Math.min(22, Math.max(8, dims.height - 4));
  const contentLines: string[] = [];

  if (currentTracks) {
    // Viewing tracks inside a selected playlist
    const pl = playlists[selectedPlaylistIdx];
    const headerTitle = pl ? pl.title : 'Playlist Tracks';
    contentLines.push(colorText(` ♫ Tracks in: ${headerTitle} (Esc/Left: Back, Enter: Play Track)`, theme.accent));
    contentLines.push(colorText('─'.repeat(modalW - 4), theme.subtle));

    const listH = modalH - 5;
    const startIdx = Math.max(0, Math.min(selectedTrackIdx - Math.floor(listH / 2), Math.max(0, currentTracks.length - listH)));
    const endIdx = Math.min(currentTracks.length, startIdx + listH);

    if (currentTracks.length === 0) {
      contentLines.push(colorText(' No tracks in this playlist.', theme.dimmed));
    } else {
      for (let i = startIdx; i < endIdx; i++) {
        const t = currentTracks[i];
        const isSelected = i === selectedTrackIdx;
        const prefix = isSelected ? colorText('▶ ', theme.accent, true) : '  ';
        const numStr = colorText(`${pad(String(i + 1), 2, 'right')}. `, theme.subtle);
        const titleStr = isSelected ? `${ANSI.BOLD}${fg(theme.highlight)}${t.title}${ANSI.RESET}` : colorText(t.title, theme.text);
        const artistStr = colorText(` - ${t.artist}`, theme.dimmed);
        const durStr = t.durationMs ? colorText(` (${formatDuration(Math.floor(t.durationMs / 1000))})`, theme.subtle) : '';

        const line = `${prefix}${numStr}${titleStr}${artistStr}${durStr}`;
        contentLines.push(truncate(line, modalW - 4));
      }
    }

    while (contentLines.length < modalH - 2) {
      contentLines.push('');
    }

    return drawBox(contentLines, modalW, theme.border, `Playlist: ${headerTitle}`, {
      text: `${selectedTrackIdx + 1}/${currentTracks.length} Tracks`,
      bg: theme.primary,
      fg: [0, 0, 0],
    });
  }

  // Viewing playlists list (Liked Songs, User Playlists)
  contentLines.push(colorText(' Your YouTube Music Library & Playlists (Enter to open, P to play all)', theme.subtle));
  contentLines.push(colorText('─'.repeat(modalW - 4), theme.subtle));

  const listH = modalH - 5;
  const startIdx = Math.max(0, Math.min(selectedPlaylistIdx - Math.floor(listH / 2), Math.max(0, playlists.length - listH)));
  const endIdx = Math.min(playlists.length, startIdx + listH);

  if (playlists.length === 0) {
    contentLines.push(colorText(' No playlists found. Sign in via `resonate auth login` to view your library.', theme.dimmed));
  } else {
    for (let i = startIdx; i < endIdx; i++) {
      const pl = playlists[i];
      const isSelected = i === selectedPlaylistIdx;
      const prefix = isSelected ? colorText('▶ ', theme.accent, true) : '  ';
      const icon = pl.id === 'LM' ? colorText('♥ ', [255, 80, 100]) : colorText('≡ ', theme.secondary);
      const titleStr = isSelected ? `${ANSI.BOLD}${fg(theme.highlight)}${pl.title}${ANSI.RESET}` : colorText(pl.title, theme.text);
      const countStr = pl.itemCount ? colorText(` (${pl.itemCount} songs)`, theme.subtle) : '';
      const authorStr = pl.author ? colorText(` by ${pl.author}`, theme.dimmed) : '';

      const line = `${prefix}${icon}${titleStr}${countStr}${authorStr}`;
      contentLines.push(truncate(line, modalW - 4));
    }
  }

  while (contentLines.length < modalH - 2) {
    contentLines.push('');
  }

  return drawBox(contentLines, modalW, theme.border, 'Playlists & Library', {
    text: `${selectedPlaylistIdx + 1}/${playlists.length} Playlists`,
    bg: theme.primary,
    fg: [0, 0, 0],
  });
}

export function renderQueueModal(
  queue: Song[],
  currentTrackIndex: number,
  selectedQueueIdx: number,
  theme: Theme,
  dims: ModalDimensions
): string[] {
  const modalW = Math.min(78, Math.max(24, dims.width - 4));
  const modalH = Math.min(20, Math.max(8, dims.height - 4));
  const contentLines: string[] = [];

  contentLines.push(colorText(' Playback Queue & Up Next (Enter: Jump to track, d: Remove, Esc: Close)', theme.subtle));
  contentLines.push(colorText('─'.repeat(modalW - 4), theme.subtle));

  if (queue.length === 0) {
    contentLines.push(colorText(' Queue is currently empty.', theme.dimmed));
  } else {
    const listH = modalH - 5;
    const startIdx = Math.max(0, Math.min(selectedQueueIdx - Math.floor(listH / 2), Math.max(0, queue.length - listH)));
    const endIdx = Math.min(queue.length, startIdx + listH);

    for (let i = startIdx; i < endIdx; i++) {
      const s = queue[i];
      const isSelected = i === selectedQueueIdx;
      const isCurrent = i === currentTrackIndex;

      const cursor = isSelected ? colorText('▶ ', theme.accent, true) : '  ';
      const playIcon = isCurrent ? colorText('♫ ', [30, 215, 96]) : colorText(`${pad(String(i + 1), 2, 'right')}. `, theme.subtle);

      const titleStr = isSelected || isCurrent ? `${ANSI.BOLD}${fg(theme.highlight)}${s.title}${ANSI.RESET}` : colorText(s.title, theme.text);
      const artistStr = colorText(` - ${s.artist}`, theme.dimmed);
      const durStr = s.durationMs ? colorText(` (${formatDuration(Math.floor(s.durationMs / 1000))})`, theme.subtle) : '';

      const line = `${cursor}${playIcon}${titleStr}${artistStr}${durStr}`;
      contentLines.push(truncate(line, modalW - 4));
    }
  }

  while (contentLines.length < modalH - 2) {
    contentLines.push('');
  }

  return drawBox(contentLines, modalW, theme.border, 'Playback Queue', {
    text: `${currentTrackIndex + 1}/${queue.length} Tracks`,
    bg: theme.primary,
    fg: [0, 0, 0],
  });
}

export function renderExploreModal(
  categories: YtExploreCategory[],
  selectedCatIdx: number,
  selectedItemIdx: number,
  theme: Theme,
  dims: ModalDimensions
): string[] {
  const modalW = Math.min(80, Math.max(24, dims.width - 4));
  const modalH = Math.min(22, Math.max(8, dims.height - 4));
  const contentLines: string[] = [];

  if (categories.length === 0) {
    contentLines.push(colorText(' ⟳ Loading YouTube Music Explore & Charts...', theme.primary));
  } else {
    const activeCat = categories[selectedCatIdx] || categories[0];

    // Category tabs
    const catTabs = categories.slice(0, 5).map((c, idx) => {
      const active = idx === selectedCatIdx;
      return active ? `${ANSI.BOLD}${colorText(`[${c.title}]`, theme.accent)}${ANSI.RESET}` : colorText(`[${c.title}]`, theme.subtle);
    }).join(' ');

    contentLines.push(` ${truncate(catTabs, modalW - 6)}`);
    contentLines.push(colorText('─'.repeat(modalW - 4), theme.subtle));

    const listH = modalH - 5;
    const items = activeCat.items || [];
    const startIdx = Math.max(0, Math.min(selectedItemIdx - Math.floor(listH / 2), Math.max(0, items.length - listH)));
    const endIdx = Math.min(items.length, startIdx + listH);

    for (let i = startIdx; i < endIdx; i++) {
      const item = items[i];
      const isSelected = i === selectedItemIdx;
      const prefix = isSelected ? colorText('▶ ', theme.accent, true) : '  ';
      const typeBadge = colorText(`[${item.type.toUpperCase()}] `, theme.secondary);
      const titleStr = isSelected ? `${ANSI.BOLD}${fg(theme.highlight)}${item.title}${ANSI.RESET}` : colorText(item.title, theme.text);
      const subStr = item.subtitle ? colorText(` - ${item.subtitle}`, theme.dimmed) : '';

      const line = `${prefix}${typeBadge}${titleStr}${subStr}`;
      contentLines.push(truncate(line, modalW - 4));
    }
  }

  while (contentLines.length < modalH - 2) {
    contentLines.push('');
  }

  return drawBox(contentLines, modalW, theme.border, 'Explore & Charts', {
    text: 'Trending Music',
    bg: theme.primary,
    fg: [0, 0, 0],
  });
}

export function renderAuthModal(
  creds: AuthCredentials | null,
  statusMsg: string | null,
  theme: Theme,
  dims: ModalDimensions
): string[] {
  const modalW = Math.min(74, Math.max(24, dims.width - 4));
  const modalH = Math.min(18, Math.max(8, dims.height - 4));
  const contentLines: string[] = [];

  const hasAuth = Boolean(creds?.cookie || creds?.oauthToken || creds?.accountInfo?.name);
  const isPremium = Boolean(creds?.accountInfo?.hasPremium);

  contentLines.push(colorText(' YouTube Music Authentication & Premium Status', theme.accent));
  contentLines.push(colorText('─'.repeat(modalW - 4), theme.subtle));

  if (hasAuth) {
    const name = creds?.accountInfo?.name || 'Authenticated User';
    const email = creds?.accountInfo?.email || 'Logged In';
    const premBadge = isPremium
      ? `${ANSI.BOLD}${colorText('★ YOUTUBE PREMIUM ACTIVE', [255, 215, 0])}${ANSI.RESET}`
      : colorText('Standard Account', theme.dimmed);

    contentLines.push(` User: ${ANSI.BOLD}${name}${ANSI.RESET} (${email})`);
    contentLines.push(` Status: ${premBadge}`);
    contentLines.push(` High-bitrate Premium Playback: ${isPremium ? colorText('Enabled (256kbps)', [30, 215, 96]) : colorText('Standard', theme.dimmed)}`);
    contentLines.push('');
    contentLines.push(colorText(' Commands: `resonate auth status`, `resonate auth logout`', theme.subtle));
  } else {
    contentLines.push(colorText(' You are currently not signed in to YouTube Music.', theme.dimmed));
    contentLines.push('');
    contentLines.push(' To sign in with your YouTube Music or Premium account:');
    contentLines.push(`  ${colorText('1.', theme.accent)} Run ${ANSI.BOLD}resonate auth login${ANSI.RESET} in your terminal.`);
    contentLines.push(`  ${colorText('2.', theme.accent)} Or import browser cookies via ${ANSI.BOLD}resonate auth login --browser chrome${ANSI.RESET}.`);
  }

  if (statusMsg) {
    contentLines.push('');
    contentLines.push(colorText(` [i] ${statusMsg}`, theme.primary));
  }

  while (contentLines.length < modalH - 2) {
    contentLines.push('');
  }

  return drawBox(contentLines, modalW, theme.border, 'YouTube Music Account', {
    text: hasAuth ? (isPremium ? '★ Premium' : 'Signed In') : 'Guest',
    bg: hasAuth ? (isPremium ? [255, 215, 0] : theme.primary) : theme.dimmed,
    fg: [0, 0, 0],
  });
}

export function renderHelpModal(theme: Theme, dims: ModalDimensions): string[] {
  const modalW = Math.min(84, Math.max(30, dims.width - 2));
  const modalH = Math.min(24, Math.max(12, dims.height - 2));
  const contentW = modalW - 4;
  const contentLines: string[] = [];

  const col1: Array<[string, string]> = [
    ['Space', 'Play / Pause music & lyrics'],
    ['← / →', 'Seek ±5s (Shift: 15s)'],
    ['↑ / ↓', 'Volume up / down by 5%'],
    ['0 / Home', 'Restart track (0:00)'],
    ['N / B', 'Next / Prev track in queue'],
    ['O', 'Toggle loop current track'],
    ['X', 'Shuffle remaining queue'],
    ['U', 'Mute / unmute'],
    [', / .', 'Speed − / + 0.25x'],
    ['K', 'Like current YouTube track'],
    ['/ or S', 'Search YouTube & LRCLIB'],
    ['P or L', 'Playlists & Liked Songs'],
    ['Q', 'Playback Queue (d: remove)'],
    ['E', 'Explore & Top Charts'],
    ['R or M', 'Reading mode (PgUp/Dn: scroll)'],
  ];
  const col2: Array<[string, string]> = [
    ['V', 'Cycle Visualizers (7 modes)'],
    ['T / Shift+T', 'Cycle Color Themes'],
    ['A', 'Toggle Album Art on/off'],
    ['I', 'Toggle Timestamps on/off'],
    ['[ / ]', 'Sync Offset (-/+100ms)'],
    ['Tab', 'Cycle category in Search/Explore'],
    ['? or H', 'Toggle Help shortcuts modal'],
    ['Esc / Ctrl+C', 'Close active modal / Exit'],
  ];

  if (contentW >= 60) {
    const halfW = Math.floor((contentW - 2) / 2);
    contentLines.push(
      `${pad(colorText(' Playback & Views:', theme.accent, true), halfW)}${colorText('  Visuals & Navigation:', theme.accent, true)}`
    );
    contentLines.push(colorText('─'.repeat(contentW), theme.subtle));

    const maxRows = Math.max(col1.length, col2.length);
    for (let i = 0; i < maxRows; i++) {
      const item1 = col1[i];
      const item2 = col2[i];

      let leftStr = '';
      if (item1) {
        const k1 = `${ANSI.BOLD}${colorText(pad(item1[0], 11, 'left'), theme.primary)}${ANSI.RESET}`;
        leftStr = truncate(`${k1}${colorText(` ${item1[1]}`, theme.text)}`, halfW);
      }
      leftStr = pad(leftStr, halfW);

      let rightStr = '';
      if (item2) {
        const k2 = `${ANSI.BOLD}${colorText(pad(item2[0], 11, 'left'), theme.primary)}${ANSI.RESET}`;
        rightStr = truncate(`${k2}${colorText(` ${item2[1]}`, theme.text)}`, halfW);
      }

      contentLines.push(`${leftStr}  ${rightStr}`);
    }
  } else {
    // Single column for narrow terminals
    const allItems = [...col1, ...col2];
    for (const [key, desc] of allItems) {
      if (contentLines.length >= modalH - 2) break;
      const k = `${ANSI.BOLD}${colorText(pad(key, 12, 'left'), theme.primary)}${ANSI.RESET}`;
      contentLines.push(truncate(`${k}${colorText(` ${desc}`, theme.text)}`, contentW));
    }
  }

  while (contentLines.length < modalH - 2) {
    contentLines.push('');
  }
  if (contentLines.length > modalH - 2) {
    contentLines.length = modalH - 2;
  }

  return drawBox(contentLines, modalW, theme.border, 'Keyboard Shortcuts & Controls', {
    text: 'Press Esc or ? to close',
    bg: theme.secondary,
    fg: [0, 0, 0],
  });
}

export function renderReadingView(
  song: Song | null,
  activeLineIndex: number,
  scrollOffset: number,
  theme: Theme,
  dims: ModalDimensions
): string[] {
  const innerW = Math.max(10, dims.width - 2);
  const innerH = Math.max(2, dims.height - 2);
  const contentLines: string[] = [];

  if (!song || song.lyrics.length === 0) {
    contentLines.push(pad(colorText('No lyrics available.', theme.dimmed), innerW, 'center'));
    while (contentLines.length < innerH) {
      contentLines.push('');
    }
    return drawBox(contentLines, dims.width, theme.border, 'Reading Mode');
  }

  const startLine = Math.max(0, scrollOffset);
  const endLine = Math.min(song.lyrics.length, startLine + innerH);

  for (let i = startLine; i < endLine; i++) {
    const line = song.lyrics[i];
    const isCurrent = i === activeLineIndex;
    const prefix = isCurrent ? colorText('▶ ', theme.accent, true) : '  ';
    const text = isMusicalNoteLine(line) ? formatMusicalNoteText(line) : line.text || ' ';
    if (isCurrent) {
      contentLines.push(`${prefix}${ANSI.BOLD}${fg(theme.highlight)}${text}${ANSI.RESET}`);
    } else {
      contentLines.push(`${prefix}${colorText(text, theme.text)}`);
    }
  }

  while (contentLines.length < innerH) {
    contentLines.push('');
  }

  const badgeText = `${activeLineIndex + 1}/${song.lyrics.length} Lines`;
  return drawBox(contentLines, dims.width, theme.border, `${song.title} - ${song.artist}`, {
    text: badgeText,
    bg: theme.primary,
    fg: [0, 0, 0],
  });
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
