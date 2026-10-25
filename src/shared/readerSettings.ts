import { DEFAULT_SETTINGS, type Settings } from "./types";
import { normalizeNetworkProxy } from "./networkProxy";
import {
  nearestReaderTheme,
  READER_THEME_IDS,
  type ReaderFont,
  type ReaderTheme,
} from "./readerColors";

type LegacySettings = Partial<Settings> & {
  readerBackgroundColor?: unknown;
  readerWidth?: unknown;
};

const READER_FONTS = ["serif", "sans", "kai"] as const;
const MODES = ["scroll", "paged"] as const;

export function normalizeReaderSettings(input: LegacySettings) {
  const background = input.readerBackgroundColor;
  const requestedPadding = Number(input.readerPadding);
  let readerTheme: ReaderTheme = "paper";
  if (typeof background === "string") {
    if (/^#[0-9a-f]{6}$/i.test(background)) {
      readerTheme = nearestReaderTheme(background.toLowerCase());
    }
  } else if (READER_THEME_IDS.includes(input.readerTheme as ReaderTheme)) {
    readerTheme = input.readerTheme as ReaderTheme;
  } else if (input.readerTheme === "dark") {
    readerTheme = "dark";
  }

  return {
    readerTheme,
    readerMode: MODES.includes(input.readerMode as (typeof MODES)[number])
      ? input.readerMode!
      : DEFAULT_SETTINGS.readerMode,
    readerFont: READER_FONTS.includes(input.readerFont as ReaderFont)
      ? input.readerFont!
      : DEFAULT_SETTINGS.readerFont,
    fontSize: Math.max(14, Math.min(32, Number(input.fontSize) || 20)),
    lineHeight: Math.max(1.4, Math.min(2.6, Number(input.lineHeight) || 1.9)),
    readerPadding: Number.isFinite(requestedPadding)
      ? Math.max(2, Math.min(12, requestedPadding))
      : DEFAULT_SETTINGS.readerPadding,
  };
}

export function normalizeStoredSettings(input: unknown): Settings {
  const stored =
    input && typeof input === "object" ? (input as LegacySettings) : {};
  const {
    readerBackgroundColor: _legacyBackground,
    readerWidth: _legacyWidth,
    ...current
  } = stored;
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    ...normalizeReaderSettings(stored),
    networkProxy: normalizeNetworkProxy(stored.networkProxy),
    theme: stored.theme === "light" ? "light" : "dark",
  } as Settings;
}
