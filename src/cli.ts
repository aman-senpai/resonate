import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fetchSongDetails, loadLocalLrcFile, searchLyrics } from './services/lyricsApi.js';
import { clearAuthCredentials, importCookiesFromBrowser, loadAuthCredentials, saveAuthCredentials } from './services/auth.js';
import { extractVideoId, getExploreFeed, getLikedSongs, getUserPlaylists, getYtMusicClient, getYtPlaylist } from './services/ytmusic.js';
import { LyricalApp } from './app.js';
import { AuthCredentials, Song, ViewMode, YtPlaylist } from './types.js';
import { THEMES } from './ui/themes.js';
import { ANSI, colorText, gradientText, pad } from './ui/renderer.js';
import { formatStorageLimit, getConfig, parseStorageBytes, saveConfig } from './services/config.js';
import {
  deleteAllDownloadedSongs,
  findDownloadedMatch,
  formatBytes,
  getDownloadedSongs,
  getTotalDownloadedBytes,
  toPlayableSong,
  upgradeDownloadedLibrary,
} from './services/downloadManager.js';

export async function runCli(args: string[]): Promise<void> {
  const flags: Record<string, string | boolean | number> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = isNaN(Number(val)) ? val : Number(val);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        const key = arg.slice(2);
        const val = args[++i];
        flags[key] = isNaN(Number(val)) ? val : Number(val);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        const val = args[++i];
        flags[key] = isNaN(Number(val)) ? val : Number(val);
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  // Help flag
  if (flags['help'] || flags['h']) {
    printHelp();
    return;
  }

  // Version flag
  if (flags['version'] || flags['v']) {
    printVersion();
    return;
  }

  const command = positional[0]?.toLowerCase();

  if (command === 'help') {
    printHelp();
    return;
  }
  // Subcommand: auth
  if (command === 'auth') {
    await handleAuthCommand(positional.slice(1), flags);
    return;
  }


  // Subcommand: themes
  if (command === 'themes') {
    printThemes();
    return;
  }

  // Subcommand: playlist / pl
  if (command === 'playlist' || command === 'pl') {
    await handlePlaylistCommand(positional.slice(1), flags);
    return;
  }

  // Subcommand: library / lib
  if (command === 'library' || command === 'lib') {
    await handleLibraryCommand(positional.slice(1), flags);
    return;
  }

  // Subcommand: charts / explore / trending
  if (command === 'charts' || command === 'explore' || command === 'trending') {
    await handleExploreCommand(flags);
    return;
  }

  // Subcommand: downloads / dl
  if (command === 'downloads' || command === 'dl') {
    await handleDownloadsCommand(positional.slice(1), flags);
    return;
  }


  // Subcommand: search / find — TUI combobox with live suggestions
  if (command === 'search' || command === 'find') {
    await runSearchCli(positional.slice(1).join(' '), flags);
    return;
  }

  // Subcommand: get / fetch (fetch and dump LRC to stdout)
  if (command === 'get' || command === 'fetch') {
    const query = positional.slice(1).join(' ');
    if (!query) {
      console.log(colorText('Error: Please provide a song title or query. Example: resonate get "Bohemian Rhapsody"', [255, 100, 100]));
      process.exit(1);
    }
    await runGetCli(query);
    return;
  }

  // Subcommand: play or default interactive launch
  let targetSong: Song | undefined;
  let queryArg = '';

  if (command === 'play') {
    queryArg = positional.slice(1).join(' ');
  } else if (positional.length > 0) {
    queryArg = positional.join(' ');
  }

  if (queryArg) {
    // 1. Check if argument is a local file path
    const resolvedPath = path.resolve(process.cwd(), queryArg);
    if (fs.existsSync(resolvedPath)) {
      try {
        targetSong = loadLocalLrcFile(resolvedPath);
      } catch (err: any) {
        console.error(colorText(`Failed to load file: ${err.message}`, [255, 100, 100]));
        process.exit(1);
      }
    }

    // 2. Play from offline library first (title, artist, or video id)
    if (!targetSong) {
      const offline = findDownloadedMatch(queryArg);
      if (offline) {
        targetSong = toPlayableSong(offline);
        console.log(colorText(`✓ Playing offline: ${offline.title} - ${offline.artist}`, [30, 215, 96]));
      }
    }

    // 3. Check if argument is a YouTube Music URL or Video ID
    if (!targetSong) {
      const videoId = extractVideoId(queryArg);
      if (videoId && videoId.length === 11) {
        console.log(colorText(`⟳ Fetching YouTube Music track: ${videoId}...`, [255, 0, 51]));
        try {
          const fetched = await fetchSongDetails({
            id: videoId,
            title: 'YouTube Track',
            artist: 'YouTube Music',
            duration: 180,
            hasSynced: false,
            source: 'youtube',
          });
          if (fetched) {
            targetSong = fetched;
          }
        } catch {
          // Fallback search
        }
      }
    }

    // 4. Search online on YouTube Music & LRCLIB
    if (!targetSong) {
      console.log(colorText(`⟳ Searching YouTube Music & LRCLIB for "${queryArg}"...`, [255, 0, 51]));
      const searchRes = await searchLyrics(queryArg);
      if (searchRes.length > 0) {
        const topResult = searchRes[0];
        console.log(colorText(`✓ Found: ${topResult.title} - ${topResult.artist}`, [30, 215, 96]));
        const fetched = await fetchSongDetails(topResult);
        if (fetched) {
          targetSong = fetched;
        }
      }
    }
  }

  const themeName = (flags['theme'] as string) || (flags['t'] as string) || 'ytmusic';
  const speed = typeof flags['speed'] === 'number' ? flags['speed'] : 1.0;

  launchInteractiveApp(flags, {
    initialSong: targetSong,
    autoPlay: true,
    startView: targetSong ? 'karaoke' : (queryArg ? 'search' : 'search'),
    initialSearchQuery: targetSong ? undefined : queryArg || undefined,
  });
}

