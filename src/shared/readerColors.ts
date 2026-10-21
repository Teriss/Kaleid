export const READER_THEMES = {
  clean: {
    label: "纯净",
    background: "#f7f8fa",
    foreground: "#30343b",
    panel: "#ffffff",
    muted: "#69717c",
    border: "#30343b22",
    accent: "#5d7187",
    selection: "#91afd366",
  },
  paper: {
    label: "纸色",
    background: "#eee8db",
    foreground: "#373229",
    panel: "#f5f0e7",
    muted: "#746d61",
    border: "#574a3526",
    accent: "#967b55",
    selection: "#c3a97a66",
  },
  warm: {
    label: "暖棕",
    background: "#e9ddc8",
    foreground: "#3f3327",
    panel: "#f0e6d6",
    muted: "#796a58",
    border: "#59483228",
    accent: "#986f45",
    selection: "#c59a6966",
  },
  sage: {
    label: "浅绿",
    background: "#e5ebe3",
    foreground: "#303b33",
    panel: "#eef2ec",
    muted: "#68766b",
    border: "#35483a24",
    accent: "#64836b",
    selection: "#91b69a66",
  },
  dark: {
    label: "深灰",
    background: "#202020",
    foreground: "#e8e8e8",
    panel: "#292929",
    muted: "#a3a3a3",
    border: "#ffffff20",
    accent: "#c1ab83",
    selection: "#b9a47766",
  },
  midnight: {
    label: "墨蓝",
    background: "#1c2634",
    foreground: "#e6edf5",
    panel: "#263344",
    muted: "#a8b7ca",
    border: "#d8e4f522",
    accent: "#92b5dc",
    selection: "#88aeda66",
  },
} as const;

export type ReaderTheme = keyof typeof READER_THEMES;
export const READER_THEME_IDS = Object.keys(READER_THEMES) as ReaderTheme[];
export const READER_FONTS = {
  serif: {
    label: "宋体",
    family: '"Songti SC", SimSun, "Noto Serif CJK SC", serif',
  },
  sans: {
    label: "黑体",
    family:
      '"Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  },
  kai: { label: "楷体", family: '"Kaiti SC", KaiTi, "STKaiti", serif' },
} as const;
export type ReaderFont = keyof typeof READER_FONTS;

export function readerColors(theme: ReaderTheme | string) {
  return READER_THEMES[theme as ReaderTheme] ?? READER_THEMES.paper;
}

function linearize(channel: number) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = hex
    .match(/[0-9a-f]{2}/gi)!
    .map((value) => linearize(parseInt(value, 16)));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function nearestReaderTheme(background: string): ReaderTheme {
  const candidate = toOklab(background);
  return READER_THEME_IDS.reduce((nearest, theme) => {
    const current = toOklab(READER_THEMES[theme].background);
    const distance = candidate.reduce(
      (total, channel, index) => total + (channel - current[index]) ** 2,
      0,
    );
    const prior = toOklab(READER_THEMES[nearest].background);
    const priorDistance = candidate.reduce(
      (total, channel, index) => total + (channel - prior[index]) ** 2,
      0,
    );
    return distance < priorDistance ? theme : nearest;
  }, READER_THEME_IDS[0]);
}

export function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, blue] = hex
      .match(/[0-9a-f]{2}/gi)!
      .map((value) => linearize(parseInt(value, 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * blue;
  };
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
