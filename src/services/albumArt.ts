import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { RGB } from '../types.js';

const CACHE_DIR = path.join(os.homedir(), '.config', 'lyrical', 'art-cache');

interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
}

const memoryCache = new Map<string, { lines: string[]; dominantColor: RGB; width: number; height: number }>();

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCacheKey(url: string, width: number, height: number): string {
  const hash = crypto.createHash('md5').update(`${url}_${width}x${height}`).digest('hex');
  return hash;
}

/**
 * Fetches and renders an image URL as high-fidelity TrueColor half-block ANSI lines
 */
export async function getAlbumArtAnsi(
  url: string,
  width: number,
  height: number
): Promise<{ lines: string[]; dominantColor: RGB }> {
  if (!url || width <= 0 || height <= 0) {
    return { lines: [], dominantColor: [100, 100, 100] };
  }

  const cacheKey = getCacheKey(url, width, height);
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey)!;
  }

  ensureCacheDir();
  const diskCacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
  if (fs.existsSync(diskCacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(diskCacheFile, 'utf-8'));
      memoryCache.set(cacheKey, cached);
      return cached;
    } catch {
      // Continue to re-fetch
    }
  }

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const decoded = decodeImageBuffer(buffer);
    if (!decoded) {
      return { lines: [], dominantColor: [100, 100, 100] };
    }

    const { lines, dominantColor } = renderImageToAnsi(decoded, width, height);
    const result = { lines, dominantColor, width, height };

    memoryCache.set(cacheKey, result);
    try {
      fs.writeFileSync(diskCacheFile, JSON.stringify(result));
    } catch {
      // Ignore disk write errors
    }

    return result;
  } catch {
    return { lines: [], dominantColor: [100, 100, 100] };
  }
}

function decodeImageBuffer(buf: Buffer): DecodedImage | null {
  // Check JPEG magic: 0xFF, 0xD8, 0xFF
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    try {
      const img = jpeg.decode(buf, { useTArray: true });
      return { width: img.width, height: img.height, data: img.data };
    } catch {
      // Fallback
    }
  }

  // Check PNG magic: 0x89, 0x50, 0x4E, 0x47
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    try {
      const png = PNG.sync.read(buf);
      return { width: png.width, height: png.height, data: png.data };
    } catch {
      // Fallback
    }
  }

  // Try JPEG decoder on anything else
  try {
    const img = jpeg.decode(buf, { useTArray: true });
    return { width: img.width, height: img.height, data: img.data };
  } catch {
    return null;
  }
}

function renderImageToAnsi(
  img: DecodedImage,
  targetWidth: number,
  targetHeight: number
): { lines: string[]; dominantColor: RGB } {
  const pixelHeight = targetHeight * 2;
  const pixelWidth = targetWidth;

  const lines: string[] = [];
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let totalWeight = 0;

  for (let y = 0; y < targetHeight; y++) {
    let line = '';
    const topY = y * 2;
    const botY = y * 2 + 1;

    for (let x = 0; x < pixelWidth; x++) {
      // Sample top pixel (scaled from original)
      const srcTopX = Math.min(img.width - 1, Math.floor((x / pixelWidth) * img.width));
      const srcTopY = Math.min(img.height - 1, Math.floor((topY / pixelHeight) * img.height));
      const topIdx = (srcTopY * img.width + srcTopX) * 4;

      const topR = img.data[topIdx] || 0;
      const topG = img.data[topIdx + 1] || 0;
      const topB = img.data[topIdx + 2] || 0;

      // Sample bottom pixel
      const srcBotX = Math.min(img.width - 1, Math.floor((x / pixelWidth) * img.width));
      const srcBotY = Math.min(img.height - 1, Math.floor((botY / pixelHeight) * img.height));
      const botIdx = (srcBotY * img.width + srcBotX) * 4;

      const botR = img.data[botIdx] || 0;
      const botG = img.data[botIdx + 1] || 0;
      const botB = img.data[botIdx + 2] || 0;

      // Half-block character: ▀ (top pixel is foreground, bottom is background)
      line += `\x1b[38;2;${topR};${topG};${topB}m\x1b[48;2;${botR};${botG};${botB}m▀`;

      // Accumulate color vibrancy for dominant color
      const brightness = (topR + topG + topB) / 3;
      const saturation = Math.max(topR, topG, topB) - Math.min(topR, topG, topB);
      const weight = (saturation + 10) * (brightness > 20 && brightness < 240 ? 2 : 0.5);

      totalR += topR * weight;
      totalG += topG * weight;
      totalB += topB * weight;
      totalWeight += weight;
    }

    line += '\x1b[0m';
    lines.push(line);
  }

  const domR = totalWeight > 0 ? Math.min(255, Math.round(totalR / totalWeight)) : 120;
  const domG = totalWeight > 0 ? Math.min(255, Math.round(totalG / totalWeight)) : 120;
  const domB = totalWeight > 0 ? Math.min(255, Math.round(totalB / totalWeight)) : 120;

  return { lines, dominantColor: [domR, domG, domB] };
}