function launchInteractiveApp(
  flags: Record<string, string | boolean | number>,
  opts: {
    initialSong?: Song;
    autoPlay?: boolean;
    startView?: ViewMode;
    initialSearchQuery?: string;
  } = {}
): void {
  const themeFlag = (typeof flags['theme'] === 'string' && flags['theme']) || (typeof flags['t'] === 'string' && flags['t']) || '';
  const speed = typeof flags['speed'] === 'number' ? flags['speed'] : 1.0;
  if (themeFlag) saveConfig({ theme: String(themeFlag) });
  const app = new LyricalApp({
    initialSong: opts.initialSong,
    initialTheme: themeFlag || undefined,
    autoPlay: opts.autoPlay ?? true,
    speed,
    initialSearchQuery: opts.initialSearchQuery,
    startView: opts.startView,
  });
  app.start();
}

/**
 * Handles `lyrical auth` subcommands (login, status, logout)
 */
async function handleAuthCommand(args: string[], flags: Record<string, string | boolean | number>): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (sub === 'login') {
    const browser = (flags['browser'] as string) || (flags['b'] as string);
    const cookie = flags['cookie'] as string;

    if (cookie) {
      const creds: AuthCredentials = loadAuthCredentials() || {};
      creds.cookie = cookie;
      creds.lastChecked = Date.now();
      saveAuthCredentials(creds);
      console.log(colorText('✓ Saved YouTube Music cookie credentials!', [30, 215, 96]));
      await checkAndDisplayAuthStatus();
      return;
    }

    if (browser) {
      console.log(colorText(`⟳ Extracting YouTube Music cookies from ${browser}...`, [255, 0, 51]));
      const result = await importCookiesFromBrowser(browser);
      if (result.success) {
        console.log(colorText(`✓ Successfully imported ${result.count || 0} cookies from ${browser}!`, [30, 215, 96]));
        await checkAndDisplayAuthStatus();
      } else {
        console.log(colorText(`✕ Failed to extract cookies from ${browser}: ${result.error}`, [255, 100, 100]));
        console.log(colorText('  Tip: Make sure you are logged into https://music.youtube.com in your browser.', [200, 200, 200]));
      }
      return;
    }

    // Interactive OAuth Device Code flow
    console.log(colorText('═══ YouTube Music Authentication ═══', [255, 0, 51]));
    console.log('');
    console.log('You can authenticate using one of the following methods:');
    console.log('');
    console.log(` 1. ${ANSI.BOLD}Browser Cookie Import${ANSI.RESET} (Easiest & supports Premium):`);
    console.log(`    ${colorText('resonate auth login --browser chrome', [255, 215, 0])}`);
    console.log(`    ${colorText('resonate auth login --browser firefox', [255, 215, 0])}`);
    console.log(`    ${colorText('resonate auth login --browser brave', [255, 215, 0])}`);
    console.log('');
    console.log(` 2. ${ANSI.BOLD}Manual Cookie String${ANSI.RESET}:`);
    console.log(`    ${colorText('resonate auth login --cookie "SAPISID=...; __Secure-3PAPISID=..."', [255, 215, 0])}`);
    console.log(` 3. ${ANSI.BOLD}OAuth Device Code Flow${ANSI.RESET}:`);
    console.log('    Starting Google Device Code authorization...');
    console.log('');

    try {
      const yt = await getYtMusicClient();
      yt.session.on('auth-pending', ({ verification_url, user_code }) => {
        console.log(colorText('───────────────────────────────────────────────────', [255, 0, 51]));
        console.log(` Open URL:   ${ANSI.BOLD}${colorText(verification_url, [30, 215, 96])}${ANSI.RESET}`);
        console.log(` Enter Code: ${ANSI.BOLD}${colorText(user_code, [255, 215, 0])}${ANSI.RESET}`);
        console.log(colorText('───────────────────────────────────────────────────', [255, 0, 51]));
        console.log(' Waiting for approval in your browser...');
      });

      await yt.session.signIn();
      console.log(colorText('✓ Successfully signed in to YouTube Music via OAuth!', [30, 215, 96]));
      await checkAndDisplayAuthStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(colorText(`Notice: ${msg}`, [200, 200, 200]));
      console.log(colorText('Tip: Use `resonate auth login --browser chrome` for seamless browser login.', [255, 215, 0]));
    }
    return;
  }

  if (sub === 'logout') {
    clearAuthCredentials();
    console.log(colorText('✓ Successfully logged out from YouTube Music and removed session credentials.', [30, 215, 96]));
    return;
  }

  // Status (default)
  await checkAndDisplayAuthStatus();
}

