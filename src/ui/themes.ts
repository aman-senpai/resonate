import { RGB, Theme } from '../types.js';

export const THEMES: Record<string, Theme> = {
  cyberpunk: {
    id: 'cyberpunk',
    name: 'Cyberpunk Neon',
    icon: '✦',
    description: 'Electric neon cyan, hot pink and high-voltage yellow',
    primary: [0, 240, 255], // #00F0FF Electric Cyan
    secondary: [255, 0, 127], // #FF007F Hot Pink
    accent: [255, 230, 0], // #FFE600 Neon Yellow
    highlight: [255, 255, 255],
    activeLine: [0, 255, 234],
    dimmed: [90, 100, 130],
    subtle: [50, 60, 85],
    text: [230, 240, 255],
    background: [10, 12, 20],
    visualizer: [
      [0, 240, 255],
      [50, 200, 255],
      [150, 100, 255],
      [220, 50, 200],
      [255, 0, 127],
      [255, 120, 0],
      [255, 230, 0],
    ],
    border: [0, 200, 220],
    badge: {
      bg: [255, 0, 127],
      fg: [255, 255, 255],
    },
    gradient: [
      [0, 240, 255],
      [180, 80, 255],
      [255, 0, 127],
      [255, 200, 0],
    ],
  },

  tokyonight: {
    id: 'tokyonight',
    name: 'Tokyo Night',
    icon: '✦',
    description: 'Deep midnight indigo, soft lavender and luminous sky blue',
    primary: [122, 162, 247], // #7AA2F7 Indigo
    secondary: [187, 154, 247], // #BB9AF7 Soft Lavender
    accent: [125, 207, 255], // #7DCFFF Sky Blue
    highlight: [255, 255, 255],
    activeLine: [157, 218, 255],
    dimmed: [86, 95, 137],
    subtle: [48, 54, 82],
    text: [192, 202, 245],
    background: [26, 27, 38],
    visualizer: [
      [122, 162, 247],
      [125, 207, 255],
      [187, 154, 247],
      [247, 118, 142],
      [224, 175, 104],
      [158, 206, 106],
    ],
    border: [122, 162, 247],
    badge: {
      bg: [187, 154, 247],
      fg: [26, 27, 38],
    },
    gradient: [
      [122, 162, 247],
      [187, 154, 247],
      [247, 118, 142],
    ],
  },

  sunset: {
    id: 'sunset',
    name: 'Sunset Horizon',
    icon: '◆',
    description: 'Fiery coral pink, golden amber and warm dusk purple',
    primary: [255, 99, 71], // Tomato Red / Coral
    secondary: [255, 165, 0], // Golden Orange
    accent: [255, 215, 0], // Bright Gold
    highlight: [255, 250, 240],
    activeLine: [255, 140, 60],
    dimmed: [120, 80, 100],
    subtle: [70, 45, 60],
    text: [255, 235, 225],
    background: [24, 14, 24],
    visualizer: [
      [255, 69, 0],
      [255, 99, 71],
      [255, 140, 0],
      [255, 165, 0],
      [255, 215, 0],
      [255, 105, 180],
    ],
    border: [255, 140, 0],
    badge: {
      bg: [255, 99, 71],
      fg: [255, 255, 255],
    },
    gradient: [
      [255, 69, 0],
      [255, 140, 0],
      [255, 215, 0],
    ],
  },

  nord: {
    id: 'nord',
    name: 'Nord Aurora',
    icon: '❄',
    description: 'Arctic frost turquoise, polar blue and glowing aurora mint',
    primary: [136, 192, 208], // Frost Blue
    secondary: [143, 188, 187], // Frost Teal
    accent: [163, 190, 140], // Aurora Green
    highlight: [236, 239, 244],
    activeLine: [170, 225, 240],
    dimmed: [94, 129, 172],
    subtle: [67, 76, 94],
    text: [229, 233, 240],
    background: [46, 52, 64],
    visualizer: [
      [143, 188, 187],
      [136, 192, 208],
      [129, 161, 193],
      [94, 129, 172],
      [163, 190, 140],
      [235, 203, 139],
    ],
    border: [136, 192, 208],
    badge: {
      bg: [163, 190, 140],
      fg: [46, 52, 64],
    },
    gradient: [
      [136, 192, 208],
      [129, 161, 193],
      [163, 190, 140],
    ],
  },

  matrix: {
    id: 'matrix',
    name: 'Matrix Emerald',
    icon: '❖',
    description: 'Phosphor green, cyber lime and terminal emerald',
    primary: [0, 255, 102], // Emerald Green
    secondary: [80, 250, 123], // Mint Green
    accent: [0, 200, 80],
    highlight: [220, 255, 230],
    activeLine: [120, 255, 160],
    dimmed: [30, 100, 50],
    subtle: [15, 55, 28],
    text: [200, 255, 210],
    background: [10, 18, 12],
    visualizer: [
      [0, 180, 60],
      [0, 220, 80],
      [0, 255, 102],
      [80, 250, 123],
      [140, 255, 180],
    ],
    border: [0, 255, 102],
    badge: {
      bg: [0, 255, 102],
      fg: [10, 18, 12],
    },
    gradient: [
      [0, 180, 60],
      [0, 255, 102],
      [140, 255, 180],
    ],
  },

  synthwave: {
    id: 'synthwave',
    name: 'Synthwave 80s',
    icon: '▲',
    description: 'Radical neon violet, sunset magenta and retro turquoise',
    primary: [189, 147, 249], // Purple
    secondary: [255, 121, 198], // Pink
    accent: [139, 233, 253], // Cyan
    highlight: [255, 255, 255],
    activeLine: [255, 150, 220],
    dimmed: [110, 80, 130],
    subtle: [65, 45, 80],
    text: [248, 248, 242],
    background: [34, 28, 48],
    visualizer: [
      [189, 147, 249],
      [255, 121, 198],
      [255, 85, 85],
      [255, 184, 108],
      [241, 250, 140],
      [139, 233, 253],
    ],
    border: [255, 121, 198],
    badge: {
      bg: [255, 121, 198],
      fg: [34, 28, 48],
    },
    gradient: [
      [189, 147, 249],
      [255, 121, 198],
      [139, 233, 253],
    ],
  },

  sakura: {
    id: 'sakura',
    name: 'Cherry Blossom',
    icon: '✿',
    description: 'Pastel sakura pink, soft lavender and sweet cream',
    primary: [255, 183, 197], // Cherry blossom pink
    secondary: [221, 160, 221], // Plum/Lavender
    accent: [255, 228, 225], // Misty rose
    highlight: [255, 255, 255],
    activeLine: [255, 200, 215],
    dimmed: [140, 100, 120],
    subtle: [80, 50, 70],
    text: [255, 240, 245],
    background: [30, 18, 26],
    visualizer: [
      [255, 183, 197],
      [255, 192, 203],
      [221, 160, 221],
      [218, 112, 214],
      [255, 228, 225],
    ],
    border: [255, 183, 197],
    badge: {
      bg: [255, 183, 197],
      fg: [30, 18, 26],
    },
    gradient: [
      [255, 183, 197],
      [221, 160, 221],
      [255, 228, 225],
    ],
  },

  gold: {
    id: 'gold',
    name: 'Luxury Champagne',
    icon: '★',
    description: 'Opulent champagne gold, warm bronze and obsidian slate',
    primary: [255, 215, 0], // Gold
    secondary: [255, 191, 0], // Amber
    accent: [240, 230, 140], // Khaki / Pale gold
    highlight: [255, 250, 220],
    activeLine: [255, 230, 100],
    dimmed: [120, 100, 60],
    subtle: [70, 55, 30],
    text: [250, 245, 230],
    background: [18, 16, 14],
    visualizer: [
      [205, 127, 50],
      [255, 191, 0],
      [255, 215, 0],
      [255, 235, 120],
      [240, 230, 140],
    ],
    border: [255, 215, 0],
    badge: {
      bg: [255, 215, 0],
      fg: [18, 16, 14],
    },
    gradient: [
      [205, 127, 50],
      [255, 215, 0],
      [255, 245, 180],
    ],
  },

  ytmusic: {
    id: 'ytmusic',
    name: 'YouTube Music Red',
    icon: '▶',
    description: 'Iconic crimson scarlet, vivid ruby red, and sleek deep obsidian',
    primary: [255, 0, 51], // YouTube Music Red
    secondary: [255, 68, 68], // Light Red
    accent: [255, 140, 140], // Pastel Red
    highlight: [255, 255, 255],
    activeLine: [255, 50, 75],
    dimmed: [140, 40, 50],
    subtle: [60, 20, 25],
    text: [245, 245, 245],
    background: [15, 10, 12],
    visualizer: [
      [160, 0, 30],
      [210, 10, 45],
      [255, 0, 51],
      [255, 80, 80],
      [255, 160, 160],
    ],
    border: [255, 0, 51],
    badge: {
      bg: [255, 0, 51],
      fg: [255, 255, 255],
    },
    gradient: [
      [180, 0, 35],
      [255, 0, 51],
      [255, 120, 120],
    ],
  },

  spotify: {
    id: 'spotify',
    name: 'Spotify Emerald',
    icon: '●',
    description: 'Vibrant Spotify green, mint neon, and dark onyx',
    primary: [30, 215, 96], // Spotify Green
    secondary: [29, 185, 84],
    accent: [100, 240, 150],
    highlight: [255, 255, 255],
    activeLine: [30, 225, 110],
    dimmed: [30, 100, 50],
    subtle: [15, 45, 25],
    text: [240, 240, 240],
    background: [18, 18, 18],
    visualizer: [
      [20, 120, 55],
      [29, 185, 84],
      [30, 215, 96],
      [90, 240, 145],
      [180, 255, 210],
    ],
    border: [30, 215, 96],
    badge: {
      bg: [30, 215, 96],
      fg: [0, 0, 0],
    },
    gradient: [
      [20, 130, 60],
      [30, 215, 96],
      [120, 245, 170],
    ],
  },
};

export class ThemeManager {
  private currentThemeId: string = 'cyberpunk';

  constructor(initialThemeId: string = 'cyberpunk') {
    if (THEMES[initialThemeId]) {
      this.currentThemeId = initialThemeId;
    }
  }

  public getTheme(): Theme {
    return THEMES[this.currentThemeId] || THEMES.cyberpunk;
  }

  public setTheme(id: string): boolean {
    if (THEMES[id]) {
      this.currentThemeId = id;
      return true;
    }
    return false;
  }

  public nextTheme(): Theme {
    const keys = Object.keys(THEMES);
    const currIdx = keys.indexOf(this.currentThemeId);
    const nextIdx = (currIdx + 1) % keys.length;
    this.currentThemeId = keys[nextIdx];
    return this.getTheme();
  }

  public prevTheme(): Theme {
    const keys = Object.keys(THEMES);
    const currIdx = keys.indexOf(this.currentThemeId);
    const prevIdx = (currIdx - 1 + keys.length) % keys.length;
    this.currentThemeId = keys[prevIdx];
    return this.getTheme();
  }

  public getAllThemes(): Theme[] {
    return Object.values(THEMES);
  }
}
