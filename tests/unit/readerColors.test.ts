import { describe, expect, it } from "vitest";
import {
  contrast,
  readerColors,
  READER_THEME_IDS,
} from "../../src/shared/readerColors";
import { normalizeStoredSettings } from "../../src/shared/readerSettings";

describe("reader presets", () => {
  it("keeps every preset's text at readable contrast", () => {
    for (const theme of READER_THEME_IDS) {
      const palette = readerColors(theme);
      expect(
        contrast(palette.background, palette.foreground),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("maps legacy paper, night and custom backgrounds to complete presets", () => {
    expect(
      normalizeStoredSettings({
        readerTheme: "paper",
        readerBackgroundColor: "#eee8db",
      }).readerTheme,
    ).toBe("paper");
    expect(
      normalizeStoredSettings({
        readerTheme: "paper",
        readerBackgroundColor: "#202020",
      }).readerTheme,
    ).toBe("dark");
    expect(
      normalizeStoredSettings({
        readerTheme: "dark",
        readerBackgroundColor: "#e9ddc8",
      }).readerTheme,
    ).toBe("warm");
    expect(
      normalizeStoredSettings({
        readerTheme: "dark",
        readerBackgroundColor: "invalid",
      }).readerTheme,
    ).toBe("paper");
  });

  it("preserves typography and migrates fixed width to responsive padding", () => {
    const settings = normalizeStoredSettings({
      readerTheme: "paper",
      readerBackgroundColor: "#202020",
      readerMode: "paged",
      fontSize: 26,
      lineHeight: 2.1,
      readerWidth: 920,
      comicMode: "double",
    });
    expect(settings).toMatchObject({
      readerTheme: "dark",
      readerMode: "paged",
      readerFont: "serif",
      fontSize: 26,
      lineHeight: 2.1,
      readerPadding: 6,
      comicMode: "double",
    });
    expect(settings).not.toHaveProperty("readerBackgroundColor");
    expect(settings).not.toHaveProperty("readerWidth");
  });

  it("clamps responsive reading padding", () => {
    expect(normalizeStoredSettings({ readerPadding: 2 }).readerPadding).toBe(2);
    expect(normalizeStoredSettings({ readerPadding: 15 }).readerPadding).toBe(
      12,
    );
    expect(
      normalizeStoredSettings({ readerPadding: "invalid" }).readerPadding,
    ).toBe(6);
  });
});