async function checkAndDisplayAuthStatus(): Promise<void> {
  const creds = loadAuthCredentials();
  const hasAuth = Boolean(creds?.cookie || creds?.oauthToken);

  console.log(colorText('═══ YouTube Music Auth Status ═══', [255, 0, 51]));
  console.log(` Status: ${hasAuth ? colorText('● Logged In', [30, 215, 96]) : colorText('○ Guest / Not Signed In', [200, 200, 200])}`);

  if (hasAuth) {
    if (creds?.cookie) {
      console.log(` Cookies: ${colorText('Active', [30, 215, 96])}`);
    }
    if (creds?.oauthToken) {
      console.log(` OAuth:   ${colorText('Connected', [30, 215, 96])}`);
    }

    try {
      console.log(colorText('⟳ Verifying YouTube account...', [255, 0, 51]));
      const yt = await getYtMusicClient();
      const account = (await yt.account.getInfo()) as {
        contents?: { name?: { text?: string }; endpoint?: unknown; is_child?: boolean; is_premium?: boolean };
        name?: string;
      };
      const name = account?.contents?.name?.text || account?.name || 'YouTube User';
      const hasPrem = Boolean(account?.contents?.is_child || account?.contents?.endpoint || account?.contents?.is_premium);
      console.log(` Account: ${ANSI.BOLD}${name}${ANSI.RESET}`);
      console.log(` Premium: ${hasPrem ? colorText('★ YouTube Premium Active (High Bitrate 256kbps)', [255, 215, 0]) : colorText('Standard Audio', [200, 200, 200])}`);
      console.log(` Session: ${colorText('Authenticated Session Ready', [30, 215, 96])}`);
    } catch {
      console.log(` Session: ${colorText('Authenticated Session Ready', [30, 215, 96])}`);
    }
  } else {
    console.log('');
    console.log(' To sign in to your YouTube Music account:');
    console.log(`   ${colorText('resonate auth login --browser chrome', [255, 215, 0])}`);
    console.log(`   ${colorText('resonate auth login', [255, 215, 0])}`);
  }
}

