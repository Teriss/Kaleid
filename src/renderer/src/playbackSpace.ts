import { isTextEntryTarget } from "./desktopInteraction";

export function shouldPreventPlaybackSpace(event: KeyboardEvent): boolean {
  if (event.code !== "Space" && event.key !== " ") return false;
  if (
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return false;
  return !isTextEntryTarget(event.target);
}

export function isPlaybackSpaceShortcut(event: KeyboardEvent): boolean {
  return (
    shouldPreventPlaybackSpace(event) &&
    !event.repeat &&
    !event.defaultPrevented
  );
}
