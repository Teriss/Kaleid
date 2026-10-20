export function clipTime(seconds: number) {
  const value = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(value / 3600000)).padStart(2, "0")}:${String(Math.floor(value / 60000) % 60).padStart(2, "0")}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")}.${String(value % 1000).padStart(3, "0")}`;
}
export function parseClipTime(text: string) {
  const match = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{1,3})$/.exec(text.trim());
  return match
    ? Number(match[1]) * 3600 +
        Number(match[2]) * 60 +
        Number(match[3]) +
        Number(match[4].padEnd(3, "0")) / 1000
    : NaN;
}
