// Visual worlds for routes. Sizes in `layers` are fractions of the screen height.

const MEADOW_OAK = { trunk: '#6b4a2f', dark: '#3d7a35', mid: '#58a03f', light: '#7dc04f' };
const PINE = { trunk: '#5b3f28', dark: '#2b5e34', light: '#3c7a40' };
const ROCK = { base: '#9aa0a3', light: '#b9bec0', crack: 'rgba(80,86,90,0.6)' };
const BUSH = { dark: '#3f7d36', mid: '#5ea343' };
const FLOWERS = { blades: ['#5c9a3a', '#79b445'], colors: ['#f5f5f0', '#f7c62f', 'lupine', '#f5f5f0', '#f0a83a'] };
const FENCE = { wood: [138, 98, 62], dark: [96, 66, 40], prob: 0.7 };

const base = {
  sky: ['#3f93dc', '#d6ecf8'],
  fog: [214, 234, 240],
  grass: [[150, 196, 82], [143, 190, 78]],
  verge: [[126, 176, 70], [120, 170, 66]],
  road: [[74, 78, 86], [70, 74, 82]],
  line: [244, 244, 240],
  clouds: 5,
  fence: FENCE,
  palette: { oak: MEADOW_OAK, pine: PINE, rock: ROCK, bush: BUSH, flowers: FLOWERS, birch: { dark: '#5d9a3c', mid: '#86bf4f', light: '#b4d96a' } },
  layers: [
    { base: '#9fc0cf', top: '#8fb3c8', amp: 0.2, freq: 3 },
    { base: '#5f9a63', top: '#5b8f6c', amp: 0.12, freq: 5, trees: { color: '#3f7450', density: 0.85, size: 0.035 } },
    { base: '#93c25a', top: '#86b85a', amp: 0.07, freq: 4, trees: { color: '#2f6a3a', density: 0.45, size: 0.05 } },
  ],
  scenery: [
    { type: 'flowers', prob: 0.45, off: [1.12, 1.62] },
    { type: 'rock', prob: 0.05, off: [1.4, 2.8] },
    { type: 'bush', prob: 0.06, off: [1.6, 3.6] },
    { type: 'oak', prob: 0.066, off: [1.9, 6.9] },
    { type: 'pine', prob: 0.054, off: [1.9, 6.9] },
  ],
  accent: '#7dc04f',
};

const theme = (over) => ({ ...base, ...over, palette: { ...base.palette, ...(over.palette || {}) } });

