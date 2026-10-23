import { ReaderWheelSequence } from "./readerNavigation";

export const READER_DRAG_THRESHOLD = 8;
export const PAGE_DRAG_THRESHOLD = 48;

export function pagedDragDirection(deltaX: number, deltaY: number) {
  if (
    Math.abs(deltaX) < PAGE_DRAG_THRESHOLD ||
    Math.abs(deltaX) <= Math.abs(deltaY) * 1.2
  )
    return 0;
  return deltaX < 0 ? 1 : -1;
}

export function pagedClickDirection(
  clientX: number,
  left: number,
  width: number,
) {
  const fraction = (clientX - left) / Math.max(1, width);
  return fraction < 0.23 ? -1 : fraction > 0.77 ? 1 : 0;
}

export function isReaderInteractiveTarget(target: EventTarget | null) {
  return (
    target != null &&
    (target as Node).nodeType === 1 &&
    Boolean(
      (target as Element).closest(
        'a,button,input,select,textarea,summary,[contenteditable="true"],[role="button"],[role="radio"],.epub-prev,.epub-next',
      ),
    )
  );
}

export function normalizeWheelDeltaY(
  deltaY: number,
  deltaMode: number,
  lineHeight: number,
  pageHeight: number,
) {
  if (deltaMode === 1) return deltaY * lineHeight;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}

