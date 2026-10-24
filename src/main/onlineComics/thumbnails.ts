import sharp from "sharp";

export function parseThumbnail(value: string) {
  // Only treat the source's coordinate suffix as a crop, not an @ in a URL.
  const match = /@(?=[xy]=)(.*)$/.exec(value);
  if (!match) return { url: value };
  const crop: Record<string, number> = {};
  for (const field of match[1].split("&")) {
    const range = /^([xy])=(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(field);
    if (!range) return { url: value.slice(0, match.index) };
    crop[range[1] + "1"] = Number(range[2]);
    crop[range[1] + "2"] = Number(range[3]);
  }
  return { url: value.slice(0, match.index), crop };
}

export async function cropThumbnail(buffer: Buffer, crop?: Record<string, number>) {
  if (!crop) return buffer;
  const { width, height } = await sharp(buffer).metadata();
  if (!width || !height) return buffer;
  const left = Math.max(0, Math.floor(crop.x1 ?? 0));
  const top = Math.max(0, Math.floor(crop.y1 ?? 0));
  const right = Math.min(width, Math.ceil(crop.x2 ?? width));
  const bottom = Math.min(height, Math.ceil(crop.y2 ?? height));
  if (right <= left || bottom <= top) return buffer;
  return sharp(buffer).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
}
