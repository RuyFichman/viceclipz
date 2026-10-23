import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import { InputError } from "./composition.mjs";
// ZIP limit without ZIP64 extensions.
const MAX_ZIP = 0xffffffff;
export async function fileCrc(file) {
  let crc = 0;
  for await (const chunk of createReadStream(file)) crc = crc32(chunk, crc);
  return crc >>> 0;
}
function dosTime(ms) {
  const d = new Date(ms);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
function header(signature, size, fields) {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(signature, 0);
  for (const [offset, bytes, value] of fields)
    bytes === 2
      ? buffer.writeUInt16LE(value, offset)
      : buffer.writeUInt32LE(value, offset);
  return buffer;
}
// Streams MP4 files as an uncompressed ZIP, one file at a time, so memory use stays
// constant. Sizes and CRCs are known up front; MP4 is already compressed.
export async function streamArchive(req, res, entries, filename) {
  const files = [];
  let offset = 0;
  for (const entry of entries) {
    const info = await stat(entry.file).catch(() => null);
    if (!info || info.size !== entry.size)
      throw new InputError("Uma das variações não está mais disponível.", 409);
    const name = Buffer.from(entry.name, "utf8"),
      { time, date } = dosTime(entry.time),
      crc = entry.crc ?? (await fileCrc(entry.file)),
      common = [
        [8, 2, 0],
        [10, 2, time],
        [12, 2, date],
        [14, 4, crc >>> 0],
        [18, 4, entry.size],
        [22, 4, entry.size],
        [26, 2, name.length],
      ];
    const local = Buffer.concat([
      header(0x04034b50, 30, [[4, 2, 20], [6, 2, 0x0800], ...common]),
      name,
    ]);
    files.push({ ...entry, name, time, date, crc, local, offset });
    offset += local.length + entry.size;
  }
  const central = Buffer.concat(
      files.flatMap((f) => [
        header(0x02014b50, 46, [
          [4, 2, 20],
          [6, 2, 20],
          [8, 2, 0x0800],
          [10, 2, 0],
          [12, 2, f.time],
          [14, 2, f.date],
          [16, 4, f.crc >>> 0],
          [20, 4, f.size],
          [24, 4, f.size],
          [28, 2, f.name.length],
          [42, 4, f.offset],
        ]),
        f.name,
      ]),
    ),
    end = header(0x06054b50, 22, [
      [8, 2, files.length],
      [10, 2, files.length],
      [12, 4, central.length],
      [16, 4, offset],
    ]),
    total = offset + central.length + end.length;
  if (total >= MAX_ZIP)
    throw new InputError(
      "O lote é grande demais para um único ZIP. Baixe as variações individualmente.",
      409,
    );
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": total,
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  try {
    for (const f of files) {
      res.write(f.local);
      await pipeline(createReadStream(f.file), res, { end: false });
    }
    res.end(Buffer.concat([central, end]));
  } catch {
    res.destroy();
  }
}
