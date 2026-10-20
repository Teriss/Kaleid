export function luminance(hex: string) {
  const rgb = hex
    .replace("#", "")
    .match(/.{2}/g)!
    .map((part) => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function readerColors(value: string) {
  const background = /^#[0-9a-f]{6}$/i.test(value) ? value : "#eee8db";
  const dark =
    contrast(background, "#000000") >= contrast(background, "#ffffff");
  const preferred = dark ? "#252525" : "#ededed";
  return {
    background,
    foreground:
      contrast(background, preferred) >= 4.5
        ? preferred
        : dark
          ? "#000000"
          : "#ffffff",
  };
}
