import { useEffect, useRef } from "react";
import type { MediaItem } from "../../shared/types";
import { resource } from "./store";

export default function useVideoPosters(items: MediaItem[]) {
  const seen = useRef(new Set<string>());
  const queue = useRef<MediaItem[]>([]);
  const running = useRef(false);
  useEffect(() => {
    for (const item of items)
      if (
        item.type === "video" &&
        !item.cover &&
        !item.missing &&
        !seen.current.has(
          `${item.id}:${item.resourceVersion ?? item.modifiedAt}`,
        )
      ) {
        seen.current.add(
          `${item.id}:${item.resourceVersion ?? item.modifiedAt}`,
        );
        queue.current.push(item);
      }
    if (running.current || !queue.current.length) return;
    running.current = true;
    void (async () => {
      while (queue.current.length) {
        const item = queue.current.shift()!;
        try {
          const data = await new Promise<string>((resolve, reject) => {
            const video = document.createElement("video");
            video.muted = true;
            video.preload = "auto";
            video.crossOrigin = "anonymous";
            const timer = setTimeout(
              () => finish(new Error("缩略图超时")),
              10000,
            );
            function finish(error?: Error, value?: string) {
              clearTimeout(timer);
              video.onloadedmetadata = null;
              video.onseeked = null;
              video.onerror = null;
              video.removeAttribute("src");
              video.load();
              if (error) reject(error);
              else resolve(value!);
            }
            video.onloadedmetadata = () => {
              video.currentTime = Math.min(
                1,
                Number.isFinite(video.duration) ? video.duration / 4 : 0.1,
              );
            };
            video.onseeked = () => {
              try {
                const canvas = document.createElement("canvas");
                canvas.width = 640;
                canvas.height =
                  Math.round((640 * video.videoHeight) / video.videoWidth) ||
                  360;
                canvas
                  .getContext("2d")!
                  .drawImage(video, 0, 0, canvas.width, canvas.height);
                finish(undefined, canvas.toDataURL("image/jpeg", 0.8));
              } catch (error) {
                finish(error as Error);
              }
            };
            video.onerror = () => finish(new Error("无法解码"));
            video.src = resource(item);
          });
          await window.media.setVideoCover(item.id, data);
        } catch {
          /* Keep the fallback cover when the codec is unavailable. */
        }
      }
      running.current = false;
    })();
  }, [items]);
}
