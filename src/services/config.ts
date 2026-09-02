import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AppConfig } from '../types.js';

const DEFAULT_CONFIG: AppConfig = {
  theme: 'ytmusic',
  autoDownload: true,
  maxStorageBytes: 2 * 1024 * 1024 * 1024,
};

let cachedConfig: AppConfig | null = null;

export function getConfigDir(): string {
  return process.env.RESONATE_CONFIG_DIR || path.join(os.homedir(), '.config', 'resonate');
}

function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;
  try {
    const file = getConfigFile();
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      cachedConfig = {
        theme: typeof raw.theme === 'string' && raw.theme ? raw.theme : DEFAULT_CONFIG.theme,
        autoDownload: typeof raw.autoDownload === 'boolean' ? raw.autoDownload : DEFAULT_CONFIG.autoDownload,
        maxStorageBytes:
          typeof raw.maxStorageBytes === 'number' && raw.maxStorageBytes > 0
            ? raw.maxStorageBytes
            : DEFAULT_CONFIG.maxStorageBytes,
      };
      return cachedConfig;
    }
  } catch {
    // Fallback to defaults
  }
  cachedConfig = { ...DEFAULT_CONFIG };
  return cachedConfig;
}

export function saveConfig(cfg: Partial<AppConfig>): AppConfig {
  ensureConfigDir();
  const current = loadConfig();
  cachedConfig = {
    ...current,
    ...cfg,
  };
  try {
    fs.writeFileSync(getConfigFile(), JSON.stringify(cachedConfig, null, 2), { mode: 0o600 });
  } catch {
    // Ignore write failure
  }
  return cachedConfig;
}

export function getConfig(): AppConfig {
  return loadConfig();
}

export function setConfigValue<K extends keyof AppConfig>(key: K, value: AppConfig[K]): AppConfig {
  return saveConfig({ [key]: value });
}

export function parseStorageBytes(input: string): number | null {
  const s = String(input || '').trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|k|m|g|t)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2] || 'gb';
  const mult: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
  };
  return Math.floor(n * (mult[unit] || 1024 ** 3));
}

export function formatStorageLimit(bytes: number): string {
  if (bytes >= 1024 ** 3 && bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3} GB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${bytes} B`;
}
