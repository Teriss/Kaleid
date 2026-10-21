import { useEffect, useRef, useState } from "react";
import type {
  NavigationEntry,
  BrowseLocation,
} from "../../../shared/navigation";
import type { MediaLayout } from "../../../shared/types";
import { scopeKey } from "./memory";
import {
  flightBoxKeyframes,
  FLIGHT_MS,
  HANDOVER_MS,
  flyInAnimation,
  collectionMorphFlyIn,
  collectionMorphSeed,
  collectionMorphEntranceTravel,
  scatterPush,
} from "./foliaGeometry";
import { wallTransition } from "./wallTransition";

type Card = { node: HTMLElement; rect: DOMRect };
function cards(): Card[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      ".layout-surface .poster,.layout-surface .media-row,.type-library-page .library-carousel-card,.type-library-page .type-library-entry:not(.create-library-entry)",
    ),
  )
    .map((node) => ({ node, rect: node.getBoundingClientRect() }))
    .filter(
      ({ rect }) =>
        rect.width > 0 &&
        rect.right > 0 &&
        rect.left < innerWidth &&
        rect.bottom > 36 &&
        rect.top < innerHeight,
    );
}
export function isContentNavigation(from: BrowseLocation, to: BrowseLocation) {
  return (
    (from.view === "library" &&
      to.view === "library" &&
      from.libraryId === to.libraryId &&
      from.folder !== to.folder) ||
    (from.view === "music" &&
      to.view === "music" &&
      from.musicSource === to.musicSource &&
      from.providerId === to.providerId &&
      (from.section === "collection" || to.section === "collection") &&
      scopeKey(from) !== scopeKey(to))
  );
}
export function wallNavigationDirection(
  from: BrowseLocation,
  to: BrowseLocation,
): "push" | "back" | "replace" {
  if (!isContentNavigation(from, to)) return "replace";
  if (from.view === "library" && to.view === "library") {
    const parent = to.folder?.replace(/[\\/]+$/, "");
    const child = from.folder?.replace(/[\\/]+$/, "");
    if (
      child &&
      (!parent ||
        child
          .toLowerCase()
          .startsWith(
            parent.toLowerCase() + (child.includes("\\") ? "\\" : "/"),
          ))
    )
      return "back";
  }
  if (
    from.view === "music" &&
    from.section === "collection" &&
    to.section !== "collection"
  )
    return "back";
  return "push";
}
export default function useBrowseTransition(reducedMotion: boolean) {
  const [pending, setPending] = useState(false);
  const active = useRef<{
    previous: NavigationEntry;
    target: BrowseLocation;
    layout: MediaLayout;
    layer: HTMLElement | null;
    source: Card | undefined;
    origin: { x: number; y: number };
    animations: Animation[];
    flights: HTMLElement[];
    started: boolean;
    token: number;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const serial = useRef(0),
    lastClick = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const clicked = (e: PointerEvent) => {
      lastClick.current = (e.target as HTMLElement).closest(
        ".poster,.media-row,.library-carousel-card,.type-library-entry",
      );
    };
    document.addEventListener("pointerup", clicked, true);
    return () => document.removeEventListener("pointerup", clicked, true);
  }, []);
  const finish = () => {
    const value = active.current;
    if (!value) return;
    active.current = null;
    clearTimeout(value.timer);
    value.animations.forEach((a) => a.cancel());
    value.layer?.remove();
    value.flights.forEach((node) => node.remove());
    document.documentElement.removeAttribute("data-browse-transition");
    wallTransition.active = false;
    wallTransition.settle(wallTransition.token);
    setPending(false);
  };
  useEffect(() => finish, []);
  useEffect(() => {
    if (reducedMotion) finish();
  }, [reducedMotion]);
  function start(
    previous: NavigationEntry,
    target: BrowseLocation,
    layout: MediaLayout = previous.memory.layout,
  ) {
    if (
      scopeKey(previous.scope) === scopeKey(target) &&
      layout === previous.memory.layout
    )
      return;
    const old = active.current;
    // A pending load may be superseded; retain its original visual buffer.
    if (old && !old.started) {
      old.target = target;
      old.layout = layout;
      old.token = ++serial.current;
      wallTransition.token = old.token;
      wallTransition.direction = wallNavigationDirection(
        previous.scope,
        target,
      );
      wallTransition.kind = (previous.memory.layout === "bravais" && layout === "bravais") || isContentNavigation(previous.scope, target)
        ? "flip"
        : "wave";
      return;
    }
    finish();
    const visible = cards(),
      clicked = lastClick.current;
    const source =
      visible.find((c) => c.node === clicked) ??
      visible.find((c) => c.node.matches(".is-focused,.is-selected"));
    const origin = source
      ? {
          x: source.rect.x + source.rect.width / 2,
          y: source.rect.y + source.rect.height / 2,
        }
      : { x: innerWidth / 2, y: innerHeight / 2 };
    const wall = previous.memory.layout === "bravais" && layout === "bravais";
    let layer: HTMLElement | null = null;
    if (!wall) {
      layer = document.createElement("div");
      layer.className = "browse-transition-layer";
      layer.inert = true;
      layer.setAttribute("aria-hidden", "true");
      for (const { node, rect } of visible.slice(0, 400)) {
        const carrier = document.createElement("div");
        carrier.className = "transition-card";
        Object.assign(carrier.style, {
          left: rect.x + "px",
          top: rect.y + "px",
          width: rect.width + "px",
          height: rect.height + "px",
          overflow: "hidden",
        });
        const clone = node.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            "canvas,.card-lyrics-host,.tile-actions,.wall-playback-controls",
          )
          .forEach((n) => n.remove());
        clone
          .querySelectorAll("[id],[aria-label],[data-media-id]")
          .forEach((n) => {
            n.removeAttribute("id");
            n.removeAttribute("aria-label");
            n.removeAttribute("data-media-id");
          });
        Object.assign(clone.style, {
          position: "relative",
          left: "0",
          top: "0",
          width: node.offsetWidth + "px",
          height: node.offsetHeight + "px",
          transform: `scale(${rect.width / Math.max(1, node.offsetWidth)},${rect.height / Math.max(1, node.offsetHeight)})`,
          transformOrigin: "0 0",
          opacity: "1",
        });
        carrier.appendChild(clone);
        layer.appendChild(carrier);
      }
      document.body.appendChild(layer);
      document.documentElement.setAttribute(
        "data-browse-transition",
        "pending",
      );
    }
    const token = ++serial.current;
    Object.assign(wallTransition, {
      active: wall && !reducedMotion,
      token,
      origin,
      kind: wall || isContentNavigation(previous.scope, target) ? "flip" : "wave",
      startSlotKey:
        wallNavigationDirection(previous.scope, target) === "push"
          ? source?.node.dataset.instance
          : undefined,
      direction: wallNavigationDirection(previous.scope, target),
    });
    lastClick.current = null;
    if (wall) wallTransition.begin();
    active.current = {
      previous,
      target,
      layout,
      layer,
      source,
      origin,
      animations: [],
      flights: [],
      started: false,
      token,
    };
    setPending(true);
  }
  async function reveal() {
    const value = active.current;
    if (!value || value.started) return;
    if (document.querySelector('.layout-surface [data-layout-ready="false"]'))
      return;
    const incoming = cards();
    if (
      incoming.some(
        (c) => c.node.matches(".poster,.media-row") && !c.node.dataset.mediaId,
      )
    )
      return;
    value.started = true;
    if (!value.layer) {
      await wallTransition.completion;
      if (active.current === value) finish();
      return;
    }
    const animate = (
      node: HTMLElement,
      frames: Keyframe[],
      duration: number,
      delay = 0,
    ) => {
      const a = node.animate(frames, {
        duration,
        delay,
        easing: "cubic-bezier(.2,.7,.25,1)",
        fill: "both",
      });
      value.animations.push(a);
      return a.finished.catch(() => {});
    };
    const back =
      (value.previous.scope.folder?.length ?? 0) >
        (value.target.folder?.length ?? 0) ||
      (value.previous.scope.section === "collection" &&
        value.target.section !== "collection");
    const jobs: Promise<unknown>[] = [];
    if (back && value.previous.memory.layout === "spatial" && !reducedMotion) {
      const outgoing = Array.from(
        value.layer.querySelectorAll<HTMLElement>(".transition-card"),
      ).slice(0, 60);
      const farthest = Math.max(
        1,
        ...outgoing.map((node) => {
          const r = node.getBoundingClientRect();
          return Math.hypot(
            r.x + r.width / 2 - value.origin.x,
            r.y + r.height / 2 - value.origin.y,
          );
        }),
      );
      for (const [index, node] of outgoing.entries()) {
        const r = node.getBoundingClientRect(),
          push = scatterPush(
            { x: r.x + r.width / 2, y: r.y + r.height / 2 },
            value.origin,
            collectionMorphEntranceTravel({
              width: innerWidth,
              height: innerHeight,
            }),
            farthest,
            collectionMorphSeed(String(index)),
          );
        jobs.push(
          animate(
            node,
            [
              { translate: "0px 0px", rotate: "0deg", scale: "1" },
              {
                translate: `${push.x}px ${push.y}px`,
                rotate: `${push.rotate}deg`,
                scale: ".92",
              },
            ],
            420,
            push.delay,
          ),
        );
      }
    }
    // Finish the outgoing scene before exposing or starting any incoming card.
    jobs.push(
      animate(
        value.layer,
        [{ opacity: 1 }, { opacity: 0 }],
        reducedMotion
          ? 80
          : back && value.previous.memory.layout === "spatial"
            ? 490
            : 180,
      ),
    );
    await Promise.all(jobs);
    if (active.current !== value) return;
    value.layer.remove();
    jobs.length = 0;
    for (let i = 0; i < incoming.length; i++) {
      const { node, rect } = incoming[i];
      const distance = Math.hypot(
        rect.x + rect.width / 2 - value.origin.x,
        rect.y + rect.height / 2 - value.origin.y,
      );
      const stagger = reducedMotion ? 0 : Math.min(160, distance / 8);
      const mode = value.layout;
      if (mode === "spatial" && !reducedMotion) {
        const fly = collectionMorphFlyIn(
          { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
          value.origin,
          260,
          collectionMorphEntranceTravel({
            width: innerWidth,
            height: innerHeight,
          }),
          collectionMorphSeed(node.dataset.mediaId ?? String(i)),
        );
        const animation = flyInAnimation(fly),
          running = node.animate(animation.keyframes, animation.timing);
        value.animations.push(running);
        jobs.push(running.finished.catch(() => {}));
        continue;
      }
      const transform =
        mode === "verticalGallery"
          ? `translateY(${back ? -12 : 12}px)`
          : mode === "carousel"
            ? `translateX(${back ? -24 : 24}px) scale(.98)`
            : mode === "spatial"
              ? `translate(${(rect.x - innerWidth / 2) * 0.1}px,${(rect.y - innerHeight / 2) * 0.1}px) scale(.88)`
              : mode === "gallery"
                ? "translateY(8px)"
                : "scale(.98)";
      jobs.push(
        animate(
          node,
          reducedMotion
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                {
                  opacity: 0,
                  filter: mode === "spatial" ? "blur(3px)" : "none",
                  transform: `${node.style.transform || ""} ${transform}`,
                },
                {
                  opacity: 1,
                  filter: "none",
                  transform: node.style.transform || "none",
                },
              ],
          reducedMotion ? 120 : mode === "spatial" ? 440 : 220,
          stagger,
        ),
      );
    }
    document.documentElement.removeAttribute("data-browse-transition");
    const matchingCover =
      value.source &&
      incoming.find(
        (c) => c.node.dataset.mediaId === value.source!.node.dataset.mediaId,
      );
    const sourceKind = value.source?.node.dataset.entryKind;
    const collectionEntrance =
      isContentNavigation(value.previous.scope, value.target) &&
      (sourceKind === "folder" || sourceKind === "collection");
    const sameRangeLayoutSwitch =
      scopeKey(value.previous.scope) === scopeKey(value.target) &&
      value.previous.memory.layout !== value.layout &&
      Boolean(matchingCover);
    // An unrelated tab must never carry the old selected song/cover over its new scene.
    if (
      value.source &&
      !reducedMotion &&
      (collectionEntrance || sameRangeLayoutSwitch)
    ) {
      const target =
        incoming.find(
          (c) => c.node.dataset.mediaId === value.source!.node.dataset.mediaId,
        ) ??
        incoming.find((c) => c.node.classList.contains("is-focused")) ??
        incoming[0];
      const picture = value.source.node.querySelector("img");
      if (target && picture) {
        const r = target.rect,
          carrier = document.createElement("div");
        carrier.className = "collection-flight";
        Object.assign(carrier.style, {
          left: r.x + "px",
          top: r.y + "px",
          width: r.width + "px",
          height: r.height + "px",
        });
        const img = picture.cloneNode(true) as HTMLImageElement;
        img.style.objectFit = getComputedStyle(picture).objectFit;
        carrier.appendChild(img);
        document.body.appendChild(carrier);
        value.flights.push(carrier);
        const frames = flightBoxKeyframes(
          { rect: value.source.rect, radius: 8 },
          { rect: r, radius: 8 },
        );
        jobs.push(
          animate(carrier, frames.box, FLIGHT_MS)
            .then(() =>
              animate(carrier, [{ opacity: 1 }, { opacity: 0 }], HANDOVER_MS),
            )
            .then(() => {
              carrier.remove();
            }),
        );
      }
    }
    await Promise.all(jobs);
    if (active.current === value) finish();
  }
  return {
    pending,
    start,
    reveal,
    cancel: finish,
    previous: () => active.current?.previous,
    target: () => active.current?.target,
  };
}
