import { create } from "zustand";
import type { MediaItem } from "../../shared/types";
import type { VideoBounds, VideoState } from "../../shared/video";

interface Session {
  id: string;
  item?: MediaItem;
  state?: VideoState;
  bounds?: VideoBounds;
}
export const useVideoSession = create<Session>(() => ({ id: "" }));
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.video.onState((state) => {
    if (useVideoSession.getState().id === state.sessionId)
      useVideoSession.setState({ state });
  });
  window.addEventListener("beforeunload", () => {
    const id = useVideoSession.getState().id;
    if (id) {
      void hideVideo(id);
      void window.video.close(id).catch(() => {});
    }
  });
}
export async function startVideo(
  item: MediaItem,
  autoPlay: boolean,
  fromStart = false,
  id: string = crypto.randomUUID(),
  presentation: "card" | "embedded" = "embedded",
) {
  listen();
  useVideoSession.setState({ id, item, state: undefined, bounds: undefined });
  const initial = await window.video.open({
    mediaId: item.id,
    sessionId: id,
    autoPlay,
    fromStart,
    presentation,
  });
  if (useVideoSession.getState().id === id)
    useVideoSession.setState((current) => ({
      state: current.state ?? initial,
    }));
  return initial;
}
export function videoBounds(id: string, bounds: VideoBounds) {
  if (useVideoSession.getState().id !== id) return Promise.resolve();
  useVideoSession.setState({ bounds });
  return window.video.bounds(id, bounds);
}
export function hideVideo(id = useVideoSession.getState().id) {
  const current = useVideoSession.getState();
  if (!id || current.id !== id) return Promise.resolve();
  return videoBounds(id, {
    ...(current.bounds ?? { x: 0, y: 0, width: 1, height: 1 }),
    visible: false,
  }).catch(() => {});
}
export async function stopVideo(id = useVideoSession.getState().id) {
  if (!id) return;
  await hideVideo(id);
  await window.video.close(id);
  if (useVideoSession.getState().id === id)
    useVideoSession.setState({
      id: "",
      item: undefined,
      state: undefined,
      bounds: undefined,
    });
}