export const THEMES = {
  meadow: base,

  river: theme({
    accent: '#5fb7e8',
    fence: { ...FENCE, prob: 0.35 },
    layers: [
      { base: '#a9c8d6', top: '#9cbdd0', amp: 0.12, freq: 2 },
      { base: '#6aa36a', top: '#629a6c', amp: 0.08, freq: 4, trees: { color: '#447a52', density: 0.9, size: 0.03 } },
      { kind: 'sea', color: '#5aa9d6', light: '#8fd0f0', height: 0.025 },
    ],
    scenery: [
      { type: 'flowers', prob: 0.35, off: [1.12, 1.62] },
      { type: 'birch', prob: 0.11, off: [1.8, 6] },
      { type: 'bush', prob: 0.08, off: [1.5, 3.5] },
      { type: 'oak', prob: 0.03, off: [2.5, 7] },
    ],
  }),

  steppe: theme({
    accent: '#f7c62f',
    sky: ['#2f86d6', '#dcefff'],
    grass: [[168, 186, 78], [160, 180, 74]],
    verge: [[136, 166, 66], [130, 160, 62]],
    fence: null,
    clouds: 7,
    layers: [
      { base: '#b6cfd8', top: '#a9c6d2', amp: 0.04, freq: 2 },
      { base: '#a8b84e', top: '#9cb04c', amp: 0.035, freq: 3, trees: { color: '#4f7a3a', density: 0.25, size: 0.02 } },
      { base: '#e3bf2e', top: '#d9b42c', amp: 0.02, freq: 5 },
    ],
    scenery: [
      { type: 'sunflowers', prob: 0.95, off: [1.2, 2.2] },
      { type: 'sunflowers', prob: 0.9, off: [2.4, 4.5] },
      { type: 'sunflowers', prob: 0.8, off: [4.6, 9] },
      { type: 'oak', prob: 0.012, off: [9, 14] },
    ],
  }),

  coast: theme({
    accent: '#3fb8c9',
    sky: ['#2f9ae0', '#e2f4fb'],
    grass: [[226, 204, 150], [220, 198, 144]],
    verge: [[206, 184, 132], [200, 178, 126]],
    fence: null,
    palette: { bush: { dark: '#4f8a3c', mid: '#74ad4c' } },
    layers: [
      { base: '#a7c9d8', top: '#9ac0d2', amp: 0.08, freq: 2 },
      { kind: 'sea', color: '#1f8fc4', light: '#7fd6f2', height: 0.06 },
    ],
    ground: '#e2cc96',
    scenery: [
      { type: 'palm', prob: 0.12, off: [1.6, 5] },
      { type: 'bush', prob: 0.06, off: [1.3, 3] },
      { type: 'rock', prob: 0.05, off: [1.4, 4] },
    ],
  }),

  autumn: theme({
    accent: '#e2832f',
    sky: ['#5b9bd0', '#f0e6d2'],
    fog: [236, 226, 206],
    grass: [[176, 168, 84], [168, 160, 78]],
    verge: [[150, 138, 70], [144, 132, 66]],
    palette: {
      oak: { trunk: '#5e3f27', dark: '#a4481f', mid: '#d9752b', light: '#f2b33d' },
      bush: { dark: '#9a5524', mid: '#c97b32' },
      flowers: { blades: ['#8f9a3a', '#a9ad48'], colors: ['#f0a83a', '#d9752b', '#f7c62f'] },
      birch: { dark: '#c98a2a', mid: '#e8b33c', light: '#f6d36a' },
    },
    layers: [
      { base: '#b9b6c4', top: '#aaa8bb', amp: 0.18, freq: 3 },
      { base: '#a8743a', top: '#9b6b38', amp: 0.12, freq: 5, trees: { color: '#8a4a22', density: 0.85, size: 0.035 } },
      { base: '#b59a46', top: '#a88e42', amp: 0.07, freq: 4, trees: { color: '#c0622a', density: 0.5, size: 0.05 } },
    ],
    scenery: [
      { type: 'flowers', prob: 0.25, off: [1.12, 1.62] },
      { type: 'oak', prob: 0.13, off: [1.8, 6] },
      { type: 'birch', prob: 0.06, off: [1.8, 6] },
      { type: 'bush', prob: 0.06, off: [1.5, 3.5] },
      { type: 'pine', prob: 0.03, off: [3, 7] },
    ],
  }),

  sunset: theme({
    accent: '#ff8a5c',
    sky: ['#3e4f9a', '#ffb38a'],
    fog: [250, 190, 160],
    sun: { color: '#ffe29a', glow: 'rgba(255,200,120,0.45)', x: 0.62, r: 0.05 },
    clouds: 3,
    grass: [[132, 160, 72], [126, 154, 68]],
    verge: [[110, 140, 62], [104, 134, 58]],
    road: [[70, 68, 82], [66, 64, 78]],
    layers: [
      { base: '#b88aa8', top: '#a07aa0', amp: 0.18, freq: 3 },
      { base: '#7d6a8e', top: '#706186', amp: 0.12, freq: 5, trees: { color: '#594a70', density: 0.8, size: 0.035 } },
      { base: '#6f8a52', top: '#64804e', amp: 0.07, freq: 4, trees: { color: '#3e5a3a', density: 0.45, size: 0.05 } },
    ],
  }),

  winter: theme({
    accent: '#bcd7ea',
    sky: ['#8fb0cc', '#eef2f6'],
    fog: [236, 241, 246],
    snowfall: true,
    clouds: 2,
    grass: [[238, 242, 247], [230, 236, 243]],
    verge: [[214, 222, 232], [208, 216, 228]],
    road: [[92, 96, 104], [86, 90, 98]],
    fence: { wood: [118, 88, 62], dark: [86, 62, 42], prob: 0.4 },
    palette: {
      pine: { trunk: '#4e3726', dark: '#25503a', light: '#33664a', snow: '#ffffff' },
      rock: { base: '#a7aeb5', light: '#f4f7fa', crack: 'rgba(90,96,104,0.5)' },
      bush: { dark: '#c8d3de', mid: '#f1f5f9' },
    },
    layers: [
      { base: '#c4d2de', top: '#b3c4d3', amp: 0.2, freq: 3, snow: true },
      { base: '#8aa3b0', top: '#7c98a8', amp: 0.12, freq: 5, trees: { color: '#3d5f55', density: 0.9, size: 0.04 } },
      { base: '#e6edf3', top: '#dde6ee', amp: 0.06, freq: 4, trees: { color: '#2f5446', density: 0.5, size: 0.05 } },
    ],
    ground: '#e6edf3',
    scenery: [
      { type: 'pine', prob: 0.16, off: [1.7, 7] },
      { type: 'rock', prob: 0.04, off: [1.4, 3] },
      { type: 'bush', prob: 0.05, off: [1.4, 3] },
    ],
  }),

  desert: theme({
    accent: '#d9653a',
    sky: ['#3b8fd6', '#f6e3c4'],
    fog: [242, 222, 196],
    clouds: 2,
    grass: [[214, 170, 112], [208, 164, 106]],
    verge: [[196, 150, 96], [190, 144, 92]],
    road: [[84, 76, 76], [80, 72, 72]],
    fence: null,
    palette: { rock: { base: '#b5583a', light: '#d9805a', crack: 'rgba(110,40,24,0.5)' }, bush: { dark: '#7b8a4a', mid: '#9aa95a' } },
    layers: [
      { base: '#d9a88a', top: '#cf9d82', amp: 0.16, freq: 3, flat: 0.75 },
      { base: '#c0603e', top: '#b0553a', amp: 0.12, freq: 4, flat: 0.7 },
      { base: '#d49a62', top: '#ca905c', amp: 0.05, freq: 6 },
    ],
    ground: '#d6aa70',
    scenery: [
      { type: 'cactus', prob: 0.07, off: [1.5, 6] },
      { type: 'rock', prob: 0.08, off: [1.4, 6] },
      { type: 'bush', prob: 0.06, off: [1.3, 4] },
    ],
  }),

  carpathians: theme({
    accent: '#3f9a5c',
    sky: ['#4a92d4', '#dcecf4'],
    fence: { ...FENCE, prob: 0.6 },
    layers: [
      { base: '#88a9a0', top: '#7c9e98', amp: 0.24, freq: 4, trees: { color: '#5d8578', density: 0.7, size: 0.03 } },
      { base: '#4d8a5a', top: '#457e54', amp: 0.16, freq: 6, trees: { color: '#2f6440', density: 0.95, size: 0.045 } },
      { base: '#86b85a', top: '#7aaf56', amp: 0.08, freq: 5, trees: { color: '#24553a', density: 0.6, size: 0.06 } },
    ],
    scenery: [
      { type: 'pine', prob: 0.16, off: [1.8, 7] },
      { type: 'flowers', prob: 0.3, off: [1.12, 1.62] },
      { type: 'rock', prob: 0.05, off: [1.4, 3] },
      { type: 'oak', prob: 0.03, off: [2.5, 7] },
    ],
  }),

  alpine: theme({
    accent: '#8fb3d9',
    sky: ['#2f80d0', '#d8ebf8'],
    fog: [220, 234, 244],
    fence: { ...FENCE, prob: 0.3 },
    grass: [[126, 176, 84], [120, 170, 80]],
    layers: [
      { base: '#9fb6cc', top: '#8aa6c0', amp: 0.3, freq: 3, snow: true },
      { base: '#6d8f88', top: '#62857f', amp: 0.16, freq: 5, trees: { color: '#3e6656', density: 0.8, size: 0.035 } },
      { base: '#86b05e', top: '#7aa65a', amp: 0.07, freq: 4, trees: { color: '#2b5a3a', density: 0.5, size: 0.05 } },
    ],
    scenery: [
      { type: 'pine', prob: 0.12, off: [1.8, 7] },
      { type: 'rock', prob: 0.1, off: [1.3, 5] },
      { type: 'flowers', prob: 0.2, off: [1.12, 1.62] },
    ],
  }),
};

export const themeFor = (id) => THEMES[id] || THEMES.meadow;
