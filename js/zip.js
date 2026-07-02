// ============================================================
// zip.js — tiny, dependency-free ZIP (STORE / no compression).
//
// Audio blobs are already compressed (opus), so storing them uncompressed
// keeps this code small while producing reasonably sized archives. Good
// enough for export/import of "audio blobs + JSON metadata".
// ============================================================

// --- CRC32 (standard polynomial 0xEDB88320) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

// entries: [{ name: string, data: Uint8Array }]
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n) =>
    new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    // Local file header
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), nameBytes, data,
    ]);
    chunks.push(local);

    // Central directory header
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBytes,
    ]));

    offset += local.length;
  }

  const centralBytes = concat(central);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ]);

  return new Blob([concat(chunks), centralBytes, eocd], { type: "application/zip" });
}

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Parse a STORE zip back into { name -> Uint8Array }. Reads the central
// directory so it tolerates archives written by this module.
export async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);

  // Find End Of Central Directory (search backwards for its signature).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid zip file.");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central directory offset
  const files = {};

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));

    // Jump to the local header to find where data actually begins.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;

    if (method !== 0) throw new Error("Unsupported compressed zip entry: " + name);
    files[name] = buf.subarray(dataStart, dataStart + compSize);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