export function attachReaderGestures(
  surface: HTMLElement,
  options: {
    mode(): "scroll" | "paged";
    textSelection(): boolean;
    onPage(direction: number): void;
    onWheelPage?(direction: number): void;
    onScroll?(x: number, y: number, source?: "wheel" | "drag"): void;
    onCenter(): void;
    scrollTarget?(): HTMLElement | null;
    onActivity?(): void;
  },
) {
  const view = surface.ownerDocument.defaultView;
  if (!view) return () => {};
  let pointer:
    | {
        id: number;
        x: number;
        y: number;
        lastX: number;
        lastY: number;
        scrollLeft: number;
        scrollTop: number;
        dragging: boolean;
      }
    | undefined;
  let ignoreClickUntil = 0;
  const wheelSequence = new ReaderWheelSequence();

  const scroller = () =>
    options.scrollTarget?.() ??
    (surface === surface.ownerDocument.documentElement
      ? (surface.ownerDocument.scrollingElement ?? surface)
      : surface);
  const onScrollbar = (event: MouseEvent | PointerEvent) => {
    const element = scroller() as HTMLElement;
    if (element.ownerDocument !== surface.ownerDocument) return false;
    if (element === surface.ownerDocument.scrollingElement) {
      const root = surface.ownerDocument.documentElement;
      const vertical = view.innerWidth - root.clientWidth;
      const horizontal = view.innerHeight - root.clientHeight;
      return (
        (vertical > 0 && event.clientX >= view.innerWidth - vertical) ||
        (horizontal > 0 && event.clientY >= view.innerHeight - horizontal)
      );
    }
    const bounds = element.getBoundingClientRect();
    const vertical = element.offsetWidth - element.clientWidth;
    const horizontal = element.offsetHeight - element.clientHeight;
    return (
      (vertical > 0 && event.clientX >= bounds.right - vertical) ||
      (horizontal > 0 && event.clientY >= bounds.bottom - horizontal)
    );
  };
  const down = (event: PointerEvent) => {
    if (
      options.textSelection() ||
      event.button !== 0 ||
      !event.isPrimary ||
      onScrollbar(event) ||
      isReaderInteractiveTarget(event.target)
    )
      return;
    options.onActivity?.();
    pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      scrollLeft: scroller().scrollLeft,
      scrollTop: scroller().scrollTop,
      dragging: false,
    };
  };
  const move = (event: PointerEvent) => {
    if (!pointer || event.pointerId !== pointer.id || options.textSelection())
      return;
    const deltaX = event.clientX - pointer.x;
    const deltaY = event.clientY - pointer.y;
    if (
      !pointer.dragging &&
      Math.hypot(deltaX, deltaY) >= READER_DRAG_THRESHOLD
    ) {
      pointer.dragging = true;
      ignoreClickUntil = Date.now() + 350;
    }
    if (!pointer.dragging) return;
    options.onActivity?.();
    event.preventDefault();
    if (options.mode() === "scroll") {
      if (options.onScroll) {
        options.onScroll(
          pointer.lastX - event.clientX,
          pointer.lastY - event.clientY,
          "drag",
        );
      } else {
        scroller().scrollLeft = pointer.scrollLeft - deltaX;
        scroller().scrollTop = pointer.scrollTop - deltaY;
      }
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
    }
  };
  const up = (event: PointerEvent) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const deltaX = event.clientX - pointer.x;
    const deltaY = event.clientY - pointer.y;
    const dragging = pointer.dragging;
    pointer = undefined;
    if (!dragging) return;
    options.onActivity?.();
    ignoreClickUntil = Date.now() + 350;
    if (options.mode() === "paged")
      options.onPage(pagedDragDirection(deltaX, deltaY));
    event.preventDefault();
  };
  const cancel = (event: PointerEvent) => {
    if (pointer?.id === event.pointerId) pointer = undefined;
  };
  const click = (event: MouseEvent) => {
    if (Date.now() < ignoreClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (
      options.textSelection() ||
      onScrollbar(event) ||
      !surface.contains(event.target as Node) ||
      isReaderInteractiveTarget(event.target) ||
      !surface.ownerDocument.getSelection()?.isCollapsed
    )
      return;
    if (options.mode() === "paged") {
      const rect = surface.getBoundingClientRect();
      const root = surface === surface.ownerDocument.documentElement;
      const direction = pagedClickDirection(
        event.clientX,
        root ? 0 : rect.left,
        root ? view.innerWidth : rect.width,
      );
      if (direction) {
        options.onPage(direction);
        return;
      }
    }
    options.onCenter();
  };
  const wheel = (event: WheelEvent) => {
    if (
      (options.textSelection() && options.mode() === "paged") ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
      !event.deltaY
    )
      return;
    if (options.mode() === "scroll") {
      const target = options.scrollTarget?.();
      if (!target) return;
      event.preventDefault();
      options.onActivity?.();
      const view = target.ownerDocument.defaultView;
      const lineHeight = Number.parseFloat(
        view?.getComputedStyle(target).lineHeight ?? "",
      );
      const size = Number.isFinite(lineHeight)
        ? lineHeight
        : Number.parseFloat(view?.getComputedStyle(target).fontSize ?? "16") *
          1.5;
      const delta = normalizeWheelDeltaY(
        event.deltaY,
        event.deltaMode,
        size || 24,
        target.clientHeight,
      );
      if (options.onScroll) options.onScroll(0, delta, "wheel");
      else target.scrollTop += delta;
      return;
    }
    if (options.mode() !== "paged" || isReaderInteractiveTarget(event.target))
      return;
    event.preventDefault();
    options.onActivity?.();
    if (options.onWheelPage) {
      options.onWheelPage(Math.sign(event.deltaY));
      return;
    }
    const direction = Math.sign(event.deltaY);
    if (wheelSequence.accept(performance.now(), direction))
      options.onPage(direction);
  };

  surface.addEventListener("pointerdown", down);
  view.addEventListener("pointermove", move, { passive: false });
  view.addEventListener("pointerup", up);
  view.addEventListener("pointercancel", cancel);
  surface.addEventListener("click", click);
  surface.addEventListener("wheel", wheel, { passive: false });
  return () => {
    surface.removeEventListener("pointerdown", down);
    view.removeEventListener("pointermove", move);
    view.removeEventListener("pointerup", up);
    view.removeEventListener("pointercancel", cancel);
    surface.removeEventListener("click", click);
    surface.removeEventListener("wheel", wheel);
  };
}
