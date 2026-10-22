import type { Settings } from "../../shared/types";
const key = "kaleid:theme";
export function applyTheme(value: unknown, target = document) {
  const theme: Settings["theme"] = value === "light" ? "light" : "dark";
  target.documentElement.dataset.theme = theme;
  target.documentElement.style.colorScheme = theme;
  if (target === document) {
    try {
      localStorage.setItem(key, theme);
    } catch {}
  }
}
export function initializeTheme() {
  try {
    applyTheme(localStorage.getItem(key));
  } catch {
    applyTheme("dark");
  }
  const off = window.media.onTheme((theme) => applyTheme(theme));
  void window.media
    .appTheme()
    .then((theme) => applyTheme(theme))
    .catch(() => {});
  window.addEventListener("beforeunload", off, { once: true });
}
