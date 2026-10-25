const SPACE_TARGET_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "a[href]",
  "[role=button]",
  "[role=slider]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=menuitem]",
  "[contenteditable]:not([contenteditable='false'])",
].join(",");

export function isPlaybackSpaceShortcut(event: KeyboardEvent): boolean {
  if (
    (event.code !== "Space" && event.key !== " ") ||
    event.repeat ||
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return false;

  const target = event.target as Element | null;
  return !target?.closest?.(SPACE_TARGET_SELECTOR);
}
