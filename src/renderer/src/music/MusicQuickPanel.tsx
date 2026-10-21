import { EQUALIZER_PRESETS } from "./equalizer";
import { visualizerChoices } from "./appearanceOptions";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Crosshair,
  Home,
  Settings2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { Cover } from "../components";
import type { Library, Settings } from "../../../shared/types";
import type { BrowseLocation } from "../../../shared/navigation";
import { act, report, useApp, usePlayback } from "../store";
import { saveMemory, readMemory } from "../layouts/memory";
import { PagedMediaSource } from "../layouts/source";
import { effectControls, useMusicEffects } from "./effects";
import { isRemote, musicPage } from "./catalog";
import { useLyricPresentation, setLyricTheme } from "./lyricPresentation";

const labels: Record<string, string> = {
  highpass: "高通滤波",
  lowpass: "低通滤波",
  drive: "驱动",
  crush: "失真",
  wow: "抖晃",
  noise: "底噪",
  width: "声场宽度",
  space: "空间感",
  punch: "瞬态",
  bassBoost: "低音增强",
  trebleBoost: "高音增强",
  stereoWidth: "立体声宽度",
  reverb: "混响",
  speed: "速度",
  pitch: "音高",
};
export default function MusicQuickPanel({
  scope,
  navigate,
  libraries,
}: {
  scope: BrowseLocation;
  navigate(scope: BrowseLocation): void;
  libraries: Library[];
}) {
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState("播放");
  const [hover, setHover] = useState(false);
  const [videoSurface, setVideoSurface] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const update = (event: Event) => {
      setVideoSurface((event as CustomEvent<HTMLElement | null>).detail);
      setOpen(false);
      setHover(false);
    };
    window.addEventListener("video:music-surface", update);
    return () => window.removeEventListener("video:music-surface", update);
  }, []);
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragging = useRef(false);
  const dismissHover = () => {
    clearTimeout(hide.current);
    hide.current = setTimeout(() => {
      if (!dragging.current) setHover(false);
    }, 300);
  };
  useEffect(() => () => clearTimeout(hide.current), []);
  useEffect(() => {
    const release = () => {
      dragging.current = false;
      if (
        !root.current?.matches(":hover") &&
        !root.current?.contains(
          root.current?.ownerDocument.activeElement ?? null,
        )
      )
        dismissHover();
    };
    const owner = videoSurface?.ownerDocument.defaultView ?? window;
    owner.addEventListener("pointerup", release);
    owner.addEventListener("pointercancel", release);
    return () => {
      owner.removeEventListener("pointerup", release);
      owner.removeEventListener("pointercancel", release);
    };
  }, [videoSurface]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [busy, setBusy] = useState(false);
  const [styles, setStyles] = useState<{ mode: string; label: string }[]>([]);
  useEffect(() => {
    if (open && tab === "外观")
      void visualizerChoices().then(setStyles).catch(report);
  }, [open, tab]);
  const root = useRef<HTMLDivElement>(null);
  const settings = useApp((s) => s.settings),
    p = usePlayback(),
    fx = useMusicEffects();
  const theme = useLyricPresentation((s) => s.theme);
  const update = (patch: Partial<Settings>) =>
    void act(() =>
      useApp
        .getState()
        .setSettings({ ...useApp.getState().settings, ...patch }),
    );
  useEffect(() => {
    if (!open) return;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setDevices(d.filter((x) => x.kind === "audiooutput")))
      .catch(report);
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    const owner = root.current?.ownerDocument ?? document;
    owner.addEventListener("pointerdown", outside);
    owner.addEventListener("keydown", escape);
    return () => {
      owner.removeEventListener("pointerdown", outside);
      owner.removeEventListener("keydown", escape);
    };
  }, [open, videoSurface]);
  const home = () => {
    if (scope.view === "music")
      navigate({
        ...scope,
        section: "discover",
        remoteId: undefined,
        remoteKind: undefined,
        search: undefined,
      });
    else if (scope.type === "music" && scope.libraryId)
      navigate({
        view: "library",
        type: scope.type,
        libraryId: scope.libraryId,
      });
    else navigate({ view: "libraries", type: "music" });
    setOpen(false);
  };
  async function locate() {
    const playback = usePlayback.getState(),
      track = playback.track;
    if (!track || busy) return;
    setBusy(true);
    try {
      let destination: BrowseLocation;
      if (isRemote(track))
        destination = (playback.origin?.scope.view === "music"
          ? playback.origin.scope
          : undefined) ?? {
          view: "music",
          type: "music",
          musicSource:
            track.sourceRef?.kind === "navidrome" ? "navidrome" : "online",
          providerId: (track.sourceRef as any)?.providerId,
          section: "search",
          search: track.title,
        };
      else {
        const item = await window.media.item(track.id);
        const contains = (root: string) => {
          const r = root.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
          const path = item.path.replace(/\\/g, "/").toLowerCase();
          return path.startsWith(r + "/");
        };
        const candidates = libraries.filter(
          (lib) => lib.type === "music" && lib.roots.some(contains),
        );
        const lib =
          candidates.find((l) => l.id === playback.origin?.scope.libraryId) ??
          candidates[0];
        if (!lib) throw new Error("歌曲所在媒体库已不可用");
        destination = {
          view: "library",
          type: "music",
          libraryId: lib.id,
          folder: item.folder,
        };
      }
      const value = readMemory(destination);
      const source = new PagedMediaSource({
        libraryId: destination.libraryId,
        type: "music",
        folder: destination.folder,
        browse: true,
        sort: value.sort,
      });
      let index = 0;
      if (!isRemote(track)) {
        try {
          await source.initialize(track.id);
          index = source.getSnapshot().anchorIndex;
          if ((await source.at(index))?.id !== track.id)
            throw new Error("歌曲已不在原目录中");
        } finally {
          source.dispose();
        }
      }
      if (isRemote(track)) {
        index = -1;
        for (let offset = 0; ; offset += 100) {
          const page = await musicPage(destination, {
            type: "music",
            search: destination.search,
            sort: value.sort,
            offset,
            limit: 100,
          });
          if (usePlayback.getState().track?.id !== track.id) return;
          const found = page.items.findIndex((item) => item.id === track.id);
          if (found >= 0) {
            index = offset + found;
            break;
          }
          if (offset + page.items.length >= page.total || !page.items.length)
            break;
        }
        if (index < 0)
          throw new Error("歌曲已不在原集合中，可通过搜索重新查找");
        source.dispose();
      }
      if (usePlayback.getState().track?.id !== track.id) return;
      saveMemory(destination, {
        ...value,
        revealFocus: true,
        focusRequest: Math.max(Date.now(), (value.focusRequest ?? 0) + 1),
        carouselPosition: index,
        galleryOffset: undefined,
        focusId: track.id,
        focusIndex: index,
        wallFocusId: undefined,
        scrollTop: undefined,
        spatialCamera: undefined,
      });
      navigate(destination);
      setOpen(false);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  if (scope.type !== "music" && !p.track) return null;
  const appearance = (key: string, value: string) => {
    localStorage.setItem(key, value);
    window.dispatchEvent(new Event("music-appearance-change"));
  };
  const content = (
    <div
      className={`music-quick-dock music-unified-dock ${open ? "settings-open" : ""}`}
      ref={root}
      onPointerEnter={() => {
        clearTimeout(hide.current);
        setHover(true);
      }}
      onPointerLeave={dismissHover}
      onFocusCapture={() => {
        clearTimeout(hide.current);
        setHover(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          dismissHover();
      }}
      onPointerDownCapture={() => {
        dragging.current = true;
      }}
      onPointerUpCapture={() => {
        dragging.current = false;
      }}
      onPointerCancelCapture={() => {
        dragging.current = false;
        dismissHover();
      }}
    >
      {p.track && hover && !open && (
        <section className="music-dock-controls" aria-label="音乐悬浮控制">
          <button
            className="music-dock-title"
            aria-label="展开音乐播放器"
            onClick={() =>
              usePlayback.setState({ expanded: true, queueVisible: false })
            }
          >
            <strong>{p.track.title}</strong>
            <small>{p.track.artist || "本地音乐"}</small>
          </button>
          <div className="music-dock-transport">
            <button aria-label="上一首" onClick={() => p.next(-1)}>
              <SkipBack size={17} />
            </button>
            <button
              aria-label={p.playing ? "暂停音乐" : "播放音乐"}
              onClick={p.toggle}
            >
              {p.playing ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <button aria-label="下一首" onClick={() => p.next()}>
              <SkipForward size={17} />
            </button>
          </div>
          <input
            aria-label="音乐播放进度"
            type="range"
            min={0}
            max={p.duration || 1}
            step={0.1}
            value={Math.min(p.position, p.duration || 1)}
            onChange={(e) => p.seekTo(Number(e.target.value))}
          />
          <label>
            音量
            <input
              aria-label="悬浮音乐音量"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={p.volume}
              onChange={(e) =>
                usePlayback.setState({ volume: Number(e.target.value) })
              }
            />
          </label>
        </section>
      )}
      {open && (
        <section className="music-quick-panel" aria-label="音乐快捷设置">
          <div className="quick-destinations">
            <button onClick={home}>
              <Home size={17} />
              主页
            </button>
            <button disabled={!p.track || busy} onClick={() => void locate()}>
              <Crosshair size={17} />
              定位当前歌曲
            </button>
          </div>
          <nav className="quick-tabs">
            {["播放", "音效", "外观"].map((t) => (
              <button
                key={t}
                className={t === tab ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </nav>
          {tab === "播放" && (
            <div className="quick-fields">
              <label>
                音量
                <input
                  aria-label="快捷音量"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={p.volume}
                  onChange={(e) =>
                    usePlayback.setState({ volume: Number(e.target.value) })
                  }
                />
              </label>
              <button onClick={() => usePlayback.setState({ muted: !p.muted })}>
                {p.muted ? "恢复声音" : "静音"}
              </button>
              <label>
                播放顺序
                <select
                  value={p.order}
                  onChange={(e) =>
                    usePlayback.setState({ order: e.target.value as any })
                  }
                >
                  <option value="sequential">顺序</option>
                  <option value="shuffle">随机</option>
                </select>
              </label>
              <label>
                循环
                <select
                  value={p.repeat}
                  onChange={(e) =>
                    usePlayback.setState({ repeat: e.target.value as any })
                  }
                >
                  <option value="off">不循环</option>
                  <option value="all">列表循环</option>
                  <option value="one">单曲循环</option>
                </select>
              </label>
              <label>
                睡眠定时
                <select
                  value={settings.sleepTimerMinutes}
                  onChange={(e) =>
                    update({ sleepTimerMinutes: +e.target.value })
                  }
                >
                  {[0, 15, 30, 60, 90].map((n) => (
                    <option key={n} value={n}>
                      {n ? `${n} 分钟` : "关闭"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                输出设备
                <select
                  value={settings.audioOutputDeviceId}
                  onChange={(e) =>
                    update({ audioOutputDeviceId: e.target.value })
                  }
                >
                  <option value="">系统默认</option>
                  {devices.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `设备 ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="quick-destinations">
                <button
                  disabled={!p.track}
                  onClick={() => {
                    usePlayback.setState({ queueVisible: !p.queueVisible });
                    setOpen(false);
                  }}
                >
                  播放队列
                </button>
                <button
                  disabled={!p.track}
                  onClick={() => {
                    usePlayback.setState({
                      expanded: true,
                      queueVisible: false,
                    });
                    setOpen(false);
                  }}
                >
                  完整播放器
                </button>
              </div>
            </div>
          )}
          {tab === "音效" && (
            <div className="quick-fields">
              <label>
                十段均衡器
                <input
                  type="checkbox"
                  checked={settings.equalizerEnabled}
                  onChange={(e) =>
                    update({ equalizerEnabled: e.target.checked })
                  }
                />
              </label>
              <label>
                预设
                <select
                  aria-label="快捷均衡器预设"
                  value={settings.equalizerPreset}
                  onChange={(e) => {
                    const name = e.target.value;
                    const bands =
                      EQUALIZER_PRESETS[name] ?? settings.equalizerBands;
                    update({ equalizerPreset: name, equalizerBands: bands });
                  }}
                >
                  <option value="flat">平直</option>
                  <option value="bass">低音</option>
                  <option value="vocal">人声</option>
                  <option value="classical">古典</option>
                  <option value="pop">流行</option>
                  <option value="custom">自定义</option>
                </select>
              </label>
              <div className="quick-eq">
                {[31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map(
                  (n, i) => (
                    <label key={n}>
                      {n >= 1000 ? n / 1000 + "k" : n}
                      <input
                        aria-label={`快捷均衡器 ${n}Hz`}
                        type="range"
                        min="-12"
                        max="12"
                        step="0.5"
                        value={settings.equalizerBands[i]}
                        onChange={(e) => {
                          const bands = [...settings.equalizerBands];
                          bands[i] = +e.target.value;
                          update({
                            equalizerPreset: "custom",
                            equalizerBands: bands,
                          });
                        }}
                      />
                    </label>
                  ),
                )}
              </div>
              <label>
                响度统一
                <input
                  type="checkbox"
                  checked={settings.loudnessNormalization}
                  onChange={(e) =>
                    update({ loudnessNormalization: e.target.checked })
                  }
                />
              </label>
              <label>
                效果器
                <input
                  type="checkbox"
                  checked={fx.enabled}
                  onChange={(e) => fx.set({ enabled: e.target.checked })}
                />
              </label>
              {effectControls.map((c) => (
                <label key={c.id}>
                  {labels[c.id] ?? c.id}
                  <input
                    type="range"
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    value={fx.effects[c.id]}
                    onChange={(e) =>
                      fx.set({
                        effects: { ...fx.effects, [c.id]: +e.target.value },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {tab === "外观" && (
            <div className="quick-fields">
              <label>
                歌词呈现
                <select
                  value={settings.lyricsPresentation}
                  onChange={(e) =>
                    update({ lyricsPresentation: e.target.value as any })
                  }
                >
                  <option value="split">封面与歌词</option>
                  <option value="fullscreen">全屏歌词</option>
                  <option value="wall">卡片歌词</option>
                </select>
              </label>
              <label>
                歌词样式
                <select
                  aria-label="快捷歌词样式"
                  defaultValue={
                    localStorage.getItem("yingjian:lyric-style") || "classic"
                  }
                  onChange={(e) =>
                    appearance("yingjian:lyric-style", e.target.value)
                  }
                >
                  {styles.map((style) => (
                    <option key={style.mode} value={style.mode}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                背景
                <select
                  defaultValue={
                    localStorage.getItem("yingjian:music-background") ||
                    "latent"
                  }
                  onChange={(e) =>
                    appearance("yingjian:music-background", e.target.value)
                  }
                >
                  {["common", "latent", "monet", "nomand", "sora"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                文字颜色
                <input
                  type="color"
                  value={theme.primaryColor}
                  onChange={(e) =>
                    setLyricTheme({ ...theme, primaryColor: e.target.value })
                  }
                />
              </label>
              <label>
                背景颜色
                <input
                  type="color"
                  value={theme.backgroundColor}
                  onChange={(e) =>
                    setLyricTheme({ ...theme, backgroundColor: e.target.value })
                  }
                />
              </label>
            </div>
          )}
        </section>
      )}
      <button
        className="quick-toggle music-cover-toggle"
        aria-label={open ? "收起音乐快捷设置" : "音乐快捷设置"}
        aria-expanded={open}
        onClick={() => {
          setHover(false);
          setOpen(!open);
        }}
      >
        {p.track ? <Cover item={p.track} /> : <Settings2 size={18} />}
      </button>
    </div>
  );
  return videoSurface ? createPortal(content, videoSurface) : content;
}
