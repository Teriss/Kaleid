import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ChevronLeft,
  Ellipsis,
  Heart,
  ListMusic,
  Maximize2,
  Palette,
  Pause,
  Pin,
  PinOff,
  Play,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  EMPTY_MUSIC_WINDOW_STATE,
  type MusicWindowState,
} from "../../../shared/music";
import type { Line } from "../../../../vendor/folia/src/types";
import { PlayerState } from "../../../../vendor/folia/src/types";
import {
  useRemoteClock,
  type RemoteClock,
} from "../../../../vendor/folia/src/components/remote/useRemoteClock";
import { useRemoteSleeve } from "../../../../vendor/folia/src/components/remote/useRemoteSleeve";
import {
  buildRemoteLyricSegments,
  resolveRemoteLyricFit,
  resolveRemoteLyricTexts,
} from "../../../../vendor/folia/src/components/remote/remoteLyricText";
import {
  isPlaybackSpaceShortcut,
  shouldPreventPlaybackSpace,
} from "../playbackSpace";
import { applyTheme } from "../theme";

const BACKGROUNDS = ["default", "cover", "transparent"] as const;
type Background = (typeof BACKGROUNDS)[number];
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties;
const formatTime = (value: number) => {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
};
const realLine = (line: Line) =>
  !!line.fullText.trim() && !/^[.·…\s]+$/.test(line.fullText);

/** Folia's clock paints progress/word fill directly; React only changes the lyric on a line boundary. */
function useLine(lines: Line[], clock: RemoteClock) {
  const [index, setIndex] = useState(-1);
  const indexRef = useRef(-1);
  useEffect(() => {
    const update = () => {
      const time = clock.getTime();
      let low = 0,
        high = lines.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (lines[mid].startTime <= time) low = mid + 1;
        else high = mid;
      }
      let next = low - 1;
      while (next >= 0 && !realLine(lines[next])) next--;
      if (indexRef.current !== next) {
        indexRef.current = next;
        setIndex(next);
      }
    };
    update();
    return clock.subscribe(update);
  }, [lines, clock]);
  const line = lines[index] ?? null;
  const next = lines.slice(index + 1).find(realLine) ?? null;
  return { line, next };
}

function Lyric({
  line,
  next,
  clock,
}: {
  line: Line;
  next: Line | null;
  clock: RemoteClock;
}) {
  const segments = useMemo(() => buildRemoteLyricSegments(line), [line]);
  const words = useRef<Array<HTMLSpanElement | null>>([]);
  const measure = useRef<HTMLDivElement>(null);
  const [lineCount, setLineCount] = useState(1);
  const texts = resolveRemoteLyricTexts("both", line, next);
  const fit = resolveRemoteLyricFit({
    mainLinesAtLarge: lineCount,
    hasRomanization: !!texts.romanization,
    hasSecond: !!texts.second,
  });
  useLayoutEffect(() => {
    setLineCount(
      Math.max(1, Math.round((measure.current?.offsetHeight || 26) / 26)),
    );
  }, [line, segments]);
  useEffect(() => {
    const painted: number[] = [];
    const paint = () => {
      const now = clock.getTime();
      segments.forEach((segment, index) => {
        const node = words.current[index];
        if (!node) return;
        const duration = segment.endTime - segment.startTime;
        const fill =
          duration > 0
            ? Math.round(
                Math.max(0, Math.min(1, (now - segment.startTime) / duration)) *
                  1000,
              ) / 10
            : now >= segment.startTime
              ? 100
              : 0;
        if (painted[index] === fill) return;
        painted[index] = fill;
        node.dataset.fill = fill >= 100 ? "full" : fill <= 0 ? "none" : "part";
        if (fill > 0 && fill < 100)
          node.style.setProperty("--remote-fill", fill + "%");
      });
    };
    paint();
    return clock.subscribe(paint);
  }, [segments, clock]);
  const content = (live: boolean) =>
    segments.length ? (
      segments.map((segment, index) => (
        <span
          key={index}
          ref={
            live
              ? (node) => {
                  words.current[index] = node;
                }
              : undefined
          }
          className={segment.timed ? "remote-lyric__word" : "remote-lyric__gap"}
        >
          {segment.text}
        </span>
      ))
    ) : (
      <span className="remote-lyric__whole">{line.fullText}</span>
    );
  return (
    <div className="remote-lyric" data-shown="true">
      <div className="remote-lyric__pair">
        <div
          ref={measure}
          className="remote-lyric__hero remote-lyric__measure"
          aria-hidden
        >
          {content(false)}
        </div>
        <div className="remote-lyric__hero" data-size={fit.size}>
          {content(true)}
        </div>
        {fit.showRomanization && texts.romanization && (
          <div className="remote-lyric__roma">{texts.romanization}</div>
        )}
        {texts.second && fit.secondMaxLines > 0 && (
          <div
            className="remote-lyric__sub"
            data-kind={texts.second.kind}
            data-lines={fit.secondMaxLines}
          >
            {texts.second.text}
          </div>
        )}
      </div>
    </div>
  );
}

