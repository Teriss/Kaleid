import { EQUALIZER_PRESETS } from "./music/equalizer";
import MusicSettings from "./music/MusicSettings";
import { useState } from "react";
import {
  Monitor,
  BookOpen,
  HardDrive,
  Keyboard,
  X,
  AudioLines,
  Video,
} from "lucide-react";
import { IconButton, Modal } from "./components";
import { act, useApp } from "./store";
import ReaderPreferences from "./ReaderPreferences";

export default function SettingsPanel({
  close,
  section = "appearance",
  onSectionChange,
}: {
  close(): void;
  section?: string;
  onSectionChange?(section: string): void;
}) {
  const { settings, setSettings } = useApp();
  const setSection = (value: string) => onSectionChange?.(value);
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState(false);
  const groups = [
    { id: "appearance", label: "外观", icon: Monitor },
    { id: "reading", label: "阅读", icon: BookOpen },
    { id: "storage", label: "存储", icon: HardDrive },
    { id: "shortcuts", label: "快捷操作", icon: Keyboard },
    { id: "music", label: "音乐", icon: AudioLines },
    { id: "video", label: "视频", icon: Video },
  ];
  const active = search
    ? (groups.find((group) => group.label.includes(search))?.id ?? section)
    : section;
  return (
    <Modal title="设置" close={close} className="settings-modal">
      <aside className="settings-navigation">
        <input
          aria-label="搜索设置"
          placeholder="搜索设置"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <small>界面</small>
        {groups
          .filter((group) => !search || group.label.includes(search))
          .map((group) => (
            <button
              key={group.id}
              className={active === group.id ? "selected" : ""}
              onClick={() => setSection(group.id)}
            >
              <group.icon size={15} />
              {group.label}
            </button>
          ))}
        <span className="settings-version">Kaleid 0.4.0 preview 5</span>
      </aside>
      <main className="settings-body">
        {active === "video" && (
          <label className="setting-row">
            <span>
              <strong>离开视频播放页后自动进入画中画</strong>
              <small>
                关闭时，返回或切库会停止播放并保存进度；手动画中画继续播放。
              </small>
            </span>
            <input
              type="checkbox"
              aria-label="自动进入画中画"
              checked={settings.videoAutoPictureInPicture ?? false}
              onChange={(e) =>
                void setSettings({
                  ...settings,
                  videoAutoPictureInPicture: e.target.checked,
                })
              }
            />
          </label>
        )}
        <div className="settings-heading">
          <h2>{groups.find((group) => group.id === active)?.label}</h2>
          <IconButton label="关闭设置" onClick={close}>
            <X size={17} />
          </IconButton>
        </div>
        {active === "appearance" && (
          <>
            <h3>显示与动效</h3>
            <div className="settings-group">
              <label className="setting-row">
                <span>
                  <strong>界面主题</strong>
                  <small>统一所有界面；保留阅读纸色与歌词自定义背景。</small>
                </span>
                <select
                  aria-label="界面主题"
                  value={settings.theme}
                  onChange={(event) =>
                    void act(() =>
                      setSettings({
                        ...settings,
                        theme: event.target.value as "dark" | "light",
                      }),
                    )
                  }
                >
                  <option value="dark">深色</option>
                  <option value="light">亮色</option>
                </select>
              </label>
              <div className="setting-row">
                <strong>固定显示导航</strong>
                <button
                  role="switch"
                  aria-label="固定显示导航"
                  aria-checked={!settings.navigationAutoHide}
                  className={`switch ${!settings.navigationAutoHide ? "on" : ""}`}
                  onClick={() =>
                    void act(() =>
                      setSettings({
                        ...settings,
                        navigationAutoHide: !settings.navigationAutoHide,
                      }),
                    )
                  }
                >
                  <span />
                </button>
              </div>
              <div className="setting-row">
                <div>
                  <strong>导航菜单位置</strong>
                  <p>统一调整媒体类型、收藏、历史和设置入口。</p>
                </div>
                <select
                  aria-label="导航菜单位置"
                  value={settings.navigationPosition}
                  onChange={(event) =>
                    void act(() =>
                      setSettings({
                        ...settings,
                        navigationPosition: event.target
                          .value as typeof settings.navigationPosition,
                      }),
                    )
                  }
                >
                  <option value="top">顶部</option>
                  <option value="bottom">底部</option>
                  <option value="left">左侧</option>
                  <option value="right">右侧</option>
                </select>
              </div>
              <div className="setting-row">
                <div>
                  <strong>减少动态效果</strong>
                  <p>关闭惯性移动、景深过渡与背景渐变。</p>
                </div>
                <button
                  role="switch"
                  aria-label="减少动态效果"
                  aria-checked={settings.reducedMotion}
                  className={`switch ${settings.reducedMotion ? "on" : ""}`}
                  onClick={() =>
                    void act(() =>
                      setSettings({
                        ...settings,
                        reducedMotion: !settings.reducedMotion,
                      }),
                    )
                  }
                >
                  <span />
                </button>
              </div>
            </div>
          </>
        )}
        {active === "reading" && (
          <>
            <h3>小说阅读</h3>
            <ReaderPreferences />
          </>
        )}
        {active === "music" && (
          <>
            <MusicSettings />
            <h3>声音与歌词</h3>
            <div className="settings-group">
              <div className="setting-row">
                <div>
                  <strong>十段均衡器</strong>
                  <p>通过本地音频滤波器调整播放声音。</p>
                </div>
                <button
                  role="switch"
                  aria-label="启用均衡器"
                  aria-checked={settings.equalizerEnabled}
                  className={`switch ${settings.equalizerEnabled ? "on" : ""}`}
                  onClick={() =>
                    void act(() =>
                      setSettings({
                        ...settings,
                        equalizerEnabled: !settings.equalizerEnabled,
                      }),
                    )
                  }
                >
                  <span />
                </button>
              </div>
              <div className="setting-row">
                <strong>均衡器预设</strong>
                <select
                  aria-label="均衡器预设"
                  value={settings.equalizerPreset}
                  onChange={(event) => {
                    const presets = EQUALIZER_PRESETS;
                    void act(() =>
                      setSettings({
                        ...settings,
                        equalizerPreset: event.target.value,
                        equalizerBands:
                          presets[event.target.value] ??
                          settings.equalizerBands,
                      }),
                    );
                  }}
                >
                  <option value="flat">平直</option>
                  <option value="bass">低音</option>
                  <option value="vocal">人声</option>
                  <option value="classical">古典</option>
                  <option value="pop">流行</option>
                  <option value="custom">自定义</option>
                </select>
              </div>
              <div className="equalizer-sliders">
                {[
                  "31",
                  "62",
                  "125",
                  "250",
                  "500",
                  "1k",
                  "2k",
                  "4k",
                  "8k",
                  "16k",
                ].map((frequency, index) => (
                  <label key={frequency}>
                    <span>{frequency}</span>
                    <input
                      aria-label={`${frequency} Hz 均衡器`}
                      type="range"
                      min="-12"
                      max="12"
                      step="1"
                      value={settings.equalizerBands[index] ?? 0}
                      onChange={(event) => {
                        const equalizerBands = [...settings.equalizerBands];
                        equalizerBands[index] = Number(event.target.value);
                        void act(() =>
                          setSettings({
                            ...settings,
                            equalizerPreset: "custom",
                            equalizerBands,
                          }),
                        );
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="setting-row">
                <div>
                  <strong>响度统一</strong>
                  <p>
                    优先使用 ReplayGain 标签；没有标签时用随包 FFmpeg
                    分析并缓存响度。
                  </p>
                </div>
                <button
                  role="switch"
                  aria-label="启用响度统一"
                  aria-checked={settings.loudnessNormalization}
                  className={`switch ${settings.loudnessNormalization ? "on" : ""}`}
                  onClick={() =>
                    void act(() =>
                      setSettings({
                        ...settings,
                        loudnessNormalization: !settings.loudnessNormalization,
                      }),
                    )
                  }
                >
                  <span />
                </button>
              </div>
              <div className="setting-row">
                <strong>歌词呈现</strong>
                <select
                  aria-label="歌词呈现"
                  value={settings.lyricsPresentation}
                  onChange={(event) =>
                    void act(() =>
                      setSettings({
                        ...settings,
                        lyricsPresentation: event.target
                          .value as typeof settings.lyricsPresentation,
                      }),
                    )
                  }
                >
                  <option value="split">封面与双栏歌词</option>
                  <option value="fullscreen">全屏歌词</option>
                  <option value="wall">墙面卡片歌词</option>
                </select>
              </div>
            </div>
          </>
        )}
        {active === "storage" && (
          <>
            <h3>缓存</h3>
            <div className="settings-group">
              <div className="setting-row">
                <div>
                  <strong>封面与页面缓存</strong>
                  <p>清理后可重新扫描生成。</p>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    if (!confirm) {
                      setConfirm(true);
                      return;
                    }
                    void act(async () => {
                      await window.media.clearCache();
                      useApp.getState().touch();
                      useApp.getState().notify("缓存已清理");
                      setConfirm(false);
                    });
                  }}
                >
                  {confirm ? "确认清理" : "清理缓存"}
                </button>
              </div>
            </div>
            <p className="settings-note">不会删除原始文件、收藏或阅读进度。</p>
          </>
        )}
        {active === "shortcuts" && (
          <div className="settings-group shortcut-rows">
            {[
              ["搜索", "Ctrl K"],
              ["打开焦点媒体", "Enter"],
              ["取消聚焦 / 返回", "Esc"],
              ["移动焦点 / 翻页", "← ↑ ↓ →"],
              ["音乐播放 / 暂停", "Space"],
              ["墙面缩放", "Ctrl + 滚轮"],
            ].map(([label, key]) => (
              <div className="setting-row" key={label}>
                <strong>{label}</strong>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
        )}
      </main>
    </Modal>
  );
}
