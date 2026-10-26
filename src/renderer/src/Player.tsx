import { createEffects, useMusicEffects } from "./music/effects";
import { publishLyrics, startLyricClock } from "./music/lyricPresentation";
import {
  isRemote,
  resolveAudio,
  onlineLyrics,
  musicItems,
  favoriteRemote,
} from "./music/catalog";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Music2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";
import { Cover, IconButton, Modal } from "./components";
import { act, report, resource, useApp, usePlayback } from "./store";
import type {
  MediaItem,
  MusicMetadataCandidate,
  MusicPlaylist,
} from "../../shared/types";

const FoliaStage = lazy(() => import("./music/FoliaStage"));
export interface LyricWord {
  time: number;
  duration: number;
  text: string;
}
export interface LyricLine {
  translation?: string;
  romanization?: string;
  time: number;
  text: string;
  words?: LyricWord[];
}
function lyricTime(value: string) {
  const normalized = value.trim();
  const unit = /^(\d+(?:\.\d+)?)(ms|s)$/i.exec(normalized);
  if (unit)
    return Number(unit[1]) / (unit[2].toLowerCase() === "ms" ? 1000 : 1);
  const parts = normalized.split(":");
  if (parts.length === 3)
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  return Number(normalized);
}
function lyricText(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(text)?.[1] ?? 0) / 1000;
  if (/<tt\b|<p\b/i.test(text)) {
    for (const match of text.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
      const begin = /\bbegin=["']([^"']+)["']/i.exec(match[1])?.[1];
      const value = lyricText(match[2]);
      if (!begin || !value) continue;
      const wordMatches = [
        ...match[2].matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi),
      ];
      const words: LyricWord[] = [];
      for (const [index, wordMatch] of wordMatches.entries()) {
        const wordStart = /\bbegin=["']([^"']+)["']/i.exec(wordMatch[1])?.[1];
        if (!wordStart) continue;
        const wordEnd = /\bend=["']([^"']+)["']/i.exec(wordMatch[1])?.[1];
        const start = lyricTime(wordStart) + offset;
        const nextStart = wordMatches
          .slice(index + 1)
          .map(
            (candidate) => /\bbegin=["']([^"']+)["']/i.exec(candidate[1])?.[1],
          )
          .find(Boolean);
        const end = wordEnd
          ? lyricTime(wordEnd) + offset
          : nextStart
            ? lyricTime(nextStart) + offset
            : start + 1;
        const wordText = lyricText(wordMatch[2]);
        if (wordText)
          words.push({
            time: start,
            duration: Math.max(0.05, end - start),
            text: wordText,
          });
      }
      lines.push({
        time: lyricTime(begin) + offset,
        text: value,
        ...(words.length ? { words } : {}),
      });
    }
    if (lines.length) return lines.sort((a, b) => a.time - b.time);
  }
  const vtt = [
    ...text.matchAll(
      /(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}[^\r\n]*\r?\n([\s\S]*?)(?=\r?\n\s*\r?\n|$)/g,
    ),
  ];
  if (vtt.length) {
    for (const match of vtt) {
      const value = lyricText(match[2].replace(/\r?\n/g, " "));
      if (value)
        lines.push({ time: lyricTime(match[1]) + offset, text: value });
    }
    return lines.sort((a, b) => a.time - b.time);
  }
  for (const line of text.split(/\r?\n/)) {
    const timedWords = /^\[(\d+),(\d+)\](.*)$/.exec(line);
    if (timedWords) {
      const start = Number(timedWords[1]) / 1000 + offset;
      const duration = Number(timedWords[2]) / 1000;
      const body = timedWords[3];
      const words: LyricWord[] = [];
      // YRC/QRC store absolute word timestamps in parenthesized tags; KRC uses
      // angle-bracket tags whose offsets are relative to the start of the line.
      const krcWords = [...body.matchAll(/<(\d+),(\d+)(?:,\d+)?>([^<]*)/g)];
      if (krcWords.length) {
        for (const match of krcWords) {
          const value = lyricText(match[3]);
          if (value)
            words.push({
              time: start + Number(match[1]) / 1000,
              duration: Math.max(0.05, Number(match[2]) / 1000),
              text: value,
            });
        }
      } else {
        const tags = [...body.matchAll(/\((\d+),(\d+)(?:,\d+)?\)/g)];
        const chunks: string[] = [];
        let cursor = 0;
        for (const tag of tags) {
          const tagStart = tag.index ?? cursor;
          chunks.push(body.slice(cursor, tagStart));
          cursor = tagStart + tag[0].length;
        }
        chunks.push(body.slice(cursor));
        const leading = Boolean(chunks[0]?.trim());
        const trailing = Boolean(chunks[chunks.length - 1]?.trim());
        for (const [index, match] of tags.entries()) {
          const before = chunks[index] ?? "";
          const after = chunks[index + 1] ?? "";
          const value = lyricText(
            leading && !trailing
              ? before
              : trailing && !leading
                ? after
                : before.trim() && !after.trim()
                  ? before
                  : after.trim() && !before.trim()
                    ? after
                    : after.length >= before.length
                      ? after
                      : before,
          );
          if (value)
            words.push({
              time: Number(match[1]) / 1000 + offset,
              duration: Math.max(0.05, Number(match[2]) / 1000),
              text: value,
            });
        }
      }
      const content =
        words.map((word) => word.text).join("") || lyricText(body);
      if (content)
        lines.push({
          time: start,
          text: content,
          ...(words.length
            ? { words }
            : {
                words: [
                  {
                    time: start,
                    duration: Math.max(0.05, duration),
                    text: content,
                  },
                ],
              }),
        });
      continue;
    }
    const inlineWords = [
      ...line.matchAll(/<(?:(\d+):)?(\d{2}):(\d{2}(?:\.\d+)?)>/g),
    ];
    if (inlineWords.length) {
      const words: LyricWord[] = inlineWords
        .map((match, index) => {
          const next = inlineWords[index + 1];
          const start =
            Number(match[1] ?? 0) * 60 +
            Number(match[2]) +
            Number(match[3]) +
            offset;
          const end = next
            ? Number(next[1] ?? 0) * 60 +
              Number(next[2]) +
              Number(next[3]) +
              offset
            : start + 1;
          const from = match.index! + match[0].length;
          const to = next?.index ?? line.length;
          return {
            time: start,
            duration: Math.max(0.05, end - start),
            text: lyricText(line.slice(from, to)),
          };
        })
        .filter((word) => word.text);
      if (words.length)
        lines.push({
          time: words[0].time,
          text: words.map((word) => word.text).join(""),
          words,
        });
      continue;
    }
    const times = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const content = lyricText(line.replace(/\[[^\]]+\]/g, ""));
    for (const match of times)
      if (content)
        lines.push({
          time: Number(match[1]) * 60 + Number(match[2]) + offset,
          text: content,
        });
  }
  return lines.sort((a, b) => a.time - b.time);
}
export default function Player({
  closeDetail,
  closeUI,
}: {
  closeDetail?: () => void;
  closeUI?: (fallback: () => void) => void;
}) {
  const state = usePlayback();
  const effectsState = useMusicEffects();
  const [audioUrl, setAudioUrl] = useState<string | undefined>();
  const settings = useApp((app) => app.settings);
  const audio = useRef<HTMLAudioElement>(null);
  const playRequest = useRef(0);
  useEffect(
    () =>
      window.video.onAudioFocus((serial) => {
        ++playRequest.current;
        audio.current?.pause();
        usePlayback.setState({ playing: false });
        void window.video.audioFocusAck(serial).catch(report);
      }),
    [],
  );
  async function startMusic() {
    const element = audio.current;
    const current = usePlayback.getState();
    if (
      !element ||
      !current.track ||
      !current.playing ||
      !element.getAttribute("src")
    )
      return;
    const request = ++playRequest.current;
    const trackId = current.track.id;
    try {
      const granted = await window.video.musicFocus();
      const next = usePlayback.getState();
      if (
        !granted ||
        request !== playRequest.current ||
        !next.playing ||
        next.track?.id !== trackId
      )
        return;
      ensureAudioGraph();
      void audioGraph.current?.context.resume();
      await element.play();
    } catch (error: any) {
      if (request === playRequest.current && error.name !== "AbortError") {
        usePlayback.setState({ playing: false });
        report(new Error("无法播放该音频，请检查文件或编码"));
      }
    }
  }
  const lyricsOwner = useRef("");
  useEffect(() => startLyricClock(() => audio.current), []);
  useEffect(() => {
    const clear = () => {
      const element = audio.current;
      element?.pause();
      element?.removeAttribute("src");
      element?.load();
      setAudioUrl(undefined);
      setLyrics([]);
      publishLyrics(undefined, [], 0);
    };
    window.addEventListener("music-stop-and-clear", clear);
    return () => window.removeEventListener("music-stop-and-clear", clear);
  }, []);
  const audioGraph = useRef<{
    context: AudioContext;
    filters: BiquadFilterNode[];
    gain: GainNode;
    analyser: AnalyserNode;
    effects: ReturnType<typeof createEffects>;
  } | null>(null);
  const audioGraphAttempted = useRef(false);
  const audioRecovery = useRef(0);
  useEffect(() => {
    let live = true;
    setAudioUrl(undefined);
    audioRecovery.current = 0;
    const item = state.track;
    if (item) {
      if (!isRemote(item)) setAudioUrl(resource(item));
      else
        void resolveAudio(item)
          .then((url) => {
            if (live) setAudioUrl(url);
          })
          .catch((error) => {
            if (live) {
              usePlayback.setState({ playing: false });
              report(error);
            }
          });
    }
    return () => {
      live = false;
    };
  }, [state.track?.id]);
  const remoteFavoriteBusy = useRef(false);
  useEffect(
    () =>
      window.music.onCommand((command, value) => {
        const p = usePlayback.getState();
        if (command === "toggle") p.toggle();
        if (command === "play" || command === "pause")
          usePlayback.setState({ playing: command === "play" });
        if (command === "next" || command === "previous")
          void p.next(command === "next" ? 1 : -1);
        if (command === "seek" && Number.isFinite(value))
          p.seekTo(Math.max(0, Math.min(p.duration || value!, value!)));
        if (command === "expand")
          usePlayback.setState({ expanded: true, queueVisible: false });
        if (command === "queue")
          usePlayback.setState({ expanded: true, queueVisible: true });
        if (command === "repeat")
          usePlayback.setState({
            repeat:
              p.repeat === "off" ? "all" : p.repeat === "all" ? "one" : "off",
          });
        if (command === "order")
          usePlayback.setState({
            order: p.order === "sequential" ? "shuffle" : "sequential",
          });
        if (command === "mute") usePlayback.setState({ muted: !p.muted });
        if (command === "volume" && Number.isFinite(value))
          usePlayback.setState({ volume: Math.max(0, Math.min(1, value!)) });
        if (command === "favorite" && p.track && !remoteFavoriteBusy.current) {
          const item = p.track;
          const favorite = !item.favorite;
          remoteFavoriteBusy.current = true;
          void (async () => {
            if (isRemote(item)) await favoriteRemote(item, favorite);
            else await window.media.favorite(item.id, favorite);
            usePlayback.setState((current) => ({
              track:
                current.track?.id === item.id
                  ? { ...current.track, favorite }
                  : current.track,
              queue: current.queue.map((song) =>
                song.id === item.id ? { ...song, favorite } : song,
              ),
            }));
            useApp.getState().touch();
          })()
            .catch(report)
            .finally(() => {
              remoteFavoriteBusy.current = false;
            });
        }
      }),
    [],
  );
  const [lyrics, setLyrics] = useState<ReturnType<typeof parseLrc>>([]);
  const queueVisible = state.queueVisible;
  const setQueueVisible = (queueVisible: boolean) =>
    usePlayback.setState({ queueVisible });
  const [queuePage, setQueuePage] = useState(0);
  const [queueRows, setQueueRows] = useState<MediaItem[]>([]);
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]);
  const [playlistName, setPlaylistName] = useState("");
  const [playlistTab, setPlaylistTab] = useState(false);
  const matchOpen = state.matchOpen;
  const setMatchOpen = (matchOpen: boolean) =>
    !matchOpen && closeUI
      ? closeUI(() => usePlayback.setState({ matchOpen }))
      : usePlayback.setState({ matchOpen });
  const [matchLoading, setMatchLoading] = useState(false);
  const [candidates, setCandidates] = useState<MusicMetadataCandidate[]>([]);
  const [candidate, setCandidate] = useState<MusicMetadataCandidate | null>(
    null,
  );
  const [matchFields, setMatchFields] = useState<string[]>([
    "title",
    "artist",
    "album",
    "cover",
    "lyric",
  ]);
  const [dragQueueIndex, setDragQueueIndex] = useState<number | null>(null);
  const [analyzedGainDb, setAnalyzedGainDb] = useState<number | null>(null);
  const track = state.track;
  useEffect(() => {
    setAnalyzedGainDb(null);
    if (
      !track ||
      isRemote(track) ||
      !settings.loudnessNormalization ||
      Number.isFinite(track.replayGainDb)
    )
      return;
    let live = true;
    void window.media
      .analyzeLoudness(track.id)
      .then((gainDb) => {
        if (live) setAnalyzedGainDb(gainDb);
      })
      .catch((error) => {
        if (live) report(error);
      });
    return () => {
      live = false;
    };
  }, [track?.id, track?.replayGainDb, settings.loudnessNormalization]);
  function ensureAudioGraph() {
    if (!audio.current || audioGraph.current || audioGraphAttempted.current)
      return;
    audioGraphAttempted.current = true;
    let context: AudioContext | undefined;
    let source: MediaElementAudioSourceNode | undefined;
    try {
      const audioContext = new AudioContext();
      context = audioContext;
      const frequencies = [
        31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
      ];
      const filters = frequencies.map((frequency, index) => {
        const filter = audioContext.createBiquadFilter();
        filter.type =
          index === 0 ? "lowshelf" : index === 9 ? "highshelf" : "peaking";
        filter.frequency.value = frequency;
        filter.Q.value = 1;
        return filter;
      });
      const gain = audioContext.createGain();
      source = audioContext.createMediaElementSource(audio.current);
      source.connect(filters[0]);
      filters.forEach((filter, index) =>
        filter.connect(filters[index + 1] ?? gain),
      );
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      gain.connect(analyser);
      analyser.connect(audioContext.destination);
      filters.at(-1)!.disconnect();
      const effects = createEffects(audioContext, filters.at(-1)!, gain);
      audioGraph.current = {
        context: audioContext,
        filters,
        gain,
        analyser,
        effects,
      };
    } catch (error) {
      console.error("Audio processing is unavailable:", error);
      if (source && context) {
        try {
          source.disconnect();
          source.connect(context.destination);
        } catch {
          /* Keep the player running if optional processing cannot connect. */
        }
      } else if (context) {
        void context.close();
      }
    }
  }
  useEffect(() => {
    if (settings.equalizerEnabled || settings.loudnessNormalization)
      ensureAudioGraph();
    const graph = audioGraph.current;
    if (!graph) return;
    graph.filters.forEach((filter, index) => {
      filter.gain.value = settings.equalizerEnabled
        ? (settings.equalizerBands[index] ?? 0)
        : 0;
    });
    const replayGain = Number.isFinite(track?.replayGainDb)
      ? track?.replayGainDb
      : analyzedGainDb;
    graph.gain.gain.value =
      settings.loudnessNormalization && Number.isFinite(replayGain)
        ? Math.pow(10, Math.max(-12, Math.min(12, replayGain!)) / 20)
        : 1;
  }, [
    settings.equalizerEnabled,
    settings.equalizerBands,
    settings.loudnessNormalization,
    track?.id,
    track?.replayGainDb,
    analyzedGainDb,
  ]);
  useEffect(() => {
    audioGraph.current?.effects.apply(
      effectsState.effects,
      effectsState.enabled,
    );
  }, [effectsState.effects, effectsState.enabled]);
  useEffect(
    () => () => {
      const graph = audioGraph.current;
      audioGraph.current = null;
      if (graph) {
        graph.effects.dispose();
        void graph.context.close();
      }
    },
    [],
  );
  useEffect(() => {
    const element = audio.current as
      (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!element?.setSinkId) return;
    void element.setSinkId(settings.audioOutputDeviceId).catch(async () => {
      await useApp.getState().setSettings({
        ...useApp.getState().settings,
        audioOutputDeviceId: "",
      });
      useApp.getState().notify("输出设备不可用，已切回系统默认设备", "error");
    });
  }, [settings.audioOutputDeviceId]);
  useEffect(() => {
    if (!settings.sleepTimerMinutes) return;
    const timer = window.setTimeout(() => {
      usePlayback.setState({ playing: false });
      void useApp.getState().setSettings({
        ...useApp.getState().settings,
        sleepTimerMinutes: 0,
      });
      useApp.getState().notify("睡眠定时结束，音乐已暂停");
    }, settings.sleepTimerMinutes * 60_000);
    return () => window.clearTimeout(timer);
  }, [settings.sleepTimerMinutes]);
  useEffect(() => {
    if (!track || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || "本地音乐",
      album: track.album || "",
      artwork: track.cover
        ? [
            {
              src: resource(track, "cover"),
              sizes: "640x640",
              type: "image/jpeg",
            },
          ]
        : [],
    });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => usePlayback.setState({ playing: true })],
      ["pause", () => usePlayback.setState({ playing: false })],
      ["previoustrack", () => void usePlayback.getState().next(-1)],
      ["nexttrack", () => void usePlayback.getState().next(1)],
      [
        "seekto",
        (details) => {
          if (details.seekTime != null)
            usePlayback.getState().seekTo(details.seekTime);
        },
      ],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        /* Unsupported media key. */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          /* Unsupported media key. */
        }
      }
    };
  }, [track?.id]);
  useEffect(() => {
    if (!queueVisible || playlistTab) return;
    const start = queuePage * 100;
    let live = true;
    void musicItems(state.queueIds.slice(start, start + 100))
      .then((rows) => {
        if (live) setQueueRows(rows);
      })
      .catch(report);
    return () => {
      live = false;
    };
  }, [queueVisible, playlistTab, queuePage, state.queueIds]);
  useEffect(() => {
    if (queueVisible && playlistTab)
      void window.music.playlists().then(setPlaylists).catch(report);
  }, [queueVisible, playlistTab]);
  useEffect(() => {
    if (!track) return;
    let live = true;
    lyricsOwner.current = "";
    setLyrics([]);
    publishLyrics(track.id, [], 0);
    void (
      isRemote(track)
        ? onlineLyrics(track).then(
            (result) =>
              result?.lyrics?.lines?.map((line: any) => ({
                time: line.startTime,
                text: line.fullText,
                translation: line.translation,
                romanization: line.romanization,
                words: result.lyrics.isWordByWord
                  ? line.words?.map((word: any) => ({
                      time: word.startTime,
                      duration: word.endTime - word.startTime,
                      text: word.text,
                    }))
                  : undefined,
              })) ?? (result?.mainText ? parseLrc(result.mainText) : []),
          )
        : window.media
            .lyrics(track.id)
            .then((text) => (text ? parseLrc(text) : []))
    )
      .then((lines) => {
        if (live) {
          lyricsOwner.current = track.id;
          setLyrics(lines);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [track?.id]);
  useEffect(() => {
    const element = audio.current;
    if (!element || !track || !audioUrl) return;
    if (state.playing) {
      void startMusic();
    } else {
      ++playRequest.current;
      element.pause();
    }
    return () => {
      ++playRequest.current;
    };
  }, [track?.id, state.playing, audioUrl]);
  useEffect(() => {
    if (audio.current) {
      audio.current.volume = state.volume;
      audio.current.muted = state.muted;
    }
  }, [state.volume, state.muted]);
  useEffect(() => {
    if (audio.current && track && Number.isFinite(state.seek.value))
      audio.current.currentTime = state.seek.value;
  }, [state.seek.serial]);
  useEffect(() => {
    const flush = () => {
      const s = usePlayback.getState();
      if (s.track && audio.current && !isRemote(s.track)) {
        void window.media
          .saveMusicSession({
            origin: s.origin,
            trackId: s.track.id,
            queueIds: s.queueIds,
            position: 0,
            volume: s.volume,
            muted: s.muted,
            repeat: s.repeat,
            order: s.order,
          })
          .catch(() => {});
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);
  const activeIndex = lyrics.findLastIndex(
    (line) => line.time <= state.position,
  );
  useEffect(() => {
    publishLyrics(
      track?.id,
      lyricsOwner.current === track?.id ? lyrics : [],
      state.duration,
    );
  }, [track?.id, lyrics, state.duration]);
  useEffect(() => {
    usePlayback.setState({ lyricPreview: lyrics[activeIndex]?.text ?? "" });
  }, [activeIndex, lyrics]);
  useEffect(() => {
    window.music.publish({
      trackId: track?.id ?? "",
      title: track?.title ?? "",
      artist: track?.artist ?? "",
      cover: track?.cover ? resource(track, "cover") : undefined,
      favorite: !!track?.favorite,
      volume: state.volume,
      muted: state.muted,
      repeat: state.repeat,
      order: state.order,
      reducedMotion: settings.reducedMotion,
      duration: state.duration,
    });
  }, [
    track?.id,
    track?.title,
    track?.artist,
    track?.cover,
    track?.favorite,
    state.volume,
    state.muted,
    state.repeat,
    state.order,
    state.duration,
    settings.reducedMotion,
  ]);
  useEffect(() => {
    window.music.publish({
      lyrics: lyricsOwner.current === track?.id ? lyrics : [],
    });
  }, [track?.id, lyrics]);
  useEffect(() => {
    const publish = () => {
      const current = usePlayback.getState();
      window.music.publish({
        playing: current.playing,
        position: current.position,
        updatedAt: Date.now(),
      });
    };
    publish();
    const timer = window.setInterval(publish, 500);
    return () => window.clearInterval(timer);
  }, [track?.id, state.playing, state.seek.serial]);
  function tick() {
    if (
      !track ||
      usePlayback.getState().track?.id !== track.id ||
      !audio.current?.getAttribute("src")
    )
      return;
    const element = audio.current!;
    usePlayback.setState({ position: element.currentTime });
  }

  function end() {
    if (!track) return;
    if (state.repeat === "one") {
      audio.current!.currentTime = 0;
      void startMusic();
    } else if (state.queueIds.length > 1 || state.repeat === "all")
      void state.next();
    else usePlayback.setState({ playing: false, position: 0 });
  }
  const controls = (
    <div className="transport">
      <IconButton label="上一首" onClick={() => state.next(-1)}>
        <SkipBack size={19} fill="currentColor" />
      </IconButton>
      <button
        className="play-button"
        title={state.playing ? "暂停" : "播放"}
        aria-label={state.playing ? "暂停音乐" : "播放音乐"}
        onClick={state.toggle}
      >
        {state.playing ? (
          <Pause size={20} fill="currentColor" />
        ) : (
          <Play size={20} fill="currentColor" />
        )}
      </button>
      <IconButton label="下一首" onClick={() => state.next()}>
        <SkipForward size={19} fill="currentColor" />
      </IconButton>
    </div>
  );
  async function refreshPlaylists() {
    setPlaylists(await window.music.playlists());
  }
  async function createPlaylist() {
    const name = playlistName.trim();
    if (!name) return;
    const now = Date.now();
    await window.music.savePlaylist({
      id: crypto.randomUUID(),
      name,
      songIds: [],
      createdAt: now,
      updatedAt: now,
    });
    setPlaylistName("");
    await refreshPlaylists();
  }
  async function savePlaylist(playlist: MusicPlaylist) {
    await window.music.savePlaylist({
      ...playlist,
      updatedAt: Date.now(),
    });
    await refreshPlaylists();
  }
  async function playPlaylist(playlist: MusicPlaylist) {
    const ids = playlist.songIds;
    if (!ids.length) return;
    const songs = await musicItems(ids.slice(0, 1000));
    if (!songs.length) return;
    usePlayback.getState().setQueueIds(ids);
    usePlayback.getState().play(songs[0], songs);
    usePlayback.getState().setQueueIds(ids);
    setQueueVisible(false);
  }
  async function openMetadataMatch() {
    if (!track) return;
    setMatchOpen(true);
    setMatchLoading(true);
    setCandidate(null);
    try {
      setCandidates(await window.media.searchMusicMetadata(track.id));
    } catch (error) {
      report(error);
    } finally {
      setMatchLoading(false);
    }
  }
  async function applyMetadataMatch() {
    if (!track || !candidate) return;
    await window.media.applyMusicCandidate(track.id, candidate, matchFields);
    const [updated] = await musicItems([track.id]);
    if (updated)
      usePlayback.setState((current) => ({
        track: updated,
        queue: current.queue.map((song) =>
          song.id === updated.id ? updated : song,
        ),
      }));
    useApp.getState().notify("已应用所选音乐信息，可随时恢复原始导入信息");
    setMatchOpen(false);
  }
  async function restoreMusicMetadata() {
    if (!track) return;
    await window.media.restoreMusicMetadata(track.id);
    const [updated] = await musicItems([track.id]);
    if (updated)
      usePlayback.setState((current) => ({
        track: updated,
        queue: current.queue.map((song) =>
          song.id === updated.id ? updated : song,
        ),
      }));
    useApp.getState().notify("已恢复原始导入信息");
  }
  return (
    <>
      <audio
        ref={audio}
        crossOrigin="anonymous"
        preload="auto"
        src={audioUrl}
        onError={() => {
          const item = usePlayback.getState().track;
          if (!item) return;
          if (isRemote(item) && audioRecovery.current++ === 0) {
            void resolveAudio(item)
              .then((url) => {
                if (usePlayback.getState().track?.id !== item.id) return;
                setAudioUrl(url);
                if (audio.current?.src === url) audio.current.load();
              })
              .catch((error) => {
                usePlayback.setState({ playing: false });
                report(error);
              });
          } else {
            usePlayback.setState({ playing: false });
            report(new Error("音频无法解码或播放资源已失效"));
          }
        }}
        onTimeUpdate={tick}
        onEnded={end}
        onCanPlay={() => {
          void startMusic();
        }}
        onLoadedMetadata={() => {
          const element = audio.current!;
          usePlayback.setState({
            duration: Number.isFinite(element.duration) ? element.duration : 0,
          });
          element.currentTime = Math.min(
            usePlayback.getState().position,
            Math.max(0, element.duration - 0.5),
          );
        }}
      />
      {queueVisible && track && (
        <aside
          className={`queue-panel ${state.expanded ? "queue-in-stage" : ""}`}
        >
          <div className="section-heading">
            <h3>
              {playlistTab ? "本地歌单" : "正在播放"}{" "}
              <span>
                {playlistTab ? playlists.length : state.queueIds.length}
              </span>
            </h3>
            <div className="queue-panel-actions">
              <button
                className={playlistTab ? "text-button" : "text-button active"}
                onClick={() => setPlaylistTab(false)}
              >
                队列
              </button>
              <button
                className={playlistTab ? "text-button active" : "text-button"}
                onClick={() => setPlaylistTab(true)}
              >
                歌单
              </button>
              {!playlistTab && (
                <button
                  className="text-button"
                  onClick={() => usePlayback.getState().clearQueue()}
                >
                  清空
                </button>
              )}
              <button
                className="text-button"
                onClick={() => setQueueVisible(false)}
              >
                收起
              </button>
            </div>
          </div>
          {!playlistTab ? (
            <>
              {queueRows.map((song, rowIndex) => {
                const absoluteIndex = queuePage * 100 + rowIndex;
                return (
                  <div
                    className={`queue-entry ${song.id === track.id ? "queue-active" : ""}`}
                    key={`${song.id}:${absoluteIndex}`}
                    draggable
                    onDragStart={() => setDragQueueIndex(absoluteIndex)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragQueueIndex != null)
                        usePlayback
                          .getState()
                          .reorderQueue(dragQueueIndex, absoluteIndex);
                      setDragQueueIndex(null);
                    }}
                    onDragEnd={() => setDragQueueIndex(null)}
                  >
                    <button
                      className="queue-entry-main"
                      onClick={() => usePlayback.getState().play(song)}
                    >
                      <span>{String(absoluteIndex + 1).padStart(2, "0")}</span>
                      <Cover item={song} />
                      <strong>{song.title}</strong>
                      {song.id === track.id && <Music2 size={16} />}
                    </button>
                    <button
                      aria-label={`从队列移除 ${song.title}`}
                      className="queue-remove"
                      onClick={() =>
                        usePlayback.getState().removeQueueId(song.id)
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })}
              <div className="queue-pagination">
                <button
                  className="text-button"
                  disabled={!queuePage}
                  onClick={() => setQueuePage((page) => Math.max(0, page - 1))}
                >
                  上一页
                </button>
                <span>
                  {queuePage + 1} /{" "}
                  {Math.max(1, Math.ceil(state.queueIds.length / 100))}
                </span>
                <button
                  className="text-button"
                  disabled={(queuePage + 1) * 100 >= state.queueIds.length}
                  onClick={() => setQueuePage((page) => page + 1)}
                >
                  下一页
                </button>
              </div>
            </>
          ) : (
            <>
              <form
                className="playlist-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createPlaylist().catch(report);
                }}
              >
                <input
                  aria-label="新歌单名称"
                  placeholder="新建歌单"
                  value={playlistName}
                  onChange={(event) => setPlaylistName(event.target.value)}
                />
                <button type="submit" aria-label="创建歌单">
                  <Check size={15} />
                </button>
              </form>
              {playlists.map((playlist) => (
                <details className="playlist-entry" key={playlist.id}>
                  <summary>
                    <input
                      aria-label={`歌单名称 ${playlist.name}`}
                      value={playlist.name}
                      onChange={(event) =>
                        setPlaylists((entries) =>
                          entries.map((entry) =>
                            entry.id === playlist.id
                              ? { ...entry, name: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      onClick={(event) => event.stopPropagation()}
                      onBlur={() => {
                        const current = playlists.find(
                          (entry) => entry.id === playlist.id,
                        );
                        if (current?.name.trim())
                          void savePlaylist(current).catch(report);
                      }}
                    />
                    <span>{playlist.songIds.length}</span>
                    <button
                      type="button"
                      aria-label={`播放歌单 ${playlist.name}`}
                      onClick={(event) => {
                        event.preventDefault();
                        void playPlaylist(playlist).catch(report);
                      }}
                    >
                      <Play size={14} />
                    </button>
                    {track && (
                      <button
                        type="button"
                        aria-label={`添加当前歌曲到 ${playlist.name}`}
                        onClick={(event) => {
                          event.preventDefault();
                          void savePlaylist({
                            ...playlist,
                            songIds: [
                              ...new Set([...playlist.songIds, track.id]),
                            ],
                          }).catch(report);
                        }}
                      >
                        <Check size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`删除歌单 ${playlist.name}`}
                      onClick={(event) => {
                        event.preventDefault();
                        void window.music
                          .deletePlaylist(playlist.id)
                          .then(refreshPlaylists)
                          .catch(report);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </summary>
                  <div className="playlist-songs">
                    {playlist.songIds.map((id) => (
                      <div key={id}>
                        <span>
                          {id === track.id ? track.title : id.slice(0, 12)}
                        </span>
                        <button
                          aria-label="从歌单移除歌曲"
                          onClick={() =>
                            void savePlaylist({
                              ...playlist,
                              songIds: playlist.songIds.filter(
                                (entry) => entry !== id,
                              ),
                            }).catch(report)
                          }
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </>
          )}
        </aside>
      )}
      {state.expanded && track && (
        <div className="music-stage lyrics-only">
          <div
            className="stage-light"
            style={
              track.cover
                ? { backgroundImage: `url("${resource(track, "cover")}")` }
                : {}
            }
          />
          <header>
            <span className="eyebrow">正在播放</span>
            <div className="stage-header-actions">
              <button
                className="text-button"
                onClick={() => void window.music.window("mini").catch(report)}
              >
                迷你窗口
              </button>
              <IconButton
                label="收起播放器"
                onClick={() =>
                  closeDetail
                    ? closeDetail()
                    : usePlayback.setState({ expanded: false })
                }
              >
                <ChevronDown size={25} />
              </IconButton>
            </div>
          </header>
          <Suspense
            fallback={<div className="scene-loading">加载歌词动画…</div>}
          >
            <FoliaStage
              track={{
                ...track,
                coverUrl: track.cover ? resource(track, "cover") : undefined,
              }}
              lyrics={lyrics}
              position={state.position}
              duration={state.duration}
              playing={state.playing}
              reducedMotion={settings.reducedMotion}
              seek={(value) => usePlayback.getState().seekTo(value)}
              analyser={audioGraph.current?.analyser}
            />
          </Suspense>
          <div className="music-stage-transport">{controls}</div>
        </div>
      )}
      {matchOpen && (
        <Modal
          title="在线匹配音乐信息"
          close={() => setMatchOpen(false)}
          className="music-match-modal"
        >
          <p className="music-match-note">
            在线结果只在你启动匹配后搜索。勾选需要应用的字段；原始导入信息可以恢复。AMLL
            提供逐字歌词。
          </p>
          <div className="music-match-fields">
            {["title", "artist", "album", "cover", "lyric"].map((field) => (
              <label key={field}>
                <input
                  type="checkbox"
                  disabled={candidate?.source === "amll" && field !== "lyric"}
                  checked={matchFields.includes(field)}
                  onChange={(event) =>
                    setMatchFields((current) =>
                      event.target.checked
                        ? [...new Set([...current, field])]
                        : current.filter((entry) => entry !== field),
                    )
                  }
                />
                {
                  (
                    {
                      title: "标题",
                      artist: "艺术家",
                      album: "专辑",
                      cover: "封面",
                      lyric: "歌词",
                    } as Record<string, string>
                  )[field]
                }
              </label>
            ))}
          </div>
          <div className="music-match-results">
            {matchLoading ? (
              <p>正在搜索网易云、QQ 音乐与 AMLL…</p>
            ) : candidates.length ? (
              candidates.map((entry) => (
                <button
                  key={`${entry.source}:${entry.platform ?? ""}:${entry.remoteId}`}
                  className={
                    candidate?.remoteId === entry.remoteId &&
                    candidate.source === entry.source &&
                    candidate.platform === entry.platform
                      ? "selected"
                      : ""
                  }
                  onClick={() => {
                    setCandidate(entry);
                    if (entry.source === "amll") setMatchFields(["lyric"]);
                  }}
                >
                  <span className="match-source">
                    {entry.source === "netease"
                      ? "网易云"
                      : entry.source === "qq"
                        ? "QQ 音乐"
                        : entry.source === "kugou"
                          ? "酷狗"
                          : `AMLL · ${entry.platform === "ncm" ? "网易云" : "QQ 音乐"}`}
                  </span>
                  <strong>{entry.title}</strong>
                  <small>
                    {entry.artist || "未知艺术家"}
                    {entry.album ? ` · ${entry.album}` : ""}
                  </small>
                </button>
              ))
            ) : (
              <p>没有找到匹配结果</p>
            )}
          </div>
          <footer>
            <button
              className="button secondary"
              onClick={() => setMatchOpen(false)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={!candidate || !matchFields.length || matchLoading}
              onClick={() => void applyMetadataMatch().catch(report)}
            >
              应用选中字段
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
