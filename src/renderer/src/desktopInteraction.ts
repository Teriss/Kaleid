const NON_TEXT_FOCUSABLE_SELECTOR = [
  "button",
  "select",
  "summary",
  "a[href]",
  "area[href]",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "input[type=button]",
  "input[type=submit]",
  "input[type=reset]",
  "input[type=checkbox]",
  "input[type=radio]",
  "input[type=range]",
  "input[type=color]",
  "input[type=file]",
  "input[type=image]",
  "[role=button]",
  "[role=slider]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=menuitem]",
  "[role=tab]",
  "[role=option]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "image",
]);

function closestElement(target: EventTarget | null): HTMLElement | null {
  const candidate = target as HTMLElement | null;
  return typeof candidate?.closest === "function" ? candidate : null;
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = closestElement(target);
  if (!element) return false;
  if (
    element.closest(
      "textarea,[contenteditable]:not([contenteditable='false'])",
    )
  )
    return true;
  const input = element.closest("input") as HTMLInputElement | null;
  return !!input && !NON_TEXT_INPUT_TYPES.has(input.type.toLowerCase());
}

function isNonTextFocusable(element: HTMLElement): boolean {
  return (
    element.matches(NON_TEXT_FOCUSABLE_SELECTOR) &&
    !isTextEntryTarget(element)
  );
}

function removeFromTabOrder(root: ParentNode): void {
  if (root instanceof HTMLElement && isNonTextFocusable(root)) {
    if (root.tabIndex >= 0) root.tabIndex = -1;
  }
  for (const element of root.querySelectorAll<HTMLElement>(
    NON_TEXT_FOCUSABLE_SELECTOR,
  )) {
    if (isNonTextFocusable(element) && element.tabIndex >= 0)
      element.tabIndex = -1;
  }
}

export function installDesktopInteractionPolicy(): void {
  const root = document.body;
  if (!root) return;

  removeFromTabOrder(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        const element = record.target as HTMLElement;
        if (isNonTextFocusable(element) && element.tabIndex >= 0)
          element.tabIndex = -1;
      } else {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) removeFromTabOrder(node);
        }
      }
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["tabindex"],
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "a" ||
        isTextEntryTarget(event.target)
      )
        return;

      const target = closestElement(event.target);
      const readerSelection = document.querySelector(".reader-selecting");
      if (
        readerSelection &&
        (readerSelection.contains(target) ||
          target === document.body ||
          target === document.documentElement)
      )
        return;

      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  document.addEventListener(
    "pointerup",
    (event) => {
      const target = closestElement(event.target);
      const clickedSelect = !!target?.closest("select");
      window.setTimeout(() => {
        const active = document.activeElement as HTMLElement | null;
        if (
          active &&
          active !== document.body &&
          !isTextEntryTarget(active) &&
          !(clickedSelect && active.matches("select"))
        )
          active.blur();
      }, 0);
    },
    true,
  );

  document.addEventListener(
    "change",
    (event) => {
      const target = closestElement(event.target);
      const control = target?.closest("select,input") as HTMLElement | null;
      if (control && isNonTextFocusable(control))
        window.setTimeout(() => control.blur(), 0);
    },
    true,
  );
}
