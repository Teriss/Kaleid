import sharp from "sharp";
import fs from "node:fs/promises";
const sizes = [16, 32, 48, 256];
const buffers = await Promise.all(
  sizes.map((size) =>
    sharp("build/icon.svg").resize(size, size).png().toBuffer(),
  ),
);
const header = Buffer.alloc(6 + buffers.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(buffers.length, 4);
let offset = header.length;
buffers.forEach((buffer, index) => {
  const entry = 6 + index * 16;
  header[entry] = sizes[index] === 256 ? 0 : sizes[index];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(buffer.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += buffer.length;
});
await fs.writeFile("build/icon.ico", Buffer.concat([header, ...buffers]));
await fs.writeFile("build/icon.png", buffers.at(-1));
