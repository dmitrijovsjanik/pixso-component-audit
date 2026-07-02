// Minimal ZIP writer using STORE (no compression) — enough to package an .xlsx.
// A .xlsx is just a ZIP of XML parts; Excel/Sheets open STORE archives fine.
// Avoids a heavyweight dependency (ExcelJS/JSZip pull ~1.3MB into the bundle).

interface Entry {
  name: string;
  data: Uint8Array;
  crc: number;
}

// CRC-32 (table built once).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

export class MiniZip {
  private entries: Entry[] = [];

  add(name: string, content: string) {
    const data = enc.encode(content);
    this.entries.push({ name, data, crc: crc32(data) });
  }

  private static writeU16(arr: number[], v: number) {
    arr.push(v & 0xff, (v >>> 8) & 0xff);
  }
  private static writeU32(arr: number[], v: number) {
    arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }

  toBlob(): Blob {
    const chunks: Uint8Array[] = [];
    const central: number[] = [];
    let offset = 0;

    for (const e of this.entries) {
      const nameBytes = enc.encode(e.name);
      const local: number[] = [];
      MiniZip.writeU32(local, 0x04034b50); // local file header sig
      MiniZip.writeU16(local, 20); // version needed
      MiniZip.writeU16(local, 0); // flags
      MiniZip.writeU16(local, 0); // method: STORE
      MiniZip.writeU16(local, 0); // mod time
      MiniZip.writeU16(local, 0x21); // mod date (fixed, deterministic)
      MiniZip.writeU32(local, e.crc);
      MiniZip.writeU32(local, e.data.length); // compressed size
      MiniZip.writeU32(local, e.data.length); // uncompressed size
      MiniZip.writeU16(local, nameBytes.length);
      MiniZip.writeU16(local, 0); // extra len
      const header = new Uint8Array(local);
      chunks.push(header, nameBytes, e.data);

      // central directory record
      MiniZip.writeU32(central, 0x02014b50);
      MiniZip.writeU16(central, 20); // version made by
      MiniZip.writeU16(central, 20); // version needed
      MiniZip.writeU16(central, 0);
      MiniZip.writeU16(central, 0);
      MiniZip.writeU16(central, 0);
      MiniZip.writeU16(central, 0x21);
      MiniZip.writeU32(central, e.crc);
      MiniZip.writeU32(central, e.data.length);
      MiniZip.writeU32(central, e.data.length);
      MiniZip.writeU16(central, nameBytes.length);
      MiniZip.writeU16(central, 0);
      MiniZip.writeU16(central, 0); // comment len
      MiniZip.writeU16(central, 0); // disk number
      MiniZip.writeU16(central, 0); // internal attrs
      MiniZip.writeU32(central, 0); // external attrs
      MiniZip.writeU32(central, offset); // local header offset
      for (let i = 0; i < nameBytes.length; i++) central.push(nameBytes[i]);

      offset += header.length + nameBytes.length + e.data.length;
    }

    const centralBytes = new Uint8Array(central);
    const end: number[] = [];
    MiniZip.writeU32(end, 0x06054b50); // end of central dir sig
    MiniZip.writeU16(end, 0);
    MiniZip.writeU16(end, 0);
    MiniZip.writeU16(end, this.entries.length);
    MiniZip.writeU16(end, this.entries.length);
    MiniZip.writeU32(end, centralBytes.length);
    MiniZip.writeU32(end, offset);
    MiniZip.writeU16(end, 0);

    chunks.push(centralBytes, new Uint8Array(end));
    return new Blob(chunks as BlobPart[], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }
}