function Progress({
  clock,
  duration,
  disabled,
  onSeeking,
}: {
  clock: RemoteClock;
  duration: number;
  disabled: boolean;
  onSeeking(value: boolean): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    const paint = () => {
      const value = Math.max(0, Math.min(duration, clock.getShownTime()));
      root.current?.style.setProperty(
        "--remote-progress",
        (duration > 0 ? (value / duration) * 100 : 0) + "%",
      );
      if (input.current && !dragging.current)
        input.current.value = String(value);
    };
    paint();
    return clock.subscribe(paint);
  }, [duration, clock]);
  useEffect(() => () => clock.cancelSeek(), [clock]);
  const finish = (commit: boolean) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (commit) {
      const value = clock.releaseSeek();
      if (value !== null) window.music.command("seek", value);
    } else clock.cancelSeek();
    onSeeking(false);
  };
  return (
    <div ref={root} className="remote-line" style={noDrag}>
      <input
        ref={input}
        className="remote-line__input"
        type="range"
        aria-label="迷你播放器进度"
        min="0"
        max={duration || 1}
        step="0.1"
        defaultValue="0"
        disabled={disabled || duration <= 0}
        onPointerDown={(event) => {
          dragging.current = true;
          onSeeking(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onChange={(event) => {
          clock.previewSeek(Number(event.target.value));
          if (!dragging.current) {
            const value = clock.releaseSeek();
            if (value !== null) window.music.command("seek", value);
          }
        }}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={() => finish(true)}
      />
      <div className="remote-line__track">
        <div className="remote-line__fill" />
      </div>
      <div className="remote-line__knob" />
    </div>
  );
}

function Time({ clock }: { clock: RemoteClock }) {
  const elapsed = useRef<HTMLSpanElement>(null),
    total = useRef<HTMLElement>(null);
  useEffect(() => {
    let shownElapsed = "",
      shownTotal = "";
    const paint = () => {
      const time = formatTime(clock.getShownTime()),
        duration = " / " + formatTime(clock.getDuration());
      if (elapsed.current && shownElapsed !== time) {
        shownElapsed = time;
        elapsed.current.textContent = time;
      }
      if (total.current && shownTotal !== duration) {
        shownTotal = duration;
        total.current.textContent = duration;
      }
    };
    paint();
    return clock.subscribe(paint);
  }, [clock]);
  return (
    <div className="remote-deck__slot remote-deck__slot--time remote-lit">
      <span ref={elapsed}>0:00</span>
      <i ref={total}> / 0:00</i>
    </div>
  );
}

export default function MusicWindow() {
  const [initial] = useState(() => window.music.windowInitial());
  const [state, setState] = useState<MusicWindowState>(
    initial?.state ?? EMPTY_MUSIC_WINDOW_STATE,
  );
  const [hydrated, setHydrated] = useState(!!initial);
  const [error, setError] = useState("");
  const [pinned, setPinned] = useState(initial?.pinned ?? true);
  const pinRevision = useRef(0);
  const [inside, setInside] = useState(false);
  const [lingers, setLingers] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme || "dark",
  );
  const [scale, setScale] = useState(() =>
    Math.min(innerWidth / 602, innerHeight / 184),
  );
  const [background, setBackground] = useState<Background>(() => {
    const saved = localStorage.getItem("kaleid:mini-background") as Background;
    return BACKGROUNDS.includes(saved) ? saved : "default";
  });
  const card = useRef<HTMLDivElement>(null);
  const idle = useRemoteSleeve(
    !lingers && !sheet && !seeking,
    state.reducedMotion,
    card,
  );
  const hasTrack = !!state.trackId;
  const clock = useRemoteClock({
    updatedAt: state.updatedAt || Date.now(),
    currentTime: state.position,
    duration: state.duration,
    playerState:
      state.playing && hasTrack ? PlayerState.PLAYING : PlayerState.PAUSED,
  });
  const lines = useMemo<Line[]>(
    () =>
      state.lyrics.map((line, index) => ({
        fullText: line.text,
        startTime: line.time,
        endTime:
          state.lyrics[index + 1]?.time ??
          Math.max(state.duration, line.time + 5),
        translation: line.translation,
        romanization: line.romanization,
        words:
          line.words?.map((word) => ({
            text: word.text,
            startTime: word.time,
            endTime: word.time + word.duration,
          })) ?? [],
      })),
    [state.lyrics, state.duration],
  );
  const { line, next } = useLine(lines, clock);
  const lit = !idle;
  useLayoutEffect(() => {
    let live = true,
      initialized = false;
    let buffered: Partial<MusicWindowState> = {};
    const off = window.music.onState((patch) => {
      if (!initialized) buffered = { ...buffered, ...patch };
      setState((previous) => ({ ...previous, ...patch }));
      if (patch.trackId !== undefined) setHydrated(true);
    });
    const pointerOff = window.music.onWindowPointer(setInside);
    void window.music
      .windowBootstrap()
      .then((bootstrap) => {
        if (!live) return;
        initialized = true;
        setState({ ...bootstrap.state, ...buffered });
        if (pinRevision.current === 0) setPinned(bootstrap.pinned);
        applyTheme(bootstrap.theme);
        setHydrated(true);
      })
      .catch((reason) => {
        if (live) {
          setError(String(reason));
          setHydrated(true);
        }
      });
    if (!initial) {
      void window.music
        .windowPin()
        .then((value) => {
          if (live && pinRevision.current === 0) setPinned(value);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
      off();
      pointerOff();
    };
  }, []);
  useLayoutEffect(() => {
    performance.mark("mini-ready");
    window.music.windowReady();
  }, []);
  useEffect(() => {
    if (hydrated) performance.mark("mini-hydrated");
  }, [hydrated]);
  useEffect(() => {
    const resize = () =>
      setScale(Math.min(innerWidth / 602, innerHeight / 184));
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme || "dark"),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = state.reducedMotion
      ? "uiMicroMotion"
      : "";
  }, [state.reducedMotion]);
  useEffect(() => {
    if (inside) {
      setLingers(true);
      return;
    }
    const timer = window.setTimeout(() => setLingers(false), 800);
    return () => window.clearTimeout(timer);
  }, [inside]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && sheet) {
        setSheet(false);
        event.preventDefault();
        return;
      }
      if (!hasTrack || !shouldPreventPlaybackSpace(event)) return;
      const toggle = isPlaybackSpaceShortcut(event);
      event.preventDefault();
      event.stopPropagation();
      if (toggle) window.music.command("toggle");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [hasTrack, sheet]);
  const changeBackground = () => {
    const next =
      BACKGROUNDS[(BACKGROUNDS.indexOf(background) + 1) % BACKGROUNDS.length];
    setBackground(next);
    localStorage.setItem("kaleid:mini-background", next);
  };
  const pin = async () => {
    ++pinRevision.current;
    try {
      setPinned(await window.music.windowPin(!pinned));
    } catch (reason) {
      setError(String(reason));
    }
  };
  const interaction = (active: boolean) => {
    setSeeking(active);
    window.music.windowInteraction(active);
  };
  return (
    <main className="mini-viewport" onPointerEnter={() => setInside(true)}>
      <div
        className="mini-canvas"
        style={{ transform: "translate(-50%, -50%) scale(" + scale + ")" }}
      >
        <div
          className="remote-window"
          data-theme={theme}
          data-bg={background}
          data-lit={lit}
          data-idle={idle}
          data-sleeve={idle}
          data-paused={hasTrack && !state.playing}
          data-sheet={sheet}
          data-notitle="false"
          data-loading={!hydrated}
        >
          <div ref={card} className="remote-card">
            <div className="remote-paper">
              {background === "cover" && (
                <>
                  <div
                    className="remote-wash"
                    style={{
                      backgroundImage: state.cover
                        ? 'url("' + state.cover + '")'
                        : undefined,
                    }}
                  />
                  <div className="remote-wash-shade" />
                </>
              )}
            </div>
            <div className="remote-face">
              {background === "transparent" && (
                <>
                  <div className="mini-text-shade" />
                  <div className="remote-glass" />
                </>
              )}
              <div className="remote-stage" aria-hidden={sheet} inert={sheet}>
                <div className="remote-song" data-mode={line ? "line" : "card"}>
                  <div className="remote-cover">
                    {state.cover ? (
                      <img
                        key={state.cover}
                        className="remote-cover__image"
                        src={state.cover}
                        alt=""
                        onError={(event) => {
                          event.currentTarget.style.visibility = "hidden";
                        }}
                      />
                    ) : (
                      <div className="remote-cover__blank">♪</div>
                    )}
                  </div>
                  <div className="remote-song__line" aria-hidden={!line}>
                    <div className="remote-song__row">
                      <span className="remote-song__title">
                        {state.title || (hydrated ? "暂无播放" : "")}
                      </span>
                      <span className="remote-song__artist">
                        {state.artist}
                      </span>
                    </div>
                  </div>
                  <div className="remote-song__card" aria-hidden={!!line}>
                    <div className="remote-song__cardtext">
                      {!hydrated && (
                        <div
                          className="mini-loading"
                          role="status"
                          aria-label="加载当前歌曲"
                        >
                          <span />
                          <span />
                        </div>
                      )}
                      <div className="remote-song__cardtitle">
                        {state.title || (hydrated ? "暂无播放" : "")}
                      </div>
                      <div className="remote-song__cardartist">
                        {!hydrated
                          ? ""
                          : state.artist ||
                            (hasTrack ? "未知艺术家" : "选择一首歌曲开始播放")}
                      </div>
                    </div>
                  </div>
                </div>
                {line && (
                  <Lyric
                    key={line.startTime + ":" + line.fullText}
                    line={line}
                    next={next}
                    clock={clock}
                  />
                )}
              </div>
              {sheet && (
                <section
                  className="mini-sheet"
                  style={noDrag}
                  aria-label="遥控播放选项"
                >
                  <div className="mini-sheet-title">
                    <button
                      aria-label="返回歌词"
                      onClick={() => setSheet(false)}
                    >
                      <ChevronLeft size={15} />
                    </button>
                    <strong>播放选项</strong>
                  </div>
                  <div className="mini-volume">
                    <button
                      aria-label={state.muted ? "取消静音" : "静音"}
                      disabled={!hasTrack}
                      onClick={() => window.music.command("mute")}
                    >
                      {state.muted ? (
                        <VolumeX size={16} />
                      ) : (
                        <Volume2 size={16} />
                      )}
                    </button>
                    <input
                      type="range"
                      aria-label="遥控音量"
                      min="0"
                      max="1"
                      step=".01"
                      disabled={!hasTrack}
                      value={state.volume}
                      onChange={(event) =>
                        window.music.command(
                          "volume",
                          Number(event.target.value),
                        )
                      }
                      onPointerDown={() => interaction(true)}
                      onPointerUp={() => interaction(false)}
                      onPointerCancel={() => interaction(false)}
                    />
                    <span>{Math.round(state.volume * 100)}%</span>
                  </div>
                  <div className="mini-sheet-actions">
                    <button
                      disabled={!hasTrack}
                      onClick={() => window.music.command("order")}
                    >
                      {state.order === "shuffle" ? "随机播放" : "顺序播放"}
                    </button>
                    <button onClick={() => window.music.command("expand")}>
                      <Maximize2 size={13} />
                      主播放器
                    </button>
                    <button onClick={() => window.music.command("queue")}>
                      <ListMusic size={13} />
                      播放队列
                    </button>
                  </div>
                </section>
              )}
              <div className="remote-tools remote-lit" style={noDrag}>
                <button
                  className="remote-tool"
                  aria-label="切换遥控背景"
                  title={
                    "背景：" +
                    { default: "默认", cover: "封面", transparent: "透明" }[
                      background
                    ]
                  }
                  onClick={changeBackground}
                >
                  <Palette size={13} />
                </button>
                <button
                  className="remote-tool"
                  aria-label={pinned ? "取消置顶" : "置顶"}
                  aria-pressed={pinned}
                  title={pinned ? "取消置顶" : "置顶"}
                  onClick={() => void pin()}
                >
                  {pinned ? <Pin size={13} /> : <PinOff size={13} />}
                </button>
                <button
                  className="remote-tool"
                  aria-label="关闭窗口"
                  title="关闭窗口"
                  onClick={() => window.music.command("close")}
                >
                  <X size={13} />
                </button>
              </div>
              <Progress
                clock={clock}
                duration={state.duration}
                disabled={!hasTrack}
                onSeeking={interaction}
              />
              <div className="remote-deck" inert={idle} aria-hidden={idle}>
                <Time clock={clock} />
                <div className="remote-transport" style={noDrag}>
                  <button
                    className="remote-key remote-key--skip"
                    aria-label="上一首"
                    disabled={!hasTrack}
                    onClick={() => window.music.command("previous")}
                  >
                    <SkipBack size={17} fill="currentColor" />
                  </button>
                  <button
                    className="remote-key remote-key--play"
                    aria-label="播放暂停"
                    title={state.playing ? "暂停" : "播放"}
                    disabled={!hasTrack}
                    onClick={() => window.music.command("toggle")}
                  >
                    {state.playing ? (
                      <Pause size={22} fill="currentColor" />
                    ) : (
                      <Play size={22} fill="currentColor" />
                    )}
                  </button>
                  <button
                    className="remote-key remote-key--skip"
                    aria-label="下一首"
                    disabled={!hasTrack}
                    onClick={() => window.music.command("next")}
                  >
                    <SkipForward size={17} fill="currentColor" />
                  </button>
                </div>
                <div
                  className="remote-deck__slot remote-deck__slot--keys remote-lit"
                  style={noDrag}
                >
                  <button
                    className="remote-key remote-key--small"
                    aria-label={state.favorite ? "取消收藏" : "收藏"}
                    aria-pressed={state.favorite}
                    data-liked={state.favorite}
                    disabled={!hasTrack}
                    onClick={() => window.music.command("favorite")}
                  >
                    <Heart
                      size={15}
                      fill={state.favorite ? "currentColor" : "none"}
                    />
                  </button>
                  <button
                    className="remote-key remote-key--small"
                    aria-label="切换循环模式"
                    title={
                      { off: "关闭循环", all: "列表循环", one: "单曲循环" }[
                        state.repeat
                      ]
                    }
                    data-on={state.repeat !== "off"}
                    disabled={!hasTrack}
                    onClick={() => window.music.command("repeat")}
                  >
                    {state.repeat === "one" ? (
                      <Repeat1 size={15} />
                    ) : (
                      <Repeat size={15} />
                    )}
                    {state.repeat !== "off" && (
                      <span className="remote-key__dot" />
                    )}
                  </button>
                  <button
                    className="remote-key remote-key--small"
                    aria-label="更多播放选项"
                    aria-expanded={sheet}
                    data-on={sheet}
                    onClick={() => setSheet(!sheet)}
                  >
                    <Ellipsis size={16} />
                  </button>
                </div>
              </div>
              {error && (
                <button
                  className="mini-notice"
                  style={noDrag}
                  onClick={() => setError("")}
                >
                  {error}
                </button>
              )}
            </div>
            <div className="remote-ring" />
          </div>
        </div>
      </div>
    </main>
  );
}