/**
 * Handles `lyrical playlist` subcommands
 */
async function handlePlaylistCommand(args: string[], flags: Record<string, string | boolean | number>): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (!sub && process.stdin.isTTY && process.stdout.isTTY) {
    launchInteractiveApp(flags, { startView: 'playlists', autoPlay: false });
    return;
  }

  if (sub === 'list' || !sub) {
    console.log(colorText('═══ YouTube Music Playlists & Library ═══', [255, 0, 51]));
    console.log(colorText('⟳ Loading your playlists...', [255, 0, 51]));

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

      if (list.length === 0) {
        console.log(colorText('No playlists found. Sign in via `resonate auth login` to view your library.', [200, 200, 200]));
        return;
      }

      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const icon = p.id === 'LM' ? colorText('♥ Liked Music', [255, 80, 100]) : colorText('≡ Playlist', [30, 215, 96]);
        const count = p.itemCount ? ` (${p.itemCount} songs)` : '';
        console.log(`  ${colorText(`${i + 1}.`, [255, 215, 0])} ${ANSI.BOLD}${p.title}${ANSI.RESET}${count} [${p.id}] - ${icon}`);
      }
      console.log('');
      console.log(colorText('Tip: Play a playlist with `resonate playlist play <id>`', [255, 215, 0]));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(colorText(`Error: ${message}`, [255, 100, 100]));
    }
    return;
  }

  if (sub === 'show') {
    const plId = args[1];
    if (!plId) {
      console.log(colorText('Error: Please specify a playlist ID. Example: resonate playlist show LM', [255, 100, 100]));
      return;
    }

    console.log(colorText(`⟳ Loading playlist ${plId}...`, [255, 0, 51]));
    try {
      const pl = await getYtPlaylist(plId);
      console.log(colorText(`═══ ${pl.title} (${pl.itemCount || pl.tracks?.length || 0} Tracks) ═══`, [255, 0, 51]));
      if (pl.tracks) {
        for (let i = 0; i < pl.tracks.length; i++) {
          const t = pl.tracks[i];
          const dur = t.durationMs ? ` (${formatDuration(Math.floor(t.durationMs / 1000))})` : '';
          console.log(`  ${pad(String(i + 1), 3, 'right')}. ${ANSI.BOLD}${t.title}${ANSI.RESET} - ${t.artist}${dur} [${t.id}]`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(colorText(`Error: ${msg}`, [255, 100, 100]));
    }
    return;
  }

  if (sub === 'play') {
    const plId = args[1] || 'LM';
    console.log(colorText(`⟳ Loading playlist ${plId} for playback...`, [255, 0, 51]));
    try {
      const pl = await getYtPlaylist(plId);
      if (pl.tracks && pl.tracks.length > 0) {
        const firstTrack = pl.tracks[0];
        const song = await fetchSongDetails({
          id: firstTrack.id,
          title: firstTrack.title,
          artist: firstTrack.artist,
          duration: Math.floor(firstTrack.durationMs / 1000),
          hasSynced: false,
          source: 'youtube',
          thumbnailUrl: firstTrack.thumbnailUrl,
        });

        if (song) {
          launchInteractiveApp(flags, { initialSong: song, autoPlay: true, startView: 'karaoke' });
          return;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(colorText(`Error: ${msg}`, [255, 100, 100]));
    }
  }
}

/**
 * Handles `lyrical library`
 */
async function handleLibraryCommand(args: string[], flags: Record<string, string | boolean | number>): Promise<void> {
  if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    launchInteractiveApp(flags, { startView: 'playlists', autoPlay: false });
    return;
  }
  await handlePlaylistCommand(['list', ...args], flags);
}

/**
 * Handles `lyrical explore` / `charts` / `trending`
 */
async function handleExploreCommand(flags: Record<string, string | boolean | number>): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    launchInteractiveApp(flags, { startView: 'explore', autoPlay: false });
    return;
  }

  console.log(colorText('═══ YouTube Music Explore & Trending ═══', [255, 0, 51]));
  console.log(colorText('⟳ Fetching top charts & trending categories...', [255, 0, 51]));

  try {
    const feed = await getExploreFeed();
    if (feed.length === 0) {
      console.log(colorText('No explore categories available.', [200, 200, 200]));
      return;
    }

    for (const cat of feed) {
      console.log('');
      console.log(`${ANSI.BOLD}${colorText(`[ ${cat.title.toUpperCase()} ]`, [255, 215, 0])}${ANSI.RESET}`);
      for (const item of cat.items.slice(0, 6)) {
        const sub = item.subtitle ? ` - ${item.subtitle}` : '';
        const badge = colorText(`[${item.type}]`, [30, 215, 96]);
        console.log(`   * ${badge} ${ANSI.BOLD}${item.title}${ANSI.RESET}${sub} (${item.id})`);
      }
    }

    console.log('');
    console.log(colorText('Tip: Play any item with `resonate play <id>`', [255, 215, 0]));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(colorText(`Error: ${message}`, [255, 100, 100]));
  }
}

async function runSearchCli(query: string, flags: Record<string, string | boolean | number>): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    launchInteractiveApp(flags, {
      startView: 'search',
      initialSearchQuery: query.trim() || undefined,
      autoPlay: false,
    });
    return;
  }

  if (!query.trim()) {
    console.log(colorText('Error: provide a search query when not attached to a TTY. Example: resonate search "Queen"', [255, 100, 100]));
    process.exit(1);
  }

  console.log(colorText(`⟳ Searching YouTube Music & LRCLIB for "${query}"...`, [255, 0, 51]));
  const results = await searchLyrics(query);

  if (results.length === 0) {
    console.log(colorText('✕ No matches found.', [255, 100, 100]));
    return;
  }

  console.log('');
  console.log(colorText(`Found ${results.length} result(s):`, [30, 215, 96], true));
  console.log(colorText('─'.repeat(70), [80, 80, 80]));

  for (let i = 0; i < Math.min(15, results.length); i++) {
    const r = results[i];
    const num = colorText(pad(String(i + 1), 2, 'right'), [255, 215, 0]);
    const src = r.source === 'youtube' ? colorText('YT ', [255, 50, 50]) : colorText('LRC', [30, 215, 96]);
    const title = `${ANSI.BOLD}${r.title}${ANSI.RESET}`;
    const artist = colorText(`by ${r.artist}`, [180, 180, 180]);
    const dur = r.duration ? colorText(`(${formatDuration(r.duration)})`, [120, 120, 120]) : '';
    console.log(` ${num}. [${src}] ${title} ${artist} ${dur}`);
  }

  console.log(colorText('─'.repeat(70), [80, 80, 80]));
}

