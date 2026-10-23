import { Check, RotateCcw } from "lucide-react";
import type { CSSProperties } from "react";
import { DEFAULT_SETTINGS } from "../../shared/types";
import {
  READER_FONTS,
  READER_THEME_IDS,
  readerColors,
} from "../../shared/readerColors";
import { act, useApp } from "./store";

export default function ReaderPreferences({
  compact = false,
  hideMode = false,
}: {
  compact?: boolean;
  hideMode?: boolean;
}) {
  const { settings, setSettings } = useApp();
  const update = (patch: Partial<typeof settings>) =>
    void act(() => setSettings({ ...settings, ...patch }));
  const reset = () =>
    update({
      readerTheme: DEFAULT_SETTINGS.readerTheme,
      readerMode: DEFAULT_SETTINGS.readerMode,
      readerFont: DEFAULT_SETTINGS.readerFont,
      fontSize: DEFAULT_SETTINGS.fontSize,
      lineHeight: DEFAULT_SETTINGS.lineHeight,
      readerPadding: DEFAULT_SETTINGS.readerPadding,
    });

  return (
    <div className={`reader-preferences ${compact ? "compact" : ""}`}>
      <section className="reader-pref-section">
        <div className="reader-pref-heading">
          <div>
            <strong>阅读主题</strong>
            <span>背景与文字已为舒适阅读搭配</span>
          </div>
        </div>
        <div
          className="reader-theme-grid"
          role="radiogroup"
          aria-label="阅读主题"
        >
          {READER_THEME_IDS.map((id) => {
            const palette = readerColors(id);
            const active = settings.readerTheme === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={palette.label}
                className={`reader-theme-card ${active ? "selected" : ""}`}
                style={
                  {
                    "--sample-bg": palette.background,
                    "--sample-fg": palette.foreground,
                    "--sample-muted": palette.muted,
                    "--sample-accent": palette.accent,
                  } as CSSProperties
                }
                onClick={() => update({ readerTheme: id })}
              >
                <span className="reader-theme-sample">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="reader-theme-name">{palette.label}</span>
                {active && <Check className="reader-theme-check" size={14} />}
              </button>
            );
          })}
        </div>
      </section>

      <section className="reader-pref-section reader-pref-layout">
        <div className="reader-pref-heading">
          <div>
            <strong>文字与排版</strong>
            <span>字体切换会保留当前位置</span>
          </div>
        </div>
        <label className="reader-pref-row">
          <span>字体</span>
          <select
            aria-label="阅读字体"
            value={settings.readerFont}
            onChange={(event) =>
              update({
                readerFont: event.target.value as typeof settings.readerFont,
              })
            }
          >
            {Object.entries(READER_FONTS).map(([id, font]) => (
              <option key={id} value={id}>
                {font.label}
              </option>
            ))}
          </select>
        </label>
        <label className="reader-pref-row">
          <span>字号</span>
          <input
            aria-label="阅读字号"
            type="range"
            min="14"
            max="32"
            value={settings.fontSize}
            onChange={(event) =>
              update({ fontSize: Number(event.target.value) })
            }
          />
          <output>{settings.fontSize}</output>
        </label>
        <label className="reader-pref-row">
          <span>行距</span>
          <input
            aria-label="阅读行距"
            type="range"
            min="1.4"
            max="2.6"
            step="0.1"
            value={settings.lineHeight}
            onChange={(event) =>
              update({ lineHeight: Number(event.target.value) })
            }
          />
          <output>{settings.lineHeight.toFixed(1)}</output>
        </label>
        <label className="reader-pref-row">
          <span>左右留白</span>
          <input
            aria-label="左右留白"
            type="range"
            min="2"
            max="12"
            step="1"
            value={settings.readerPadding}
            onChange={(event) =>
              update({ readerPadding: Number(event.target.value) })
            }
          />
          <output>{settings.readerPadding}%</output>
        </label>
        {!hideMode && (
          <label className="reader-pref-row">
            <span>阅读方式</span>
            <select
              aria-label="小说翻页模式"
              value={settings.readerMode}
              onChange={(event) =>
                update({
                  readerMode: event.target.value as typeof settings.readerMode,
                })
              }
            >
              <option value="scroll">连续滚动</option>
              <option value="paged">分页翻页</option>
            </select>
          </label>
        )}
      </section>

      <button type="button" className="reader-pref-reset" onClick={reset}>
        <RotateCcw size={14} />
        恢复阅读默认设置
      </button>
    </div>
  );
}
