export * from './types.js';
export * from './parser/lrc.js';
export * from './engine/player.js';
export * from './engine/audioBackend.js';
export * from './engine/visualizer.js';
export * from './ui/themes.js';
export * from './ui/renderer.js';
export * from './services/lyricsApi.js';
export * from './services/ytmusic.js';
export * from './services/auth.js';
export * from './services/albumArt.js';
export * from './app.js';
export * from './cli.js';
import { runCli } from './cli.js';

// Auto-run if executed as main entry
runCli(process.argv.slice(2)).catch((err) => {
  console.error('Lyrical error:', err);
  process.exit(1);
});