async function runGetCli(query: string): Promise<void> {
  const results = await searchLyrics(query);
  if (results.length === 0) {
    console.error(`No lyrics found for "${query}"`);
    process.exit(1);
  }

  const song = await fetchSongDetails(results[0]);
  if (!song) {
    console.error(`Could not retrieve lyrics content for "${query}"`);
    process.exit(1);
  }

  for (const line of song.lyrics) {
    const timeStr = `[${formatDuration(Math.floor(line.startMs / 1000))}]`;
    console.log(`${timeStr} ${line.text}`);
  }
}

async function confirmYes(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
  });
  rl.close();
  const t = answer.trim().toLowerCase();
  return t === 'y' || t === 'yes';
}

async function handleDownloadsCommand(args: string[], flags: Record<string, string | boolean | number>): Promise<void> {
  const sub = args[0]?.toLowerCase();
  void upgradeDownloadedLibrary();

  if (!sub || sub === 'open' || sub === 'ui') {
    launchInteractiveApp(flags, { startView: 'downloads', autoPlay: false });
    return;
  }

  if (sub === 'list') {
    const songs = getDownloadedSongs();
    const used = getTotalDownloadedBytes();
    const cfg = getConfig();
    console.log(colorText(`Downloaded: ${songs.length}  ${formatBytes(used)} / ${formatStorageLimit(cfg.maxStorageBytes)}  auto=${cfg.autoDownload ? 'on' : 'off'}`, [255, 215, 0]));
    if (songs.length === 0) {
      console.log(colorText('  (empty)', [160, 160, 160]));
      return;
    }
    for (const s of songs) {
      console.log(`  ${s.title} - ${s.artist}  ${colorText(formatBytes(s.fileSizeBytes), [160, 160, 160])}`);
    }
    return;
  }

  if (sub === 'clear') {
    const songs = getDownloadedSongs();
    if (songs.length === 0) {
      console.log(colorText('No downloaded songs.', [160, 160, 160]));
      return;
    }
    const force = Boolean(flags['yes'] || flags['y']);
    if (!force) {
      const ok = await confirmYes(`Delete ${songs.length} downloaded song${songs.length === 1 ? '' : 's'} (${formatBytes(getTotalDownloadedBytes())})? [y/N] `);
      if (!ok) {
        console.log('Cancelled.');
        return;
      }
    }
    const n = deleteAllDownloadedSongs();
    console.log(colorText(`Deleted ${n} downloaded song${n === 1 ? '' : 's'}.`, [30, 215, 96]));
    return;
  }

  if (sub === 'auto') {
    const val = (args[1] || '').toLowerCase();
    let next: boolean;
    if (val === 'on' || val === 'true' || val === '1') next = true;
    else if (val === 'off' || val === 'false' || val === '0') next = false;
    else next = !getConfig().autoDownload;
    saveConfig({ autoDownload: next });
    console.log(colorText(`Auto-download: ${next ? 'ON' : 'OFF'}`, [30, 215, 96]));
    return;
  }

  if (sub === 'limit') {
    const raw = args[1];
    if (!raw) {
      console.log(`Download limit: ${formatStorageLimit(getConfig().maxStorageBytes)} (default 2 GB)`);
      return;
    }
    const bytes = parseStorageBytes(raw);
    if (!bytes || bytes < 512 * 1024 * 1024) {
      console.log(colorText('Error: limit must be at least 512MB. Example: resonate downloads limit 2G', [255, 100, 100]));
      process.exit(1);
    }
    saveConfig({ maxStorageBytes: bytes });
    console.log(colorText(`Download limit: ${formatStorageLimit(bytes)}`, [30, 215, 96]));
    return;
  }

  console.log(colorText('Usage: resonate downloads [list|clear|auto|limit|open]', [255, 100, 100]));
}

function printThemes(): void {
  console.log(colorText('═══ Available Color Themes ═══', [255, 0, 51]));
  for (const t of Object.values(THEMES)) {
    const badge = `${t.icon} ${t.name}`;
    const desc = colorText(`- ${t.description}`, [160, 160, 160]);
    console.log(`  ${ANSI.BOLD}${pad(t.id, 12)}${ANSI.RESET} ${badge} ${desc}`);
  }
  console.log('');
  console.log('Use with: resonate --theme <name>');
}

function printVersion(): void {
  console.log('Resonate YouTube Music CLI v1.2.5');
}

function printHelp(): void {
  console.log(`
${ANSI.BOLD}${gradientText('  RESONATE - YouTube Music Terminal Player & Lyrics CLI  ', [[255, 0, 51], [255, 100, 100], [255, 215, 0]], true)}${ANSI.RESET}

${ANSI.BOLD}USAGE:${ANSI.RESET}
  resonate "We Don't Talk Anymore"
  resonate play "<query|url>"

${ANSI.BOLD}COMMANDS:${ANSI.RESET}
  ${colorText('resonate "We Don\'t Talk Anymore"', [255, 215, 0])}  Search and play immediately
  ${colorText('resonate search [query]', [255, 215, 0])}          Open TUI search with dropdown suggestions
  ${colorText('resonate playlist [list|show|play]', [255, 215, 0])} Browse playlists (TUI if no subcommand)
  ${colorText('resonate library', [255, 215, 0])}                 Open library / Liked Songs TUI
  ${colorText('resonate charts / explore', [255, 215, 0])}        Open Top Charts & Trending TUI
  ${colorText('resonate auth <login|status|logout>', [255, 215, 0])} Manage YouTube Music authentication
  ${colorText('resonate get <query>', [255, 215, 0])}             Dump synchronized LRC lyrics to stdout
  ${colorText('resonate downloads [list|clear|auto|limit]', [255, 215, 0])} Offline library
  ${colorText('resonate themes', [255, 215, 0])}                  List all available TrueColor themes


${ANSI.BOLD}OPTIONS:${ANSI.RESET}
  ${colorText('--theme, -t <name>', [30, 215, 96])}          Set visual theme (ytmusic, spotify, cyberpunk, nord, tokyonight, etc.)
  ${colorText('--speed <multiplier>', [30, 215, 96])}        Set playback speed (e.g. 1.25, 0.75)
  ${colorText('--browser <name>', [30, 215, 96])}            Browser for cookie import (chrome, firefox, brave, edge)
  ${colorText('--help, -h', [30, 215, 96])}                  Show this help message
  ${colorText('--version, -v', [30, 215, 96])}               Show version
${ANSI.BOLD}SEARCH TUI:${ANSI.RESET}
  ${colorText('Type', [255, 215, 0])}         Filter live results; typed text appears in the search field
  ${colorText('↑ / ↓', [255, 215, 0])}        Move through suggestions and results
  ${colorText('Enter', [255, 215, 0])}        Accept a suggestion or play the highlighted track
  ${colorText('Tab', [255, 215, 0])}          Cycle category (all / song / album / playlist / video)
  ${colorText('Ctrl+U', [255, 215, 0])}       Clear the search field
  ${colorText('Esc', [255, 215, 0])}          Close search and return to the player

${ANSI.BOLD}PLAYER CONTROLS:${ANSI.RESET}
  ${colorText('Space', [255, 215, 0])}       Play / Pause music & synchronized lyrics
  ${colorText('← / →', [255, 215, 0])}       Seek backward / forward by 5s (Shift: 15s)
  ${colorText('↑ / ↓', [255, 215, 0])}       Volume up / down by 5%
  ${colorText('0 / Home', [255, 215, 0])}     Restart track from beginning (0:00)
  ${colorText('N / B', [255, 215, 0])}       Next / Previous track in queue or playlist
  ${colorText('O', [255, 215, 0])}           Toggle loop of current track
  ${colorText('X', [255, 215, 0])}           Toggle shuffle for upcoming queue
  ${colorText('U', [255, 215, 0])}           Toggle mute on / off
  ${colorText(', / .', [255, 215, 0])}       Adjust playback speed (-0.25x / +0.25x)
  ${colorText('D', [255, 215, 0])}           Open downloaded songs manager
  ${colorText('/ or S', [255, 215, 0])}      Open live YouTube Music search
  ${colorText('P or L', [255, 215, 0])}      Open Playlists & Library
  ${colorText('Q', [255, 215, 0])}           Open Playback Queue & Up Next (d: delete)
  ${colorText('E', [255, 215, 0])}           Open Explore & Trending
  ${colorText('R or M', [255, 215, 0])}      Toggle Full Reading lyrics mode (PgUp/PgDn: scroll)
  ${colorText('V', [255, 215, 0])}           Cycle audio visualizers (Bars, Wave, Flame, etc.)
  ${colorText('T / Shift+T', [255, 215, 0])} Cycle TrueColor themes (Next / Previous)
  ${colorText('A', [255, 215, 0])}           Toggle Album Art display on / off
  ${colorText('I', [255, 215, 0])}           Toggle Timestamps on lyric lines on / off
  ${colorText('[ / ]', [255, 215, 0])}       Adjust audio/lyrics sync offset (-100ms / +100ms)
  ${colorText('? or H', [255, 215, 0])}      Show in-app help modal
  ${colorText('Esc / Ctrl+C', [255, 215, 0])} Close active modal / Return / Exit
`);
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
