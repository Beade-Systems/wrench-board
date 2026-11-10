/* BoardRipper-derived Allegro importer: AGPL-3.0. See LICENSE, NOTICE.md and upstream.json alongside this file. */

// api/board/parser/_boardripper/bridge.ts
var import_node_fs = require("node:fs");

// api/board/parser/_boardripper/vendor/parsers/allegro/allegro-stream.ts
var AllegroStream = class {
  view;
  pos = 0;
  tmpView = new DataView(new ArrayBuffer(8));
  constructor(buffer) {
    this.view = new DataView(buffer);
  }
  /** Ensure at least `n` bytes are available from the current position. */
  ensure(n) {
    if (this.pos + n > this.view.byteLength) {
      throw new Error(
        `Allegro BRD truncated: need ${n} bytes at offset 0x${this.pos.toString(16)}, but file is only ${this.view.byteLength} bytes`
      );
    }
  }
  // ── Position ────────────────────────────────────────────────────────────
  get position() {
    return this.pos;
  }
  get size() {
    return this.view.byteLength;
  }
  get eof() {
    return this.pos >= this.view.byteLength;
  }
  seek(offset) {
    this.pos = offset;
  }
  skip(n) {
    this.pos += n;
  }
  // ── Primitive reads ──────────────────────────────────────────────────────
  u8() {
    this.ensure(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  peekU8() {
    this.ensure(1);
    return this.view.getUint8(this.pos);
  }
  u16() {
    this.ensure(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  s16() {
    this.ensure(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  s32() {
    this.ensure(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  /** Read a u32 and discard it (advance position only). */
  skipU32() {
    this.ensure(4);
    this.pos += 4;
  }
  // ── Array reads ──────────────────────────────────────────────────────────
  u32Array(count) {
    this.ensure(count * 4);
    const arr = new Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = this.view.getUint32(this.pos, true);
      this.pos += 4;
    }
    return arr;
  }
  s32Array(count) {
    this.ensure(count * 4);
    const arr = new Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = this.view.getInt32(this.pos, true);
      this.pos += 4;
    }
    return arr;
  }
  // ── Floating-point ───────────────────────────────────────────────────────
  /**
   * Reads arc center/radius: two little-endian u32 halves ordered [high, low],
   * reassembled as a big-endian IEEE 754 double. Each 32-bit half is stored
   * LE in memory; the pair forms the f64 in (high, low) order.
   */
  allegroFloat() {
    this.ensure(8);
    const hi = this.view.getUint32(this.pos, true);
    const lo = this.view.getUint32(this.pos + 4, true);
    this.pos += 8;
    this.tmpView.setUint32(0, hi, false);
    this.tmpView.setUint32(4, lo, false);
    return this.tmpView.getFloat64(0, false);
  }
  // ── String reads ─────────────────────────────────────────────────────────
  /**
   * Read a null-terminated C string.
   * If roundToU32 is true, advance position to the next 4-byte boundary
   * after the null terminator (common in Allegro string fields).
   */
  cString(roundToU32 = false) {
    const start = this.pos;
    while (this.pos < this.view.byteLength && this.view.getUint8(this.pos) !== 0) {
      this.pos++;
    }
    const bytes = new Uint8Array(this.view.buffer, start, this.pos - start);
    this.pos++;
    if (roundToU32) {
      const consumed = this.pos - start;
      const remainder = consumed % 4;
      if (remainder !== 0) {
        this.pos += 4 - remainder;
      }
    }
    return new TextDecoder("latin1").decode(bytes);
  }
  /**
   * Read a fixed-length string field of exactly `len` bytes.
   * If roundToU32 is true, advance to the next 4-byte boundary after `len`.
   * Trims trailing null bytes.
   */
  fixedString(len, roundToU32 = false) {
    const bytes = new Uint8Array(this.view.buffer, this.pos, len);
    this.pos += len;
    if (roundToU32) {
      const remainder = len % 4;
      if (remainder !== 0) {
        this.pos += 4 - remainder;
      }
    }
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder("latin1").decode(bytes.subarray(0, end));
  }
  // ── Raw bytes ────────────────────────────────────────────────────────────
  /** Read n raw bytes and return them as a Uint8Array view (no copy). */
  bytes(n) {
    this.ensure(n);
    const slice = new Uint8Array(this.view.buffer, this.pos, n);
    this.pos += n;
    return slice;
  }
};

// api/board/parser/_boardripper/vendor/parsers/allegro/allegro-types.ts
var FmtVer = {
  V_PRE_V16: -1,
  // Pre-v15 Allegro (truly unsupported binary format)
  V_UNKNOWN: 0,
  // v15.x family — header + string-table layout matches v16/v17 pre-V172;
  // block records have a 4-byte prefix instead of the 3-byte type-tag prefix
  // of v16+. See docs/formats/ALLEGRO_V15_FORMAT.md.
  V_15X: 1,
  // 0x00120200, 0x00120A00 (Allegro 15.5.x)
  V_160: 2,
  // 0x00130000
  V_162: 3,
  // 0x00130400
  V_164: 4,
  // 0x00130C00
  V_165: 5,
  // 0x00131000
  V_166: 6,
  // 0x00131500
  V_172: 7,
  // 0x00140400–0x00140700
  V_174: 8,
  // 0x00140900, 0x00140E00
  V_175: 9,
  // 0x00141500
  V_180: 10
  // 0x00150000
};
var LayerClass = {
  BOARD_GEOMETRY: 1,
  COMPONENT_VALUE: 2,
  DEVICE_TYPE: 3,
  DRAWING_FORMAT: 4,
  DRC_ERROR: 5,
  ETCH: 6,
  MANUFACTURING: 7,
  ANALYSIS: 8,
  PACKAGE_GEOMETRY: 9,
  PACKAGE_KEEPIN: 10,
  PACKAGE_KEEPOUT: 11,
  PIN: 12,
  REF_DES: 13,
  ROUTE_KEEPIN: 14,
  ROUTE_KEEPOUT: 15,
  TOLERANCE: 16,
  USER_PART_NUMBER: 17,
  VIA_CLASS: 18,
  VIA_KEEPOUT: 19,
  ANTI_ETCH: 20,
  BOUNDARY: 21
};
var BoardUnits = {
  MILS: 1,
  INCHES: 2,
  MILLIMETERS: 3,
  CENTIMETERS: 4,
  MICROMETERS: 5
};
function readCond(ver, threshold, dir, reader) {
  const present = dir === ">=" ? ver >= threshold : ver < threshold;
  return present ? reader() : void 0;
}

// api/board/parser/_boardripper/vendor/parsers/allegro/allegro-header.ts
function formatFromMagic(magic) {
  const masked = (magic & 4294967040) >>> 0;
  switch (masked) {
    case 1180160:
    // Allegro 15.5.2 family (e.g. v13tl-0629)
    case 1182208:
      return FmtVer.V_15X;
    case 1245184:
      return FmtVer.V_160;
    case 1246208:
      return FmtVer.V_162;
    case 1248256:
      return FmtVer.V_164;
    case 1249280:
      return FmtVer.V_165;
    case 1250560:
      return FmtVer.V_166;
    case 1311744:
    case 1312e3:
    case 1312256:
    case 1312512:
      return FmtVer.V_172;
    case 1313024:
    case 1314304:
      return FmtVer.V_174;
    case 1316096:
      return FmtVer.V_175;
    case 1376256:
    case 1376768:
      return FmtVer.V_180;
    default:
      break;
  }
  const majorVer = magic >>> 16 & 65535;
  if (majorVer === 18) {
    return FmtVer.V_15X;
  }
  if (majorVer < 18) {
    return FmtVer.V_PRE_V16;
  }
  throw new Error(
    `Unknown Allegro file version magic 0x${magic.toString(16).padStart(8, "0")} (major 0x${majorVer.toString(16)})`
  );
}
function readLL(stream, ver) {
  const w1 = stream.u32();
  const w2 = stream.u32();
  if (ver >= FmtVer.V_180) {
    return { head: w1, tail: w2 };
  }
  return { head: w2, tail: w1 };
}
function looksLikeVersionString(stream) {
  const at = stream.position;
  if (at + 4 > stream.size) return false;
  for (let i = 0; i < 4; i++) {
    stream.seek(at + i);
    const b = stream.peekU8();
    if (b < 32 || b > 126) {
      stream.seek(at);
      return false;
    }
  }
  stream.seek(at);
  return true;
}
function parseHeader(stream) {
  const headerStartPos = stream.position;
  const magic = stream.u32();
  const ver = formatFromMagic(magic);
  if (ver === FmtVer.V_PRE_V16) {
    throw new Error(
      `Allegro pre-v15.x BRD files are not supported (magic 0x${magic.toString(16).padStart(8, "0")}). The current parser supports Allegro v15\u2013v18. Workaround: re-save the board from Cadence Allegro as v15+ and reopen.`
    );
  }
  stream.u32();
  stream.u32();
  stream.u32();
  stream.u32();
  const objectCount = stream.u32();
  stream.u32();
  stream.u32();
  let x27End_V18;
  let stringsCount_V18;
  if (ver >= FmtVer.V_180) {
    stream.u32();
    stream.u32();
    x27End_V18 = stream.u32();
    stream.u32();
    stream.u32();
    stringsCount_V18 = stream.u32();
    stream.u32();
  } else {
    for (let i = 0; i < 7; i++) stream.u32();
  }
  let LL_V18_1;
  let LL_V18_2;
  let LL_V18_3;
  let LL_V18_4;
  let LL_V18_5;
  if (ver >= FmtVer.V_180) {
    LL_V18_1 = readLL(stream, ver);
    LL_V18_2 = readLL(stream, ver);
    LL_V18_3 = readLL(stream, ver);
    LL_V18_4 = readLL(stream, ver);
    LL_V18_5 = readLL(stream, ver);
  }
  const LL_0x04 = readLL(stream, ver);
  const LL_0x06 = readLL(stream, ver);
  const LL_0x0C = readLL(stream, ver);
  const LL_Shapes = readLL(stream, ver);
  const LL_0x14 = readLL(stream, ver);
  const LL_0x1B_Nets = readLL(stream, ver);
  const LL_0x1C = readLL(stream, ver);
  const LL_0x24_0x28 = readLL(stream, ver);
  const LL_Unknown1 = readLL(stream, ver);
  const LL_0x2B = readLL(stream, ver);
  const LL_0x03_0x30 = readLL(stream, ver);
  const LL_0x0A = readLL(stream, ver);
  const LL_0x1D_0x1E_0x1F = readLL(stream, ver);
  const LL_Unknown2 = readLL(stream, ver);
  const LL_0x38 = readLL(stream, ver);
  const LL_0x2C = readLL(stream, ver);
  const LL_0x0C_2 = readLL(stream, ver);
  const LL_Unknown3 = readLL(stream, ver);
  let x35Start_preV18;
  let x35End_preV18;
  if (ver < FmtVer.V_180) {
    x35Start_preV18 = stream.u32();
    x35End_preV18 = stream.u32();
  }
  if (ver >= FmtVer.V_180) {
    readLL(stream, ver);
  }
  const LL_0x36 = readLL(stream, ver);
  if (ver < FmtVer.V_180) {
    readLL(stream, ver);
  }
  const LL_Unknown6 = readLL(stream, ver);
  const LL_0x0A_2 = readLL(stream, ver);
  if (ver < FmtVer.V_180) {
    stream.u32();
  }
  let LL_V18_6;
  let x35Start_V18;
  let x35End_V18;
  if (ver >= FmtVer.V_180) {
    LL_V18_6 = readLL(stream, ver);
    x35Start_V18 = stream.u32();
    x35End_V18 = stream.u32();
  }
  let LL_V18_7;
  let LL_V18_8;
  let LL_V18_9;
  let LL_V18_10;
  if (ver >= FmtVer.V_180 && !looksLikeVersionString(stream)) {
    LL_V18_7 = readLL(stream, ver);
    LL_V18_8 = readLL(stream, ver);
    LL_V18_9 = readLL(stream, ver);
    LL_V18_10 = readLL(stream, ver);
  }
  const actualOffset = stream.position - headerStartPos;
  const validOffsets = ver < FmtVer.V_180 ? [248] : [292, 324];
  if (!validOffsets.includes(actualOffset)) {
    throw new Error(
      `Allegro header position mismatch at Allegro version string: expected offset ${validOffsets.map((o) => `0x${o.toString(16)}`).join(" or ")}, got 0x${actualOffset.toString(16)}`
    );
  }
  const allegroVersion = stream.fixedString(60);
  stream.u32();
  const maxKey = stream.u32();
  if (ver < FmtVer.V_180) {
    for (let i = 0; i < 17; i++) stream.u32();
  } else {
    for (let i = 0; i < 9; i++) stream.u32();
  }
  const unitsByte = stream.u8();
  stream.skip(3);
  let boardUnits;
  switch (unitsByte) {
    case BoardUnits.MILS:
      boardUnits = BoardUnits.MILS;
      break;
    case BoardUnits.INCHES:
      boardUnits = BoardUnits.INCHES;
      break;
    case BoardUnits.MILLIMETERS:
      boardUnits = BoardUnits.MILLIMETERS;
      break;
    case BoardUnits.CENTIMETERS:
      boardUnits = BoardUnits.CENTIMETERS;
      break;
    case BoardUnits.MICROMETERS:
      boardUnits = BoardUnits.MICROMETERS;
      break;
    default:
      throw new Error(`Unknown Allegro board units byte: 0x${unitsByte.toString(16)}`);
  }
  stream.u32();
  let x27End_preV18;
  if (ver < FmtVer.V_180) {
    stream.u32();
    x27End_preV18 = stream.u32();
  }
  stream.u32();
  let stringsCount_preV18;
  if (ver < FmtVer.V_180) {
    stringsCount_preV18 = stream.u32();
  }
  for (let i = 0; i < 50; i++) stream.u32();
  stream.u32();
  stream.u32();
  stream.u32();
  const unitsDivisor = stream.u32();
  stream.skip(110 * 4);
  const layerMap = [];
  for (let i = 0; i < 25; i++) {
    const a = stream.u32();
    const layerList0x2A = stream.u32();
    layerMap.push({ a, layerList0x2A });
  }
  const x27End = (ver >= FmtVer.V_180 ? x27End_V18 : x27End_preV18) ?? 0;
  const stringsCount = (ver >= FmtVer.V_180 ? stringsCount_V18 : stringsCount_preV18) ?? 0;
  const x35Start = (ver >= FmtVer.V_180 ? x35Start_V18 : x35Start_preV18) ?? 0;
  const x35End = (ver >= FmtVer.V_180 ? x35End_V18 : x35End_preV18) ?? 0;
  return {
    magic,
    fmtVer: ver,
    objectCount,
    allegroVersion,
    boardUnits,
    unitsDivisor,
    maxKey,
    stringsCount,
    x27End,
    LL_0x04,
    LL_0x06,
    LL_0x0C,
    LL_Shapes,
    LL_0x14,
    LL_0x1B_Nets,
    LL_0x1C,
    LL_0x24_0x28,
    LL_Unknown1,
    LL_0x2B,
    LL_0x03_0x30,
    LL_0x0A,
    LL_0x1D_0x1E_0x1F,
    LL_Unknown2,
    LL_0x38,
    LL_0x2C,
    LL_0x0C_2,
    LL_Unknown3,
    LL_0x36,
    LL_Unknown6,
    LL_0x0A_2,
    LL_V18_1,
    LL_V18_2,
    LL_V18_3,
    LL_V18_4,
    LL_V18_5,
    LL_V18_6,
    LL_V18_7,
    LL_V18_8,
    LL_V18_9,
    LL_V18_10,
    x35Start,
    x35End,
    layerMap
  };
}

// api/board/parser/_boardripper/vendor/parsers/allegro/allegro-blocks.ts
function parseLayerInfo(s) {
  return { classCode: s.u8(), subclass: s.u8() };
}
function parseBlock0x01(s, ver, offset) {
  s.skip(1);
  const unknownByte = s.u8();
  const subType = s.u8();
  const key = s.u32();
  const next = s.u32();
  const parent = s.u32();
  const unknown1 = s.u32();
  const unknown6 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const width = s.u32();
  const startX = s.s32();
  const startY = s.s32();
  const endX = s.s32();
  const endY = s.s32();
  const centerX = s.allegroFloat();
  const centerY = s.allegroFloat();
  const radius = s.allegroFloat();
  const bbox = [s.s32(), s.s32(), s.s32(), s.s32()];
  return {
    blockType: 1,
    offset,
    key,
    unknownByte,
    subType,
    next,
    parent,
    unknown1,
    unknown6,
    width,
    startX,
    startY,
    endX,
    endY,
    centerX,
    centerY,
    radius,
    bbox
  };
}
function parseBlock0x03(s, ver, offset) {
  s.skip(1);
  const hdr1 = s.u16();
  const key = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const subType = s.u8();
  const hdr2 = s.u8();
  const size = s.u16();
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  let substruct;
  switch (subType) {
    case 101:
      substruct = { kind: "empty" };
      break;
    case 100:
    case 102:
    case 103:
    case 106:
      substruct = { kind: "u32", value: s.u32() };
      break;
    case 105:
      substruct = { kind: "u32x2", values: [s.u32(), s.u32()] };
      break;
    case 104:
    case 107:
    case 109:
    case 110:
    case 111:
    case 113:
    case 115:
    case 120:
      substruct = { kind: "string", value: s.fixedString(size, true) };
      break;
    case 108: {
      const numEntries = s.u32();
      const entries = [];
      for (let i = 0; i < numEntries; i++) {
        entries.push(s.u32());
      }
      substruct = { kind: "0x6C", numEntries, entries };
      break;
    }
    case 112:
    case 116: {
      const x0 = s.u16();
      const x1 = s.u16();
      const numEntries = x1 + 4 * x0;
      const entries = [];
      for (let i = 0; i < numEntries; i++) {
        entries.push(s.u8());
      }
      substruct = { kind: "0x70_0x74", x0, x1, entries };
      break;
    }
    case 246: {
      const entries = [];
      for (let i = 0; i < 20; i++) {
        entries.push(s.u32());
      }
      substruct = { kind: "0xF6", entries };
      break;
    }
    default:
      if (size === 4) {
        substruct = { kind: "u32", value: s.u32() };
      } else if (size === 8) {
        substruct = { kind: "u32x2", values: [s.u32(), s.u32()] };
      } else if (size === 0) {
        substruct = { kind: "empty" };
      } else {
        throw new Error(`Unknown block 0x03 substruct type 0x${subType.toString(16)} with size ${size}`);
      }
      break;
  }
  return { blockType: 3, offset, key, hdr1, next, unknown1, subType, hdr2, size, unknown2, substruct };
}
function parseBlock0x04(s, ver, offset) {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const next = s.u32();
  const net = s.u32();
  const connItem = s.u32();
  const unknown = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return { blockType: 4, offset, key, type, r, next, net, connItem, unknown };
}
function parseBlock0x05(s, ver, offset) {
  s.skip(1);
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const netAssignment = s.u32();
  const unknownPtr1 = s.u32();
  const unknown2 = s.u32();
  const unknown3 = s.u32();
  const unknownPtr2a = s.u32();
  const unknownPtr2b = s.u32();
  const unknown4 = s.u32();
  const unknownPtr3a = s.u32();
  const unknownPtr3b = s.u32();
  const unknown5a = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown5b = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const firstSegPtr = s.u32();
  const unknownPtr5 = s.u32();
  const unknown6 = s.u32();
  return {
    blockType: 5,
    offset,
    key,
    layer,
    next,
    netAssignment,
    unknownPtr1,
    unknown2,
    unknown3,
    unknownPtr2a,
    unknownPtr2b,
    unknown4,
    unknownPtr3a,
    unknownPtr3b,
    unknown5a,
    unknown5b,
    firstSegPtr,
    unknownPtr5,
    unknown6
  };
}
function parseBlock0x06(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const next = s.u32();
  const compDeviceType = s.u32();
  const symbolName = s.u32();
  const firstInstPtr = s.u32();
  const ptrFunctionSlot = s.u32();
  const ptrPinNumber = s.u32();
  const fields = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  return {
    blockType: 6,
    offset,
    key,
    next,
    compDeviceType,
    symbolName,
    firstInstPtr,
    ptrFunctionSlot,
    ptrPinNumber,
    fields,
    unknown1
  };
}
function parseBlock0x07(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const next = s.u32();
  const unknownPtr1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const fpInstPtr = s.u32();
  const unknown4 = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const refDesStrPtr = s.u32();
  const functionInstPtr = s.u32();
  const x03Ptr = s.u32();
  const unknown5 = s.u32();
  const firstPadPtr = s.u32();
  return {
    blockType: 7,
    offset,
    key,
    next,
    unknownPtr1,
    unknown2,
    unknown3,
    fpInstPtr,
    unknown4,
    refDesStrPtr,
    functionInstPtr,
    x03Ptr,
    unknown5,
    firstPadPtr
  };
}
function parseBlock0x08(s, ver, offset) {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const previous = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const strPtr16x = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const next = s.u32();
  const strPtr = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const pinNamePtr = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const ptr4 = s.u32();
  return { blockType: 8, offset, key, type, r, previous, strPtr16x, next, strPtr, pinNamePtr, unknown1, ptr4 };
}
function parseBlock0x09(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const unknownArray = [s.u32(), s.u32(), s.u32(), s.u32()];
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknownPtr1 = s.u32();
  const unknownPtr2 = s.u32();
  const unknown2 = s.u32();
  const unknownPtr3 = s.u32();
  const unknownPtr4 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return {
    blockType: 9,
    offset,
    key,
    unknownArray,
    unknown1,
    unknownPtr1,
    unknownPtr2,
    unknown2,
    unknownPtr3,
    unknownPtr4,
    unknown3
  };
}
function parseBlock0x0A(s, ver, offset) {
  const t = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const coords = [s.s32(), s.s32(), s.s32(), s.s32()];
  const unknown4 = [s.u32(), s.u32(), s.u32(), s.u32()];
  const unknown5 = [s.u32(), s.u32(), s.u32(), s.u32(), s.u32()];
  const unknown6 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return { blockType: 10, offset, key, t, layer, next, unknown1, unknown2, coords, unknown4, unknown5, unknown6 };
}
function parseBlock0x0C(s, ver, offset) {
  const t = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const unknown1 = s.u32();
  const unknown2 = s.u32();
  const shape = readCond(ver, FmtVer.V_172, "<", () => s.u8());
  const drillChar = readCond(ver, FmtVer.V_172, "<", () => s.u8());
  const unknownPadding = readCond(ver, FmtVer.V_172, "<", () => s.u16());
  const shape16x = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const drillChars = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown_16x = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown4 = s.u32();
  const unknown5 = readCond(ver, FmtVer.V_180, ">=", () => s.u32());
  const coords = [s.s32(), s.s32()];
  const size = [s.s32(), s.s32()];
  const groupPtr = s.u32();
  const unknown6 = s.u32();
  const unknown7 = s.u32();
  const unknown8 = readCond(ver, FmtVer.V_174, ">=", () => {
    if (ver < FmtVer.V_180) return s.u32();
    return void 0;
  });
  return {
    blockType: 12,
    offset,
    key,
    t,
    layer,
    next,
    unknown1,
    unknown2,
    shape,
    drillChar,
    unknownPadding,
    shape16x,
    drillChars,
    unknown_16x,
    unknown4,
    unknown5,
    coords,
    size,
    groupPtr,
    unknown6,
    unknown7,
    unknown8
  };
}
function parseBlock0x0D(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const nameStrId = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  const coordsX = s.s32();
  const coordsY = s.s32();
  const padStack = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const flags = s.u32();
  const rotation = s.u32();
  return {
    blockType: 13,
    offset,
    key,
    nameStrId,
    next,
    unknown1,
    coordsX,
    coordsY,
    padStack,
    unknown2,
    unknown3,
    flags,
    rotation
  };
}
function parseBlock0x0E(s, ver, offset) {
  const t = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const fpPtr = s.u32();
  const unknown1 = s.u32();
  const unknown2 = s.u32();
  const unknown3 = s.u32();
  const unknown4 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown5 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const coords = [s.s32(), s.s32(), s.s32(), s.s32()];
  const unknownArr = [s.u32(), s.u32(), s.u32()];
  const rotation = s.u32();
  return {
    blockType: 14,
    offset,
    key,
    t,
    layer,
    next,
    fpPtr,
    unknown1,
    unknown2,
    unknown3,
    unknown4,
    unknown5,
    coords,
    unknownArr,
    rotation
  };
}
function parseBlock0x0F(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const slotName = s.u32();
  const compDeviceType = s.bytes(32).slice();
  const ptr0x06 = s.u32();
  const ptr0x11 = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return {
    blockType: 15,
    offset,
    key,
    slotName,
    compDeviceType,
    ptr0x06,
    ptr0x11,
    unknown1,
    unknown2,
    unknown3
  };
}
function parseBlock0x10(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const componentInstPtr = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  const ptrX12 = s.u32();
  const unknown3 = s.u32();
  const functionName = s.u32();
  const slots = s.u32();
  const fields = s.u32();
  return {
    blockType: 16,
    offset,
    key,
    unknown1,
    componentInstPtr,
    unknown2,
    ptrX12,
    unknown3,
    functionName,
    slots,
    fields
  };
}
function parseBlock0x11(s, ver, offset) {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const pinNameStrPtr = s.u32();
  const next = s.u32();
  const pinNumberPtr = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return { blockType: 17, offset, key, type, r, pinNameStrPtr, next, pinNumberPtr, unknown1, unknown2 };
}
function parseBlock0x12(s, ver, offset) {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const ptr1 = s.u32();
  const ptr2 = s.u32();
  const ptr3 = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_165, ">=", () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return { blockType: 18, offset, key, type, r, ptr1, ptr2, ptr3, unknown1, unknown2, unknown3 };
}
function parseBlock0x14(s, ver, offset) {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const parent = s.u32();
  const flags = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const segmentPtr = s.u32();
  const ptr0x03 = s.u32();
  const ptr0x26 = s.u32();
  return { blockType: 20, offset, key, type, layer, next, parent, flags, unknown2, segmentPtr, ptr0x03, ptr0x26 };
}
function parseBlock0x15_16_17(s, ver, offset, blockType) {
  s.skip(3);
  const key = s.u32();
  const next = s.u32();
  const parent = s.u32();
  const flags = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const width = s.u32();
  const startX = s.s32();
  const startY = s.s32();
  const endX = s.s32();
  const endY = s.s32();
  return { blockType, offset, key, next, parent, flags, unknown2, width, startX, startY, endX, endY };
}
function parseBlock0x1B(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const next = s.u32();
  const netName = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const type = s.u32();
  const assignment = s.u32();
  const ratline = s.u32();
  const fieldsPtr = s.u32();
  const matchGroupPtr = s.u32();
  const modelPtr = s.u32();
  const unknownPtr4 = s.u32();
  const unknownPtr5 = s.u32();
  const unknownPtr6 = s.u32();
  return {
    blockType: 27,
    offset,
    key,
    next,
    netName,
    unknown1,
    unknown2,
    type,
    assignment,
    ratline,
    fieldsPtr,
    matchGroupPtr,
    modelPtr,
    unknownPtr4,
    unknownPtr5,
    unknownPtr6
  };
}
function parseBlock0x1C(s, ver, offset) {
  const unknownByte1 = s.u8();
  const n = s.u8();
  const unknownByte2 = s.u8();
  const key = s.u32();
  const next = s.u32();
  const padStr = s.u32();
  const drill = s.u32();
  const unknown2 = s.u32();
  const padPath = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const unknown4 = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const unknown5 = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const unknown6 = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const typeByte = s.u8();
  const padType = (typeByte & 240) >> 4;
  const a = typeByte & 15;
  const b = s.u8();
  const flags = s.u8();
  const d = s.u8();
  const unknown7 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown8 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown9 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown10 = readCond(ver, FmtVer.V_172, "<", () => s.u16());
  const layerCount = s.u16();
  const unknown11 = readCond(ver, FmtVer.V_172, ">=", () => s.u16());
  const drillArr = [
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32()
  ];
  const slotAndUnknownArr = readCond(ver, FmtVer.V_172, ">=", () => {
    const arr = [];
    for (let i = 0; i < 28; i++) arr.push(s.u32());
    return arr;
  });
  const unknown12 = ver >= FmtVer.V_165 && ver < FmtVer.V_172 ? s.u32() : void 0;
  const v180Trailer = readCond(ver, FmtVer.V_180, ">=", () => {
    const arr = [];
    for (let i = 0; i < 8; i++) arr.push(s.u32());
    return arr;
  });
  let numFixedCompEntries;
  if (ver < FmtVer.V_165) {
    numFixedCompEntries = 10;
  } else if (ver < FmtVer.V_172) {
    numFixedCompEntries = 11;
  } else {
    numFixedCompEntries = 21;
  }
  const numCompsPerLayer = ver < FmtVer.V_172 ? 3 : 4;
  const nComps = numFixedCompEntries + layerCount * numCompsPerLayer;
  const components = [];
  for (let i = 0; i < nComps; i++) {
    const compType = s.u8();
    const unknownByte1c = s.u8();
    const unknownByte2c = s.u8();
    const unknownByte3c = s.u8();
    const unknown1c = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
    const w = s.s32();
    const h = s.s32();
    const z1 = readCond(ver, FmtVer.V_172, ">=", () => s.s16());
    const x3 = s.s32();
    const x4 = s.s32();
    const z = readCond(ver, FmtVer.V_172, ">=", () => s.s16());
    const strPtr = s.u32();
    let z2;
    if (!(ver < FmtVer.V_172 && i === nComps - 1)) {
      z2 = s.u32();
    }
    components.push({
      type: compType,
      unknownByte1: unknownByte1c,
      unknownByte2: unknownByte2c,
      unknownByte3: unknownByte3c,
      unknown1: unknown1c,
      w,
      h,
      z1,
      x3,
      x4,
      z,
      strPtr,
      z2
    });
  }
  const nElemsPerN = ver < FmtVer.V_172 ? 8 : 10;
  const nElems = n * nElemsPerN;
  const unknownArrN = [];
  for (let i = 0; i < nElems; i++) {
    unknownArrN.push(s.u32());
  }
  return {
    blockType: 28,
    offset,
    key,
    unknownByte1,
    n,
    unknownByte2,
    next,
    padStr,
    drill,
    unknown2,
    padPath,
    unknown3,
    unknown4,
    unknown5,
    unknown6,
    padType,
    a,
    b,
    flags,
    d,
    unknown7,
    unknown8,
    unknown9,
    unknown10,
    layerCount,
    unknown11,
    drillArr,
    slotAndUnknownArr,
    unknown12,
    v180Trailer,
    numFixedCompEntries,
    numCompsPerLayer,
    components,
    unknownArrN
  };
}
function parseBlock0x1D(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const next = s.u32();
  const nameStrKey = s.u32();
  const fieldPtr = s.u32();
  const sizeA = s.u16();
  const sizeB = s.u16();
  const dataB = [];
  for (let i = 0; i < sizeB; i++) {
    dataB.push(s.bytes(56).slice());
  }
  const dataA = [];
  for (let i = 0; i < sizeA; i++) {
    dataA.push(s.bytes(256).slice());
  }
  const unknown4 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  return { blockType: 29, offset, key, next, nameStrKey, fieldPtr, sizeA, sizeB, dataB, dataA, unknown4 };
}
function parseBlock0x1E(s, ver, offset) {
  const type = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const next = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_164, ">=", () => s.u16());
  const unknown3 = readCond(ver, FmtVer.V_164, ">=", () => s.u16());
  const strPtr = s.u32();
  const size = s.u32();
  const string = s.fixedString(size, true);
  const unknown4 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  return { blockType: 30, offset, key, type, t2, next, unknown2, unknown3, strPtr, size, string, unknown4 };
}
function parseBlock0x1F(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const next = s.u32();
  const unknown2 = s.u32();
  const unknown3 = s.u32();
  const unknown4 = s.u32();
  const unknown5 = s.u16();
  const size = s.u16();
  let substructSize;
  if (ver >= FmtVer.V_175) {
    substructSize = size * 384 + 8;
  } else if (ver >= FmtVer.V_172) {
    substructSize = size * 280 + 8;
  } else if (ver >= FmtVer.V_162) {
    substructSize = size * 280 + 4;
  } else {
    substructSize = size * 240 + 4;
  }
  const substruct = s.bytes(substructSize).slice();
  return { blockType: 31, offset, key, next, unknown2, unknown3, unknown4, unknown5, size, substruct };
}
function parseBlock0x20(s, ver, offset) {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const next = s.u32();
  const unknownArray1 = [
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32()
  ];
  const unknownArray2 = readCond(ver, FmtVer.V_174, ">=", () => {
    const arr = [];
    for (let i = 0; i < 10; i++) arr.push(s.u32());
    return arr;
  });
  return { blockType: 32, offset, key, type, r, next, unknownArray1, unknownArray2 };
}
function parseBlock0x21(s, _ver, offset) {
  const type = s.u8();
  const r = s.u16();
  const size = s.u32();
  if (size < 12) {
    throw new Error(`Block 0x21 size ${size} too small (minimum 12) at offset 0x${offset.toString(16)}`);
  }
  const key = s.u32();
  const nBytes = size - 12;
  const data = s.bytes(nBytes).slice();
  return { blockType: 33, offset, key, type, r, size, data };
}
function parseBlock0x22(s, ver, offset) {
  const type = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknownArray = [
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32()
  ];
  return { blockType: 34, offset, key, type, t2, unknown1, unknownArray };
}
function parseBlock0x23(s, ver, offset) {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const flags = [s.u32(), s.u32()];
  const ptr1 = s.u32();
  const ptr2 = s.u32();
  const ptr3 = s.u32();
  const coords = [s.s32(), s.s32(), s.s32(), s.s32(), s.s32()];
  const unknown1 = [s.u32(), s.u32(), s.u32(), s.u32()];
  const unknown2 = readCond(ver, FmtVer.V_164, ">=", () => {
    return [s.u32(), s.u32(), s.u32(), s.u32()];
  });
  const unknown3 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return { blockType: 35, offset, key, type, layer, next, flags, ptr1, ptr2, ptr3, coords, unknown1, unknown2, unknown3 };
}
function parseBlock0x24(s, ver, offset) {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const parent = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const coords = [s.s32(), s.s32(), s.s32(), s.s32()];
  const ptr2 = s.u32();
  const unknown3 = s.u32();
  const unknown4 = s.u32();
  const rotation = s.u32();
  return { blockType: 36, offset, key, type, layer, next, parent, unknown1, unknown2, coords, ptr2, unknown3, unknown4, rotation };
}
function parseBlock0x26(s, ver, offset) {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const memberPtr = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const groupPtr = s.u32();
  const constPtr = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return { blockType: 38, offset, key, type, r, memberPtr, unknown1, groupPtr, constPtr, unknown2 };
}
function parseBlock0x27(s, _ver, offset, x27End) {
  const totalBytes = x27End - 1 - s.position;
  const kPadding = 3;
  const refs = [];
  if (totalBytes <= kPadding) {
    s.skip(totalBytes);
    return { blockType: 39, offset, key: 0, refs };
  }
  s.skip(kPadding);
  const payloadBytes = totalBytes - kPadding;
  const numValues = Math.floor(payloadBytes / 4);
  const remainder = payloadBytes % 4;
  for (let i = 0; i < numValues; i++) {
    refs.push(s.u32());
  }
  if (remainder > 0) s.skip(remainder);
  return { blockType: 39, offset, key: 0, refs };
}
function parseBlock0x28(s, ver, offset) {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const ptr1 = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const ptr2 = s.u32();
  const ptr3 = s.u32();
  const firstKeepoutPtr = s.u32();
  const firstSegmentPtr = s.u32();
  const unknown4 = s.u32();
  const unknown5 = s.u32();
  const tablePtr = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const ptr6 = s.u32();
  const tablePtr_16x = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const coords = [s.s32(), s.s32(), s.s32(), s.s32()];
  return {
    blockType: 40,
    offset,
    key,
    type,
    layer,
    next,
    ptr1,
    unknown1,
    unknown2,
    unknown3,
    ptr2,
    ptr3,
    firstKeepoutPtr,
    firstSegmentPtr,
    unknown4,
    unknown5,
    tablePtr,
    ptr6,
    tablePtr_16x,
    coords
  };
}
function parseBlock0x29(s, _ver, offset) {
  const type = s.u8();
  const t = s.u16();
  const key = s.u32();
  const ptr1 = s.u32();
  const ptr2 = s.u32();
  const null_ = s.u32();
  const ptr3 = s.u32();
  const coord1 = s.s32();
  const coord2 = s.s32();
  const ptrPadstack = s.u32();
  const unknown1 = s.u32();
  const ptrX30 = s.u32();
  const unknown2 = s.u32();
  const unknown3 = s.u32();
  const unknown4 = s.u32();
  return { blockType: 41, offset, key, type, t, ptr1, ptr2, null_, ptr3, coord1, coord2, ptrPadstack, unknown1, ptrX30, unknown2, unknown3, unknown4 };
}
function parseBlock0x2A(s, ver, offset) {
  s.skip(1);
  const numEntries = s.u16();
  const unknown = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  let nonRefEntries;
  let refEntries;
  if (ver < FmtVer.V_165) {
    nonRefEntries = [];
    for (let i = 0; i < numEntries; i++) {
      nonRefEntries.push({ name: s.fixedString(36, true) });
    }
  } else {
    refEntries = [];
    for (let i = 0; i < numEntries; i++) {
      const layerNameId = s.u32();
      const properties = s.u32();
      const unkw = s.u32();
      refEntries.push({ layerNameId, properties, unknown: unkw });
    }
  }
  const key = s.u32();
  return { blockType: 42, offset, key, numEntries, unknown, nonRefEntries, refEntries };
}
function parseBlock0x2B(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const fpStrRef = s.u32();
  const unknown1 = s.u32();
  const coords = [s.u32(), s.u32(), s.u32(), s.u32()];
  const next = s.u32();
  const firstInstPtr = s.u32();
  const unknownPtr3 = s.u32();
  const unknownPtr4 = s.u32();
  const unknownPtr5 = s.u32();
  const symLibPathPtr = s.u32();
  const unknownPtr6 = s.u32();
  const unknownPtr7 = s.u32();
  const unknownPtr8 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_164, ">=", () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  return {
    blockType: 43,
    offset,
    key,
    fpStrRef,
    unknown1,
    coords,
    next,
    firstInstPtr,
    unknownPtr3,
    unknownPtr4,
    unknownPtr5,
    symLibPathPtr,
    unknownPtr6,
    unknownPtr7,
    unknownPtr8,
    unknown2,
    unknown3
  };
}
function parseBlock0x2C(s, ver, offset) {
  const type = s.u8();
  const subType = s.u16();
  const key = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const stringPtr = s.u32();
  const unknown4 = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const ptr1 = s.u32();
  const ptr2 = s.u32();
  const ptr3 = s.u32();
  const flags = s.u32();
  return { blockType: 44, offset, key, type, subType, next, unknown1, unknown2, unknown3, stringPtr, unknown4, ptr1, ptr2, ptr3, flags };
}
function parseBlock0x2D(s, ver, offset) {
  const unknownByte1 = s.u8();
  const layer = s.u8();
  const unknownByte2 = s.u8();
  const key = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const instRef16x = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const unknown2 = s.u16();
  const unknown3 = s.u16();
  const unknown4 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const flags = s.u32();
  const rotation = s.u32();
  const coordX = s.s32();
  const coordY = s.s32();
  const instRef = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const graphicPtr = s.u32();
  const firstPadPtr = s.u32();
  const textPtr = s.u32();
  const assemblyPtr = s.u32();
  const areasPtr = s.u32();
  const unknownPtr1 = s.u32();
  const unknownPtr2 = s.u32();
  return {
    blockType: 45,
    offset,
    key,
    unknownByte1,
    layer,
    unknownByte2,
    next,
    unknown1,
    instRef16x,
    unknown2,
    unknown3,
    unknown4,
    flags,
    rotation,
    coordX,
    coordY,
    instRef,
    graphicPtr,
    firstPadPtr,
    textPtr,
    assemblyPtr,
    areasPtr,
    unknownPtr1,
    unknownPtr2
  };
}
function parseBlock0x2E(s, ver, offset) {
  const type = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const next = s.u32();
  const netAssignment = s.u32();
  const unknown1 = s.u32();
  const coordX = s.u32();
  const coordY = s.u32();
  const connection = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  return { blockType: 46, offset, key, type, t2, next, netAssignment, unknown1, coordX, coordY, connection, unknown2, unknown3 };
}
function parseBlock0x2F(s, _ver, offset) {
  const type = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const unknownArray = [
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32()
  ];
  return { blockType: 47, offset, key, type, t2, unknownArray };
}
function parseTextProps(s) {
  return { key: s.u8(), flags: s.u8(), alignment: s.u8(), reversal: s.u8() };
}
function parseBlock0x30(s, ver, offset) {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const font = readCond(ver, FmtVer.V_172, ">=", () => parseTextProps(s));
  const ptr1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  const strGraphicPtr = s.u32();
  const ptrGroup_17x = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknown4 = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  const font16x = readCond(ver, FmtVer.V_172, "<", () => parseTextProps(s));
  const ptr2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const coordsX = s.u32();
  const coordsY = s.u32();
  const unknown5 = s.u32();
  const rotation = s.u32();
  const ptrGroup_16x = readCond(ver, FmtVer.V_172, "<", () => s.u32());
  return {
    blockType: 48,
    offset,
    key,
    type,
    layer,
    next,
    unknown1,
    unknown2,
    font,
    ptr1,
    unknown3,
    strGraphicPtr,
    ptrGroup_17x,
    unknown4,
    font16x,
    ptr2,
    coordsX,
    coordsY,
    unknown5,
    rotation,
    ptrGroup_16x
  };
}
function parseBlock0x31(s, ver, offset) {
  const t = s.u8();
  const layerCode = s.u16();
  const key = s.u32();
  const strGraphicWrapperPtr = s.u32();
  const coordsX = s.u32();
  const coordsY = s.u32();
  const unknown = s.u16();
  const len = s.u16();
  const un2 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  const value = s.fixedString(len, true);
  return { blockType: 49, offset, key, t, layerCode, strGraphicWrapperPtr, coordsX, coordsY, unknown, len, un2, value };
}
function parseBlock0x32(s, ver, offset) {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const netPtr = s.u32();
  const flags = s.u32();
  const prev = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const nextInFp = s.u32();
  const parentFp = s.u32();
  const track = s.u32();
  const padPtr = s.u32();
  const ptr6 = s.u32();
  const ratline = s.u32();
  const ptrPinNumber = s.u32();
  const nextInCompInst = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const nameText = s.u32();
  const ptr11 = s.u32();
  const coords = [s.s32(), s.s32(), s.s32(), s.s32()];
  return {
    blockType: 50,
    offset,
    key,
    type,
    layer,
    next,
    netPtr,
    flags,
    prev,
    nextInFp,
    parentFp,
    track,
    padPtr,
    ptr6,
    ratline,
    ptrPinNumber,
    nextInCompInst,
    unknown2,
    nameText,
    ptr11,
    coords
  };
}
function parseBlock0x33(s, ver, offset) {
  s.skip(1);
  const layerInfo = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const netPtr = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const unknownPtr1 = s.u32();
  const unknownPtr2 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const coordsX = s.s32();
  const coordsY = s.s32();
  const connection = s.u32();
  const padstack = s.u32();
  const unknownPtr5 = s.u32();
  const unknownPtr6 = s.u32();
  const unknown4 = s.u32();
  const unknown5 = s.u32();
  const bbox = [s.s32(), s.s32(), s.s32(), s.s32()];
  return {
    blockType: 51,
    offset,
    key,
    layerInfo,
    next,
    netPtr,
    unknown2,
    unknown3,
    unknownPtr1,
    unknownPtr2,
    coordsX,
    coordsY,
    connection,
    padstack,
    unknownPtr5,
    unknownPtr6,
    unknown4,
    unknown5,
    bbox
  };
}
function parseBlock0x34(s, ver, offset) {
  const t = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const ptr1 = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const flags = s.u32();
  const firstSegmentPtr = s.u32();
  const ptr3 = s.u32();
  const unknown2 = s.u32();
  return { blockType: 52, offset, key, t, layer, next, ptr1, unknown1, flags, firstSegmentPtr, ptr3, unknown2 };
}
function parseBlock0x35(s, _ver, offset) {
  const t2 = s.u8();
  const t3 = s.u16();
  const content = s.bytes(120).slice();
  return { blockType: 53, offset, key: offset, t2, t3, content };
}
function parseBlock0x36(s, ver, offset) {
  s.skip(1);
  const code = s.u16();
  const key = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const numItems = s.u32();
  const count = s.u32();
  const lastIdx = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  if (numItems > 1e6) {
    throw new Error(`Block 0x36 item count ${numItems} exceeds limit at offset 0x${offset.toString(16)}`);
  }
  const items = [];
  for (let i = 0; i < numItems; i++) {
    const keep = i < count;
    switch (code) {
      case 2: {
        const string = s.fixedString(32, true);
        const xs = [];
        for (let j = 0; j < 14; j++) xs.push(s.u32());
        const ys = readCond(ver, FmtVer.V_164, ">=", () => {
          const arr = [];
          for (let j = 0; j < 3; j++) arr.push(s.u32());
          return arr;
        });
        const zs = readCond(ver, FmtVer.V_172, ">=", () => {
          const arr = [];
          for (let j = 0; j < 2; j++) arr.push(s.u32());
          return arr;
        });
        if (keep) items.push({ kind: "x02", string, xs, ys, zs });
        break;
      }
      case 3: {
        const str = ver >= FmtVer.V_172 ? s.fixedString(64, true) : s.fixedString(32, true);
        const unknown1c = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
        if (keep) items.push({ kind: "x03", str, unknown1: unknown1c });
        break;
      }
      case 5: {
        const unknown = s.bytes(28).slice();
        const unknown2c = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
        if (keep) items.push({ kind: "x05", unknown, unknown2: unknown2c });
        break;
      }
      case 6: {
        const n = s.u16();
        const r = s.u8();
        const sc = s.u8();
        const unknown1c = s.u32();
        const unknown2c = readCond(ver, FmtVer.V_172, "<", () => {
          const arr = [];
          for (let j = 0; j < 50; j++) arr.push(s.u32());
          return arr;
        });
        if (keep) items.push({ kind: "x06", n, r, s: sc, unknown1: unknown1c, unknown2: unknown2c });
        break;
      }
      case 8: {
        const a = s.u32();
        const b = s.u32();
        const charHeight = s.u32();
        const charWidth = s.u32();
        const unknown2c = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
        const characterSpace = s.u32();
        const lineSpace = s.u32();
        const unknown3c = s.u32();
        const strokeWidth = s.u32();
        const ys = readCond(ver, FmtVer.V_172, ">=", () => {
          const arr = [];
          for (let j = 0; j < 8; j++) arr.push(s.u32());
          return arr;
        });
        if (keep) items.push({ kind: "x08_font", a, b, charHeight, charWidth, unknown2: unknown2c, characterSpace, lineSpace, unknown3: unknown3c, strokeWidth, ys });
        break;
      }
      case 11: {
        const unknown = s.bytes(1016).slice();
        if (keep) items.push({ kind: "x0B", unknown });
        break;
      }
      case 12: {
        const unknown = s.bytes(232).slice();
        if (keep) items.push({ kind: "x0C", unknown });
        break;
      }
      case 13: {
        const unknown = s.bytes(200).slice();
        if (keep) items.push({ kind: "x0D", unknown });
        break;
      }
      case 15: {
        const itemKey = s.u32();
        const ptrs = [s.u32(), s.u32(), s.u32()];
        const ptr2 = s.u32();
        if (keep) items.push({ kind: "x0F", key: itemKey, ptrs, ptr2 });
        break;
      }
      case 16: {
        const unknown = s.bytes(108).slice();
        const unknown2c = readCond(ver, FmtVer.V_180, ">=", () => s.u32());
        if (keep) items.push({ kind: "x10", unknown, unknown2: unknown2c });
        break;
      }
      case 18: {
        s.skip(1052);
        if (keep) items.push({ kind: "x12" });
        break;
      }
      default:
        throw new Error(`Unknown substruct type 0x${code.toString(16)} in block 0x36 at offset 0x${offset.toString(16)}`);
    }
  }
  return { blockType: 54, offset, key, code, next, unknown1, numItems, count, lastIdx, unknown2, unknown3, items };
}
function parseBlock0x37(s, ver, offset) {
  const t = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const groupPtr = s.u32();
  const next = s.u32();
  const capacity = s.u32();
  const count = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  const ptrs = s.u32Array(100);
  return { blockType: 55, offset, key, t, t2, groupPtr, next, capacity, count, unknown2, unknown3, ptrs };
}
function parseBlock0x38(s, ver, offset) {
  s.skip(3);
  const key = s.u32();
  const next = s.u32();
  const layerList = s.u32();
  const filmName = readCond(ver, FmtVer.V_166, "<", () => s.fixedString(20, true));
  const layerNameStr = readCond(ver, FmtVer.V_166, ">=", () => s.u32());
  const unknown2 = readCond(ver, FmtVer.V_166, ">=", () => s.u32());
  const unknownArray1 = [
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32(),
    s.u32()
  ];
  const unknown3 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return { blockType: 56, offset, key, next, layerList, filmName, layerNameStr, unknown2, unknownArray1, unknown3 };
}
function parseBlock0x39(s, _ver, offset) {
  s.skip(3);
  const key = s.u32();
  const parent = s.u32();
  const head = s.u32();
  const x = [];
  for (let i = 0; i < 22; i++) {
    x.push(s.u16());
  }
  return { blockType: 57, offset, key, parent, head, x };
}
function parseBlock0x3A(s, ver, offset) {
  s.skip(1);
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const unknown = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  return { blockType: 58, offset, key, layer, next, unknown, unknown1 };
}
function parseBlock0x3B(s, ver, offset) {
  const t = s.u8();
  const subType = s.u16();
  const len = s.u32();
  const name = s.fixedString(128, true);
  const type = s.fixedString(32, true);
  const unknown1 = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_172, ">=", () => s.u32());
  const value = s.fixedString(len, true);
  return { blockType: 59, offset, key: offset, t, subType, len, name, type, unknown1, unknown2, unknown3, value };
}
function parseBlock0x3C(s, ver, offset) {
  const t = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const unknown = readCond(ver, FmtVer.V_174, ">=", () => s.u32());
  const numEntries = s.u32();
  if (numEntries > 1e6) {
    throw new Error(`Block 0x3C entry count ${numEntries} exceeds limit at offset 0x${offset.toString(16)}`);
  }
  const entries = [];
  for (let i = 0; i < numEntries; i++) {
    entries.push(s.u32());
  }
  return { blockType: 60, offset, key, t, t2, unknown, numEntries, entries };
}
function parseBlock(stream, ver, x27End) {
  const offset = stream.position;
  const type = stream.u8();
  switch (type) {
    case 0:
      return null;
    case 1:
      return parseBlock0x01(stream, ver, offset);
    case 3:
      return parseBlock0x03(stream, ver, offset);
    case 4:
      return parseBlock0x04(stream, ver, offset);
    case 5:
      return parseBlock0x05(stream, ver, offset);
    case 6:
      return parseBlock0x06(stream, ver, offset);
    case 7:
      return parseBlock0x07(stream, ver, offset);
    case 8:
      return parseBlock0x08(stream, ver, offset);
    case 9:
      return parseBlock0x09(stream, ver, offset);
    case 10:
      return parseBlock0x0A(stream, ver, offset);
    case 12:
      return parseBlock0x0C(stream, ver, offset);
    case 13:
      return parseBlock0x0D(stream, ver, offset);
    case 14:
      return parseBlock0x0E(stream, ver, offset);
    case 15:
      return parseBlock0x0F(stream, ver, offset);
    case 16:
      return parseBlock0x10(stream, ver, offset);
    case 17:
      return parseBlock0x11(stream, ver, offset);
    case 18:
      return parseBlock0x12(stream, ver, offset);
    case 20:
      return parseBlock0x14(stream, ver, offset);
    case 21:
      return parseBlock0x15_16_17(stream, ver, offset, 21);
    case 22:
      return parseBlock0x15_16_17(stream, ver, offset, 22);
    case 23:
      return parseBlock0x15_16_17(stream, ver, offset, 23);
    case 27:
      return parseBlock0x1B(stream, ver, offset);
    case 28:
      return parseBlock0x1C(stream, ver, offset);
    case 29:
      return parseBlock0x1D(stream, ver, offset);
    case 30:
      return parseBlock0x1E(stream, ver, offset);
    case 31:
      return parseBlock0x1F(stream, ver, offset);
    case 32:
      return parseBlock0x20(stream, ver, offset);
    case 33:
      return parseBlock0x21(stream, ver, offset);
    case 34:
      return parseBlock0x22(stream, ver, offset);
    case 35:
      return parseBlock0x23(stream, ver, offset);
    case 36:
      return parseBlock0x24(stream, ver, offset);
    case 38:
      return parseBlock0x26(stream, ver, offset);
    case 39:
      return parseBlock0x27(stream, ver, offset, x27End);
    case 40:
      return parseBlock0x28(stream, ver, offset);
    case 41:
      return parseBlock0x29(stream, ver, offset);
    case 42:
      return parseBlock0x2A(stream, ver, offset);
    case 43:
      return parseBlock0x2B(stream, ver, offset);
    case 44:
      return parseBlock0x2C(stream, ver, offset);
    case 45:
      return parseBlock0x2D(stream, ver, offset);
    case 46:
      return parseBlock0x2E(stream, ver, offset);
    case 47:
      return parseBlock0x2F(stream, ver, offset);
    case 48:
      return parseBlock0x30(stream, ver, offset);
    case 49:
      return parseBlock0x31(stream, ver, offset);
    case 50:
      return parseBlock0x32(stream, ver, offset);
    case 51:
      return parseBlock0x33(stream, ver, offset);
    case 52:
      return parseBlock0x34(stream, ver, offset);
    case 53:
      return parseBlock0x35(stream, ver, offset);
    case 54:
      return parseBlock0x36(stream, ver, offset);
    case 55:
      return parseBlock0x37(stream, ver, offset);
    case 56:
      return parseBlock0x38(stream, ver, offset);
    case 57:
      return parseBlock0x39(stream, ver, offset);
    case 58:
      return parseBlock0x3A(stream, ver, offset);
    case 59:
      return parseBlock0x3B(stream, ver, offset);
    case 60:
      return parseBlock0x3C(stream, ver, offset);
    default:
      throw new Error(`Unknown block type 0x${type.toString(16).padStart(2, "0")} at offset 0x${offset.toString(16)}`);
  }
}

// api/board/parser/_boardripper/vendor/store/log-store.ts
var silent = (..._args) => {
};
var log = { parser: { log: silent, warn: silent, error: silent, debug: silent, info: silent } };

// api/board/parser/_boardripper/vendor/parsers/allegro/allegro-db.ts
var dbg = log.parser;
var STRING_TABLE_OFFSET = 4608;
var V15_HEADER_OK = new Map([
  ...[52, 32, 68, 180, 172, 16, 108, 28, 24, 140, 72].map((t) => [t, (b3) => b3 === 0 || b3 === 1]),
  [200, (b3) => (b3 & 31) === 0],
  ...[80, 88, 84, 92, 48, 192, 196].map((t) => [t, () => true])
]);
var AllegroDb = class {
  header;
  strings;
  blocks;
  /**
   * Non-fatal parse warning set when the interleaved (v16+) block walk breaks
   * early on a malformed/unknown block. The stream has no length prefixes, so
   * we can't resync past a bad record — every later object (parts, nets,
   * traces) is silently lost. When that happens and we end up materially short
   * of the header's object count, this holds a human-readable warning that
   * `assembleBoard` surfaces via `board.parserNotes` (a load-time toast), so an
   * incomplete board is flagged instead of returning "successfully". Undefined
   * = clean parse.
   */
  parseWarning;
  /**
   * v15 only: per placed instance (BLK_0x2D key) the pads of its pad ring,
   * with inline pin numbers and resolved nets. Undefined for v16+.
   */
  v15Pads;
  constructor(buffer) {
    const stream = new AllegroStream(buffer);
    this.header = parseHeader(stream);
    dbg.log(
      `Allegro ${this.header.allegroVersion.trim()} (ver=${Object.entries(FmtVer).find(([, v]) => v === this.header.fmtVer)?.[0] ?? this.header.fmtVer}, objects=${this.header.objectCount}, strings=${this.header.stringsCount})`
    );
    this.strings = this.parseStringTable(stream);
    dbg.log(`String table: ${this.strings.size} entries`);
    this.blocks = this.header.fmtVer === FmtVer.V_15X ? this.parseBlocksV15(stream) : this.parseBlocks(stream);
    dbg.log(`Blocks: ${this.blocks.size} objects parsed`);
  }
  // ── Public API ──────────────────────────────────────────────────────────────
  /** Look up a string by its id key. Returns '' for unknown/zero keys. */
  getString(key) {
    if (key === 0) return "";
    return this.strings.get(key) ?? "";
  }
  /** Look up a block by its key. */
  getBlock(key) {
    return this.blocks.get(key);
  }
  /** Look up a block by key, with a type-narrowing assertion. */
  getBlockAs(key, expectedType) {
    const blk = this.blocks.get(key);
    if (!blk) return void 0;
    if (blk.blockType !== expectedType) return void 0;
    return blk;
  }
  /**
   * Walk a linked list starting at ll.head, following getNext() on each block.
   * Stops at ll.tail, key 0, or after 1M iterations (safety valve).
   */
  walkLinkedList(ll, getNext) {
    const result = [];
    let key = ll.head;
    const MAX_ITER = 1e6;
    for (let i = 0; i < MAX_ITER; i++) {
      if (key === 0 || key === ll.tail) break;
      const blk = this.blocks.get(key);
      if (!blk) break;
      result.push(blk);
      key = getNext(blk);
    }
    return result;
  }
  // ── Private parsing ─────────────────────────────────────────────────────────
  /**
   * Parse the string table at offset 0x1200.
   * Each entry: [u32 id][null-terminated string][word-aligned padding].
   */
  parseStringTable(stream) {
    const map = /* @__PURE__ */ new Map();
    stream.seek(STRING_TABLE_OFFSET);
    for (let i = 0; i < this.header.stringsCount; i++) {
      if (stream.eof) break;
      const id = stream.u32();
      const str = stream.cString(true);
      map.set(id, str);
    }
    return map;
  }
  /**
   * Parse all blocks sequentially from the current stream position.
   *
   * V180: zero-padded gaps between block groups. When we encounter a run of
   * zero bytes, skip them and realign to a 4-byte boundary before checking
   * for the next valid block type byte.
   */
  parseBlocks(stream) {
    const map = /* @__PURE__ */ new Map();
    const ver = this.header.fmtVer;
    const x27End = this.header.x27End;
    const isV180 = ver >= FmtVer.V_180;
    let abortedAt = null;
    while (!stream.eof) {
      if (isV180) {
        let skipped = false;
        while (!stream.eof && stream.peekU8() === 0) {
          stream.skip(1);
          skipped = true;
        }
        if (skipped) {
          const remainder = stream.position % 4;
          if (remainder !== 0) {
            stream.skip(4 - remainder);
          }
        }
      }
      if (stream.eof) break;
      if (stream.peekU8() === 0) break;
      const peekType = stream.peekU8();
      if (peekType > 60) {
        if (isV180) {
          stream.skip(1);
          continue;
        }
        break;
      }
      try {
        const block = parseBlock(stream, ver, x27End);
        if (block === null) break;
        map.set(block.key, block);
      } catch (e) {
        abortedAt = `0x${stream.position.toString(16)}: ${e instanceof Error ? e.message : e}`;
        break;
      }
    }
    if (abortedAt !== null && map.size < this.header.objectCount) {
      dbg.warn(
        `Block stream aborted at ${abortedAt} \u2014 parsed ${map.size} of ${this.header.objectCount} objects; remaining objects were dropped.`
      );
      this.parseWarning = `Incomplete parse: only ${map.size} of ${this.header.objectCount} board objects were read before a malformed block stopped the walk. Some parts, nets, or traces may be missing.`;
    }
    return map;
  }
  /**
   * v15 block walker. v15 lays out blocks per-type contiguously with no inline
   * type tag — each LL group sits at a single contiguous file region. Records
   * within a group share a 4-byte prefix `00 18 0X 00` (where 0X is a per-record
   * sub-type byte) followed by 8 × u32 of payload.
   *
   * Key↔offset relation: `m_Key = file_offset + globalAddend`, with
   * `globalAddend = LL_0x06.head - string_table_end_offset` (constant per file).
   * Verified on COMPAL LA-7321P (addend 0x07a82140) and v13tl-0629 (0x081e174c).
   *
   * This first cut walks LL_0x06 (component definitions) only. Other LLs
   * (LL_0x2B, LL_0x07, LL_0x2D, LL_0x32, LL_0x1C…) are deferred to follow-up
   * commits — assembleBoard will produce an empty parts list until those land.
   */
  parseBlocksV15(stream) {
    const map = /* @__PURE__ */ new Map();
    const stringTableEndOffset = stream.position;
    const ll0x06 = this.header.LL_0x06;
    if (!ll0x06 || ll0x06.head === 0) {
      dbg.warn("v15: LL_0x06 head is null \u2014 no components to walk");
      return map;
    }
    const globalAddend = ll0x06.head - stringTableEndOffset;
    dbg.log(`v15: key addend = 0x${globalAddend.toString(16)} (LL_0x06.head 0x${ll0x06.head.toString(16)} - strEnd 0x${stringTableEndOffset.toString(16)})`);
    const nComponents = this.walkV15LL(stream, ll0x06, globalAddend, map, (s, offset, mKey, _prefix) => {
      const next = s.u32();
      const compDeviceType = s.u32();
      const symbolName = s.u32();
      const firstInstPtr = s.u32();
      const ptrFunctionSlot = s.u32();
      const ptrPinNumber = s.u32();
      const fields = s.u32();
      return {
        block: {
          blockType: 6,
          offset,
          key: mKey,
          next,
          compDeviceType,
          symbolName,
          firstInstPtr,
          ptrFunctionSlot,
          ptrPinNumber,
          fields,
          unknown1: void 0
        },
        next
      };
    });
    dbg.log(`v15: walked LL_0x06 \u2192 ${nComponents} components`);
    const ll0x2B = this.header.LL_0x2B;
    if (ll0x2B && ll0x2B.head !== 0) {
      const nFootprints = this.walkV15LL(stream, ll0x2B, globalAddend, map, (s, offset, mKey, _prefix) => {
        const fpStrRef = s.u32();
        const unknown1 = s.u32();
        const coords = [
          s.u32() | 0,
          s.u32() | 0,
          s.u32() | 0,
          s.u32() | 0
        ];
        const next = s.u32();
        const firstInstPtr = s.u32();
        const unknownPtr3 = s.u32();
        const unknownPtr4 = s.u32();
        const unknownPtr5 = s.u32();
        const symLibPathPtr = s.u32();
        const unknownPtr6 = s.u32();
        const unknownPtr7 = s.u32();
        const unknownPtr8 = s.u32();
        return {
          block: {
            blockType: 43,
            offset,
            key: mKey,
            next,
            fpStrRef,
            unknown1,
            coords,
            firstInstPtr,
            unknownPtr3,
            unknownPtr4,
            unknownPtr5,
            symLibPathPtr,
            unknownPtr6,
            unknownPtr7,
            unknownPtr8,
            unknown2: void 0
          },
          next
        };
      });
      dbg.log(`v15: walked LL_0x2B \u2192 ${nFootprints} footprints`);
    }
    const ll0x1B = this.header.LL_0x1B_Nets;
    if (ll0x1B && ll0x1B.head !== 0) {
      const nNets = this.walkV15LL(stream, ll0x1B, globalAddend, map, (s, offset, mKey, _prefix) => {
        const next = s.u32();
        const netName = s.u32();
        const flags = s.u32();
        for (let i = 0; i < 8; i++) s.u32();
        return {
          block: {
            blockType: 27,
            offset,
            key: mKey,
            next,
            netName,
            flags
          },
          next
        };
      });
      dbg.log(`v15: walked LL_0x1B_Nets \u2192 ${nNets} nets`);
    }
    let firstInst07 = Infinity;
    for (const blk of map.values()) {
      if (blk.blockType !== 6) continue;
      const c = blk;
      if (c.firstInstPtr > 0 && c.firstInstPtr < firstInst07) {
        firstInst07 = c.firstInstPtr;
      }
    }
    if (firstInst07 !== Infinity) {
      const start07 = firstInst07 - globalAddend;
      let scan07 = start07;
      let n07 = 0;
      while (scan07 + 64 <= stream.size) {
        stream.seek(scan07);
        const p0 = stream.u8();
        const p1 = stream.u8();
        stream.skip(1);
        const p3 = stream.u8();
        if (p0 !== 0 || p1 !== 28 || p3 !== 0) break;
        const mKey = stream.u32();
        stream.seek(scan07 + 8);
        const refdesBytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) refdesBytes[i] = stream.u8();
        let endIdx = 0;
        while (endIdx < 32 && refdesBytes[endIdx] !== 0) endIdx++;
        const refdes = new TextDecoder("utf-8", { fatal: false }).decode(refdesBytes.subarray(0, endIdx));
        stream.seek(scan07 + 40);
        const compDefBack = stream.u32();
        map.set(mKey, {
          blockType: 7,
          offset: scan07,
          key: mKey,
          next: 0,
          // v15 doesn't chain instances by m_Next
          unknownPtr1: 0,
          instRef16x: 0,
          // v15-specific: not used (we use the inline refdes directly)
          functionInst: 0,
          firstPadPtr: 0,
          unknown3: 0,
          layer: 0,
          refDesStrPtr: 0,
          // v15 inlines refdes — no string-table key. v15Refdes below carries the resolved value.
          v15Refdes: refdes,
          // non-standard field consumed by extractComponentsV15
          v15CompDefBack: compDefBack
        });
        n07++;
        scan07 += 64;
      }
      dbg.log(`v15: scanned BLK_0x07 \u2192 ${n07} component instances at 0x${start07.toString(16)}..0x${scan07.toString(16)}`);
    }
    let firstInst2D = Infinity;
    for (const blk of map.values()) {
      if (blk.blockType !== 43) continue;
      const fp = blk;
      if (fp.firstInstPtr > 0 && fp.firstInstPtr < firstInst2D) {
        firstInst2D = fp.firstInstPtr;
      }
    }
    if (firstInst2D !== Infinity) {
      const start = firstInst2D - globalAddend;
      let scanPos = start;
      let n2D = 0;
      while (scanPos + 60 <= stream.size) {
        stream.seek(scanPos);
        const p0 = stream.u8();
        const p1 = stream.u8();
        const layerByte = stream.u8();
        const p3 = stream.u8();
        if (p0 !== 0 || p1 !== 180 || p3 !== 0) break;
        const mKey = stream.u32();
        stream.skip(4);
        const rotationMillideg = stream.u32();
        const coordX = stream.s32();
        const coordY = stream.s32();
        const next18 = stream.u32();
        const compDefRef = stream.u32();
        stream.skip(4);
        const firstPad24 = stream.u32();
        map.set(mKey, {
          blockType: 45,
          offset: scanPos,
          key: mKey,
          next: next18,
          unknownByte1: 0,
          layer: layerByte,
          // 0=top, 1=bottom (v15 prefix byte 2)
          unknownByte2: 0,
          unknown1: void 0,
          instRef16x: compDefRef,
          unknown2: 0,
          unknown3: 0,
          unknown4: void 0,
          flags: 0,
          rotation: rotationMillideg,
          coordX,
          coordY,
          instRef: void 0,
          graphicPtr: 0,
          firstPadPtr: firstPad24,
          textPtr: 0,
          assemblyPtr: 0,
          areasPtr: 0,
          unknownPtr1: 0,
          unknownPtr2: compDefRef
        });
        n2D++;
        scanPos += 60;
      }
      dbg.log(`v15: scanned BLK_0x2D \u2192 ${n2D} placed instances at 0x${start.toString(16)}..0x${scanPos.toString(16)}`);
      let resolvedFp = 0;
      for (const blk of map.values()) {
        if (blk.blockType !== 45) continue;
        const inst = blk;
        let k = inst.next;
        const seen = /* @__PURE__ */ new Set([inst.key]);
        for (let hop = 0; hop < 1e5 && k !== 0 && !seen.has(k); hop++) {
          seen.add(k);
          const t = map.get(k);
          if (!t) break;
          if (t.blockType === 43) {
            inst.unknownPtr1 = k;
            resolvedFp++;
            break;
          }
          if (t.blockType !== 45) break;
          k = t.next;
        }
        if (map.get(inst.next)?.blockType === 43) inst.next = 0;
      }
      dbg.log(`v15: resolved footprint definition for ${resolvedFp} of ${n2D} instances via the +0x18 chain`);
    }
    this.v15Pads = this.indexV15Pads(stream, map, globalAddend);
    return map;
  }
  /**
   * v15 pads, pin numbers and nets.
   *
   * ## Why pointers need an index, not a subtraction
   *
   * A v15 file is a heap image: `m_Key` is the record's memory address, and
   * `key − fileOffset` is only constant inside one contiguous pool. Between
   * pools the addend drifts (Kronos: 0x83557f4 for the LL pools up to
   * ~0x8396000 for shapes — some 260 KB of memory that was never written).
   * So a pointer cannot be resolved by one addend. Instead every 4-aligned
   * position that reads `00 b1 b2 b3 | key` with `key − off` inside a window
   * around the primary addend is a *candidate* record start, indexed by key.
   * ~10% of keys have several candidates (a zero-terminated field followed by
   * a pointer looks like a header), so every lookup names the type byte it
   * expects. Measured on Kronos: with a type-blind first-wins index 2377 of
   * 5277 pads lost their pin number and 150 rings ended on junk; with the
   * type-aware lookup every ring closes on its owning BLK_0x2D.
   *
   * ## The pad ring (replaces the byte1=0x40 → BLK_0x48 chain)
   *
   *   BLK_0x2D.+0x24 → BLK_0xC8 (first pad)
   *   BLK_0xC8.+0x10 → next BLK_0xC8; the last one points back at the 2D
   *   BLK_0xC8.+0x14 → owning BLK_0x2D (checked)
   *   BLK_0xC8.+0x1C → [0x34] pin-number record, inline ASCII at +0x08
   *   BLK_0xC8.+0x28 → [0x20] component-pin record (inline pin number at
   *                    +0x08, +0x2C → [0x44] with the inline pin *name*)
   *   BLK_0xC8.+0x38..+0x44 pad bbox, board-absolute
   *
   * The old BLK_0x48 chain visited pads in an order unrelated to the pin
   * numbers and the walker invented sequential numbers: on Kronos that
   * swapped pins 1↔3 of every SOT-23 and 1↔2 of every diode (435 "wrong"
   * nets against the v17 oracle that were all correct by position), and it
   * lost 3095 of 7982 pins because BGA rings pass through records the
   * prefix scan mis-keyed.
   *
   * ## Net routes, in priority order — each measured at 0 false positives on
   * the 7715 Kronos pins whose v17 re-save names a net
   *
   *   R1  [0x10] NetAssign: +0x10 → C8, +0x0C → [0x6c] net      (forward)
   *   R5  C8.+0x0C → [0x10] → +0x0C → [0x6c]                    (back-link;
   *       ALL prefix byte-3 variants — the shipped loop accepted only
   *       `00 c8 ?? 00` and so skipped every through-hole pad, which is
   *       where 450 of the 495 remaining misses were)
   *   R8c [0x8c] member record: +0x10 / +0x18 → C8; its +0x08 chain
   *       (through 0x8c/0x48/0x50/0x58/… records) ends at the [0x6c] net
   *   R08 C8.+0x08 → next member C8 → … → [0x10] NetAssign
   */
  indexV15Pads(stream, map, globalAddend) {
    const bytes = new Uint8Array(stream.view.buffer);
    const u32 = (off) => (bytes[off] | bytes[off + 1] << 8 | bytes[off + 2] << 16 | bytes[off + 3] << 24) >>> 0;
    const i32 = (off) => u32(off) | 0;
    const WINDOW_BELOW = 1048576;
    const WINDOW_ABOVE = 8388608;
    const index = /* @__PURE__ */ new Map();
    let candidates = 0;
    const ofType = /* @__PURE__ */ new Map();
    for (let off = 0; off + 8 <= bytes.length; off += 4) {
      const b1 = bytes[off + 1];
      if (bytes[off] !== 0 && !(b1 === 200 && (bytes[off] & ~20) === 0)) continue;
      const ok = V15_HEADER_OK.get(b1);
      if (!ok || !ok(bytes[off + 3])) continue;
      const key = u32(off + 4);
      const add = key - off;
      if (add < globalAddend - WINDOW_BELOW || add > globalAddend + WINDOW_ABOVE) continue;
      candidates++;
      const cur = index.get(key);
      if (cur === void 0) index.set(key, off);
      else if (typeof cur === "number") index.set(key, [cur, off]);
      else cur.push(off);
      let arr = ofType.get(b1);
      if (!arr) {
        arr = [];
        ofType.set(b1, arr);
      }
      arr.push(off);
    }
    const rec = (key, b1) => {
      if (key === 0) return -1;
      const cur = index.get(key);
      if (cur === void 0) return -1;
      if (typeof cur === "number") return bytes[cur + 1] === b1 ? cur : -1;
      for (const o of cur) if (bytes[o + 1] === b1) return o;
      return -1;
    };
    const recAny = (key, types) => {
      if (key === 0) return -1;
      const cur = index.get(key);
      if (cur === void 0) return -1;
      if (typeof cur === "number") return types.has(bytes[cur + 1]) ? cur : -1;
      for (const o of cur) if (types.has(bytes[o + 1])) return o;
      return -1;
    };
    const inlineAscii = (off, max) => {
      let s = "";
      for (let i = 0; i < max; i++) {
        const c = bytes[off + i];
        if (c === 0) break;
        if (c < 32 || c > 126) return "";
        s += String.fromCharCode(c);
      }
      return s;
    };
    dbg.log(`v15: pointer index \u2014 ${candidates} candidates, ${index.size} keys`);
    const netNameOf = (k6c) => {
      const o = rec(k6c, 108);
      if (o < 0) return "";
      const raw = this.strings.get(u32(o + 12)) ?? "";
      return raw.startsWith("/") ? raw.slice(1) : raw;
    };
    const netOf10 = (k10) => {
      const o = rec(k10, 16);
      if (o < 0) return "";
      return netNameOf(u32(o + 12)) || netNameOf(u32(o + 8));
    };
    const byInstance = /* @__PURE__ */ new Map();
    const allPads = [];
    let rings = 0, closed = 0, noNumber = 0, ownerMismatch = 0;
    for (const blk of map.values()) {
      if (blk.blockType !== 45) continue;
      const inst = blk;
      const pins = [];
      byInstance.set(inst.key, pins);
      let k = inst.firstPadPtr;
      if (k === 0) continue;
      rings++;
      const seen = /* @__PURE__ */ new Set();
      while (k !== 0 && !seen.has(k) && pins.length < 1e4) {
        seen.add(k);
        if (k === inst.key) {
          closed++;
          break;
        }
        const o = rec(k, 200);
        if (o < 0) break;
        if (u32(o + 20) !== inst.key) {
          ownerMismatch++;
          break;
        }
        const o34 = rec(u32(o + 28), 52);
        const o20 = rec(u32(o + 40), 32);
        let number = o34 >= 0 ? inlineAscii(o34 + 8, 32) : "";
        if (!number && o20 >= 0) number = inlineAscii(o20 + 8, 32);
        if (!number) noNumber++;
        const o44 = o20 >= 0 ? rec(u32(o20 + 44), 68) : -1;
        const name = o44 >= 0 ? inlineAscii(o44 + 8, 32) : "";
        const pin = {
          c8Key: k,
          number,
          name,
          coords: [i32(o + 56), i32(o + 60), i32(o + 64), i32(o + 68)],
          flags: bytes[o + 3],
          net: ""
        };
        pins.push(pin);
        allPads.push({ pin, off: o });
        k = u32(o + 16);
      }
    }
    dbg.log(`v15: pad rings \u2014 ${rings} walked, ${closed} closed on their instance, ${allPads.length} pads, ${noNumber} without pin number, ${ownerMismatch} owner mismatches`);
    const netByC8 = /* @__PURE__ */ new Map();
    const counts = { r1: 0, r5: 0, r8c: 0, r08: 0 };
    for (const off of ofType.get(16) ?? []) {
      const c8 = u32(off + 16);
      if (rec(c8, 200) < 0 || netByC8.has(c8)) continue;
      const n = netNameOf(u32(off + 12));
      if (n) {
        netByC8.set(c8, n);
        counts.r1++;
      }
    }
    for (const { pin, off } of allPads) {
      if (netByC8.has(pin.c8Key)) continue;
      const n = netOf10(u32(off + 12));
      if (n) {
        netByC8.set(pin.c8Key, n);
        counts.r5++;
      }
    }
    const CHASE_HOPS = /* @__PURE__ */ new Set([72, 80, 140, 88, 84, 92, 48, 192, 196]);
    const chaseToNet = (startOff) => {
      let k = u32(startOff + 8);
      const seen = /* @__PURE__ */ new Set();
      for (let i = 0; i < 200 && k !== 0 && !seen.has(k); i++) {
        seen.add(k);
        if (rec(k, 108) >= 0) return netNameOf(k);
        const o = recAny(k, CHASE_HOPS);
        if (o < 0) return "";
        k = u32(o + 8);
      }
      return "";
    };
    for (const off of ofType.get(140) ?? []) {
      for (const fo of [16, 24]) {
        const c8 = u32(off + fo);
        if (rec(c8, 200) < 0 || netByC8.has(c8)) continue;
        const n = chaseToNet(off);
        if (n) {
          netByC8.set(c8, n);
          counts.r8c++;
        }
      }
    }
    for (const { pin, off } of allPads) {
      if (netByC8.has(pin.c8Key)) continue;
      let k = u32(off + 8);
      const seen = /* @__PURE__ */ new Set([pin.c8Key]);
      let n = "";
      for (let i = 0; i < 5e3 && k !== 0 && !seen.has(k); i++) {
        seen.add(k);
        const oc = rec(k, 200);
        if (oc >= 0) {
          k = u32(oc + 8);
          continue;
        }
        n = netOf10(k);
        break;
      }
      if (n) {
        netByC8.set(pin.c8Key, n);
        counts.r08++;
      }
    }
    let netted = 0;
    for (const { pin } of allPads) {
      pin.net = netByC8.get(pin.c8Key) ?? "";
      if (pin.net) netted++;
    }
    dbg.log(`v15: nets \u2014 R1 ${counts.r1}, R5 ${counts.r5}, R8c ${counts.r8c}, R08 ${counts.r08}; ${netted} of ${allPads.length} pads named`);
    return { byInstance, routeCounts: counts };
  }
  /** Walk a v15 linked list. The per-block parser owns reading m_Next from
   *  whatever field position is correct for that block type; it returns the
   *  parsed block plus the next-key the walker should follow. The walker only
   *  reads the 4-byte prefix and m_Key (which are at constant offsets 0 and 4
   *  in every observed v15 block) and dispatches the rest. */
  walkV15LL(stream, ll, globalAddend, map, parseRecord) {
    let n = 0;
    let key = ll.head;
    const visited = /* @__PURE__ */ new Set();
    const MAX_ITER = 1e6;
    for (let i = 0; i < MAX_ITER && key !== 0 && key !== ll.tail; i++) {
      if (visited.has(key)) {
        dbg.warn(`v15: cycle detected at key 0x${key.toString(16)}, stopping`);
        break;
      }
      visited.add(key);
      const offset = key - globalAddend;
      if (offset < 0 || offset + 8 > stream.size) {
        dbg.warn(`v15: record at key 0x${key.toString(16)} \u2192 offset 0x${offset.toString(16)} out of bounds`);
        break;
      }
      stream.seek(offset);
      const prefix = stream.u32();
      const mKey = stream.u32();
      if (mKey !== key) {
        dbg.warn(`v15: record at offset 0x${offset.toString(16)} has m_Key 0x${mKey.toString(16)} != expected 0x${key.toString(16)}`);
        break;
      }
      const { block, next } = parseRecord(stream, offset, mKey, prefix);
      map.set(block.key, block);
      n++;
      key = next;
    }
    return n;
  }
};

// api/board/parser/_boardripper/vendor/parsers/types.ts
function computeBBox(points) {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}
function buildNets(parts) {
  const nets = /* @__PURE__ */ new Map();
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin = part.pins[pni];
      if (!pin.net || pin.net === "(null)" || pin.net === "") continue;
      let net = nets.get(pin.net);
      if (!net) {
        net = { name: pin.net, pinIndices: [] };
        nets.set(pin.net, net);
      }
      net.pinIndices.push({ partIndex: pi, pinIndex: pni });
    }
  }
  return nets;
}

// api/board/parser/_boardripper/vendor/parsers/allegro/allegro-infer-placement.ts
function pointKey(p) {
  return `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
}
function buildDanglingIndex(traces, terminatorKeys) {
  const degree = /* @__PURE__ */ new Map();
  const point = /* @__PURE__ */ new Map();
  for (const t of traces) {
    for (const p of [t.start, t.end]) {
      const k = `${t.net}|${pointKey(p)}`;
      degree.set(k, (degree.get(k) ?? 0) + 1);
      if (!point.has(k)) point.set(k, { p, net: t.net, layer: t.layer ?? 0 });
    }
  }
  const byNet = /* @__PURE__ */ new Map();
  const layerAt = /* @__PURE__ */ new Map();
  for (const [k, n] of degree) {
    if (n !== 1) continue;
    const e = point.get(k);
    if (terminatorKeys.has(pointKey(e.p))) continue;
    let arr = byNet.get(e.net);
    if (!arr) byNet.set(e.net, arr = []);
    arr.push(e.p);
    layerAt.set(pointKey(e.p), e.layer);
  }
  return { byNet, layerAt };
}
var COLLINEAR_TOL = 2;
var PITCH_TOL = 3;
var MIN_RUN = 3;
function fillRunGaps(pinNumbers, pinPositions) {
  const num = pinNumbers.map((n) => /^\d+$/.test(n) ? parseInt(n, 10) : NaN);
  if (num.some((n) => Number.isNaN(n))) return 0;
  const located = pinPositions.map((p, i) => ({ p, i })).filter((e) => e.p !== null);
  const runs = [];
  for (const axis of ["x", "y"]) {
    const off = axis === "x" ? "y" : "x";
    const used = /* @__PURE__ */ new Set();
    for (const a of located) {
      if (used.has(a.i)) continue;
      const members = located.filter((b) => Math.abs(b.p[axis] - a.p[axis]) <= COLLINEAR_TOL);
      if (members.length < MIN_RUN) continue;
      for (const m of members) used.add(m.i);
      void off;
      runs.push({ axis, members });
    }
  }
  let filled = 0;
  for (const run of runs) {
    const varies = run.axis === "x" ? "y" : "x";
    const sorted = [...run.members].sort((a, b) => num[a.i] - num[b.i]);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const span = num[last.i] - num[first.i];
    if (span < 2) continue;
    const pitch = (last.p[varies] - first.p[varies]) / span;
    if (Math.abs(pitch) < 1) continue;
    const consistent = sorted.every((m) => {
      const predicted = first.p[varies] + pitch * (num[m.i] - num[first.i]);
      return Math.abs(predicted - m.p[varies]) <= PITCH_TOL;
    });
    if (!consistent) continue;
    for (let i = 0; i < pinPositions.length; i++) {
      if (pinPositions[i] !== null) continue;
      const n = num[i];
      if (n <= num[first.i] || n >= num[last.i]) continue;
      const along = first.p[varies] + pitch * (n - num[first.i]);
      pinPositions[i] = run.axis === "x" ? { x: first.p.x, y: along } : { x: along, y: first.p.y };
      filled++;
    }
  }
  return filled;
}
var MAX_SEED_ENDS = 6;
var GROW_EPS = 120;
var CLAIM_RADIUS = 150;
var MIN_RESOLVED = 4;
var MIN_PINS = 5;
var MIN_RESOLVED_FRACTION = 0.1;
var MAX_CLUSTER_SPAN = 4e3;
var dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function inferPlacement(pinNets, idx, pinNumbers) {
  if (pinNets.length < MIN_PINS) return null;
  const seeds = [];
  for (const net of new Set(pinNets)) {
    const ends = idx.byNet.get(net);
    if (ends && ends.length >= 1 && ends.length <= MAX_SEED_ENDS) seeds.push(...ends);
  }
  if (seeds.length < MIN_RESOLVED) return null;
  let best = seeds[0], bestN = -1;
  for (const s of seeds) {
    let n = 0;
    for (const o of seeds) if (dist(s, o) <= GROW_EPS) n++;
    if (n > bestN) {
      bestN = n;
      best = s;
    }
  }
  const cluster = [best];
  const used = /* @__PURE__ */ new Set([best]);
  for (let i = 0; i < cluster.length; i++) {
    for (const s of seeds) {
      if (used.has(s)) continue;
      if (dist(cluster[i], s) <= GROW_EPS) {
        used.add(s);
        cluster.push(s);
      }
    }
  }
  if (cluster.length < MIN_RESOLVED) return null;
  const cxs = cluster.map((p) => p.x), cys = cluster.map((p) => p.y);
  if (Math.max(...cxs) - Math.min(...cxs) > MAX_CLUSTER_SPAN) return null;
  if (Math.max(...cys) - Math.min(...cys) > MAX_CLUSTER_SPAN) return null;
  const nearCluster = (p) => cluster.some((c) => dist(c, p) <= CLAIM_RADIUS);
  const taken = /* @__PURE__ */ new Set();
  const pinPositions = [];
  for (const net of pinNets) {
    const ends = (idx.byNet.get(net) ?? []).filter((p) => !taken.has(pointKey(p)) && nearCluster(p));
    if (ends.length !== 1) {
      pinPositions.push(null);
      continue;
    }
    taken.add(pointKey(ends[0]));
    pinPositions.push(ends[0]);
  }
  {
    const claimed = pinPositions.map((p, i) => ({ p, i })).filter((e) => e.p !== null);
    const seenIdx = /* @__PURE__ */ new Set();
    let biggest = [];
    for (const start of claimed) {
      if (seenIdx.has(start.i)) continue;
      const group = [start.i];
      seenIdx.add(start.i);
      for (let g = 0; g < group.length; g++) {
        for (const o of claimed) {
          if (seenIdx.has(o.i)) continue;
          if (dist(pinPositions[group[g]], o.p) <= GROW_EPS) {
            seenIdx.add(o.i);
            group.push(o.i);
          }
        }
      }
      if (group.length > biggest.length) biggest = group;
    }
    const keep = new Set(biggest);
    for (let i = 0; i < pinPositions.length; i++) if (pinPositions[i] && !keep.has(i)) pinPositions[i] = null;
  }
  const located = pinPositions.filter((p) => p !== null);
  if (located.length < MIN_RESOLVED) return null;
  if (located.length / pinNets.length < MIN_RESOLVED_FRACTION) return null;
  const interpolated = pinNumbers ? fillRunGaps(pinNumbers, pinPositions) : 0;
  const finalLocated = pinPositions.filter((p) => p !== null);
  const xs = finalLocated.map((p) => p.x), ys = finalLocated.map((p) => p.y);
  const bounds = {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  };
  return {
    origin: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
    pinPositions,
    resolved: finalLocated.length,
    interpolated,
    bounds
  };
}

// api/board/parser/_boardripper/vendor/parsers/allegro/allegro-assembler.ts
var dbg2 = log.parser;
var SUBCLASS_ASSEMBLY_TOP = 247;
var SUBCLASS_ASSEMBLY_BOTTOM = 246;
function footprintSide(db, fpInst) {
  const gfx = db.getBlockAs(fpInst.graphicPtr, 20);
  if (gfx) {
    if (gfx.layer.subclass === SUBCLASS_ASSEMBLY_TOP) return "top";
    if (gfx.layer.subclass === SUBCLASS_ASSEMBLY_BOTTOM) return "bottom";
  }
  return fpInst.layer === 0 ? "top" : "bottom";
}
function pointsToFootprintDef(db, key) {
  return key !== 0 && !!db.getBlockAs(key, 43);
}
function milsPerUnit(units) {
  switch (units) {
    case BoardUnits.MILS:
      return 1;
    case BoardUnits.INCHES:
      return 1e3;
    case BoardUnits.MILLIMETERS:
      return 1 / 0.0254;
    // 39.3700787…
    case BoardUnits.CENTIMETERS:
      return 10 / 0.0254;
    // 393.700787…
    case BoardUnits.MICROMETERS:
      return 1e-3 / 0.0254;
    // 0.0393700787…
    default:
      return 1;
  }
}
function assembleBoard(db) {
  const ver = db.header.fmtVer;
  const rawDiv = db.header.unitsDivisor || 1;
  const div = rawDiv / milsPerUnit(db.header.boardUnits);
  const netAssignMap = buildNetAssignMap(db);
  const layerNamesEarly = /* @__PURE__ */ (() => {
    let c = null;
    return () => c ??= extractLayerNames(db);
  })();
  const { parts, allPinPositions } = extractComponents(db, ver, div, netAssignMap);
  const pinsOnTop = parts.filter((p) => p.side === "top").reduce((n, p) => n + p.pins.length, 0);
  const pinsOnBottom = parts.filter((p) => p.side === "bottom").reduce((n, p) => n + p.pins.length, 0);
  const totalPins = pinsOnTop + pinsOnBottom;
  const primarySide = totalPins > 0 && pinsOnBottom / totalPins > 0.55 ? "bottom" : "top";
  if (primarySide === "bottom") {
    dbg2.log(
      `Side inversion detected: pin majority on side='bottom' (${pinsOnBottom}) vs side='top' (${pinsOnTop}). Setting primarySide='bottom'; renderer will swap scene layers.`
    );
  }
  const etchBase = etchSubclassBase(etchTrackSubclasses(db));
  const traces = extractTraces(db, ver, div, netAssignMap, etchBase);
  const surfaces = extractSurfaces(db, div, netAssignMap, etchBase);
  const vias = extractVias(db, div, netAssignMap);
  const recovered = recoverUnplacedParts(db, ver, netAssignMap, parts, traces, vias, layerNamesEarly());
  parts.push(...recovered);
  const outline = extractOutline(db, ver, div);
  const silkscreen = extractSilkscreen(db, div);
  const pads = extractPads(db, div, netAssignMap);
  const layerNames = layerNamesEarly();
  const allPoints = [];
  for (const p of outline) allPoints.push(p);
  for (const part of parts) allPoints.push(part.origin);
  for (const p of allPinPositions) allPoints.push(p);
  const bounds = computeBBox(allPoints);
  dbg2.log(
    `Assembled: ${parts.length} parts, ${parts.reduce((n, p) => n + p.pins.length, 0)} pins, ${traces.length} traces, ${vias.length} vias, ${outline.length} outline pts, ${silkscreen.length} silkscreen paths, ${pads.length} pads, ${surfaces.length} surfaces, ${layerNames.length} layers`
  );
  const unplaced = collectUnplacedRefdes(db);
  const notes = [];
  if (db.parseWarning) notes.push(db.parseWarning);
  if (unplaced.length > 0) {
    const stillLost = unplaced.length - recovered.length;
    notes.push(
      `${unplaced.length} component${unplaced.length === 1 ? "" : "s"} have a netlist but no stored position in this file. ` + (recovered.length > 0 ? `${recovered.length} were located from the routing that ends on their pads and are drawn with a dashed amber outline \u2014 their pads are recovered, not read, and only some pads of each resolve. ` : "") + (stillLost > 0 ? `${stillLost} could not be located (mounting holes and parts with too little routing).` : "")
    );
  }
  const nets = ver === FmtVer.V_15X ? buildV15Nets(db, parts) : buildNets(parts);
  return {
    format: "ALLEGRO_BRD",
    formatVersion: fmtVerLabel(ver),
    outline,
    parts,
    nails: [],
    nets,
    bounds,
    traces: traces.length > 0 ? traces : void 0,
    vias: vias.length > 0 ? vias : void 0,
    silkscreen: silkscreen.length > 0 ? silkscreen : void 0,
    pads: pads.length > 0 ? pads : void 0,
    surfaces: surfaces.length > 0 ? surfaces : void 0,
    layerNames: layerNames.length > 0 ? layerNames : void 0,
    primarySide: primarySide === "bottom" ? "bottom" : void 0,
    // Surface a truncated block-stream parse (see AllegroDb.parseWarning) as a
    // load-time note so an incomplete board is flagged, not silent.
    parserNotes: notes.length > 0 ? notes : void 0
  };
}
function collectUnplacedRefdes(db) {
  const out = [];
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 7) continue;
    const inst = blk;
    const fp = inst.fpInstPtr ? db.getBlock(inst.fpInstPtr) : null;
    if (fp && fp.blockType === 45) continue;
    const name = db.getString(inst.refDesStrPtr);
    if (!name) continue;
    let pins = 0;
    let key = inst.firstPadPtr;
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < 1e5 && key !== 0 && !seen.has(key); i++) {
      seen.add(key);
      const pad = db.getBlock(key);
      if (!pad) break;
      if (pad.blockType === 50) pins++;
      key = pad.nextInCompInst ?? 0;
    }
    out.push({ name, pins });
  }
  out.sort((a, b) => b.pins - a.pins || a.name.localeCompare(b.name));
  return out.map((c) => c.name);
}
function fmtVerLabel(v) {
  switch (v) {
    case FmtVer.V_160:
      return "16.0";
    case FmtVer.V_162:
      return "16.2";
    case FmtVer.V_164:
      return "16.4";
    case FmtVer.V_165:
      return "16.5";
    case FmtVer.V_166:
      return "16.6";
    case FmtVer.V_172:
      return "17.2";
    case FmtVer.V_174:
      return "17.4";
    case FmtVer.V_175:
      return "17.5";
    case FmtVer.V_180:
      return "18.0";
    default:
      return void 0;
  }
}
function buildNetAssignMap(db) {
  const map = /* @__PURE__ */ new Map();
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 4) continue;
    const na = blk;
    const netBlk = db.getBlockAs(na.net, 27);
    if (!netBlk) continue;
    const netName = db.getString(netBlk.netName);
    if (!netName) continue;
    map.set(na.key, netName);
    if (na.connItem !== 0) {
      map.set(na.connItem, netName);
    }
  }
  return map;
}
function extractComponents(db, ver, div, netAssignMap) {
  if (ver === FmtVer.V_15X) {
    return extractComponentsV15(db, div);
  }
  const parts = [];
  const allPinPositions = [];
  const fpDefs = db.walkLinkedList(
    db.header.LL_0x2B,
    (blk) => blk.next
  );
  for (const fpDefBlk of fpDefs) {
    if (fpDefBlk.blockType !== 43) continue;
    const fpDef = fpDefBlk;
    const footprintName = fpDef.fpStrRef ? db.getString(fpDef.fpStrRef) : "";
    let instKey = fpDef.firstInstPtr;
    const MAX_INST = 1e6;
    const visitedInst = /* @__PURE__ */ new Set();
    for (let ii = 0; ii < MAX_INST && instKey !== 0; ii++) {
      if (visitedInst.has(instKey)) break;
      visitedInst.add(instKey);
      const inst = db.getBlockAs(instKey, 45);
      if (!inst) break;
      const instRefKey = ver >= FmtVer.V_172 ? inst.instRef : inst.instRef16x;
      let refdes = "";
      if (instRefKey) {
        const compInst = db.getBlockAs(instRefKey, 7);
        if (compInst) {
          refdes = db.getString(compInst.refDesStrPtr);
        }
      }
      if (!refdes) {
        instKey = inst.next;
        continue;
      }
      const origin = { x: inst.coordX / div, y: inst.coordY / div };
      const side = footprintSide(db, inst);
      const { pins, hasThru } = extractPins(db, inst, ver, div, netAssignMap);
      for (const pin of pins) {
        allPinPositions.push(pin.position);
      }
      const pinPts = pins.map((p) => p.position);
      pinPts.push(origin);
      const bounds = computeBBox(pinPts);
      const partType = hasThru ? "throughhole" : "smd";
      parts.push({
        name: refdes,
        side,
        type: partType,
        origin,
        pins,
        bounds,
        ...footprintName ? { meta: { package: footprintName } } : {}
      });
      instKey = inst.next;
    }
  }
  return { parts, allPinPositions };
}
function buildV15Nets(db, parts) {
  const m = /* @__PURE__ */ new Map();
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 27) continue;
    const netBlk = blk;
    const raw = db.getString(netBlk.netName);
    if (!raw) continue;
    const name = raw.startsWith("/") ? raw.slice(1) : raw;
    if (!m.has(name)) m.set(name, { name, pinIndices: [] });
  }
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin = part.pins[pni];
      if (!pin.net) continue;
      let net = m.get(pin.net);
      if (!net) {
        net = { name: pin.net, pinIndices: [] };
        m.set(pin.net, net);
      }
      net.pinIndices.push({ partIndex: pi, pinIndex: pni });
    }
  }
  return m;
}
function extractComponentsV15(db, div) {
  const parts = [];
  const allPinPositions = [];
  const pads = db.v15Pads;
  let skippedSymbols = 0;
  let ringless = 0;
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 45) continue;
    const inst = blk;
    const compInst = inst.instRef16x ? db.blocks.get(inst.instRef16x) : void 0;
    const refdes = compInst && compInst.blockType === 7 ? compInst.v15Refdes ?? "" : "";
    if (!refdes) {
      skippedSymbols++;
      continue;
    }
    const fpDef = db.blocks.get(inst.unknownPtr1);
    const fpName = fpDef && fpDef.blockType === 43 && fpDef.fpStrRef ? db.getString(fpDef.fpStrRef) : "";
    const ox = inst.coordX / div;
    const oy = inst.coordY / div;
    const side = inst.layer === 1 ? "bottom" : "top";
    const pins = [];
    let hasThru = false;
    const ring = pads?.byInstance.get(inst.key) ?? [];
    if (ring.length === 0) ringless++;
    for (const pad of ring) {
      const [x1, y1, x2, y2] = pad.coords;
      const cx = (x1 + x2) / 2 / div;
      const cy = (y1 + y2) / 2 / div;
      const w = Math.abs(x2 - x1) / div;
      const h = Math.abs(y2 - y1) / div;
      if (!(w < 500 && h < 500) || cx === 0 && cy === 0) continue;
      if (pad.flags & 128) hasThru = true;
      const radius = Math.max(2, Math.min(w, h) / 2);
      pins.push({
        // '' when the footprint gives the pad no number — the mounting posts
        // of the BGA/TSOP sockets on Kronos; Allegro's own v17 re-save leaves
        // them blank too, and a ring-position stand-in would collide with the
        // real pins 1, 2, … of the same part.
        name: pad.name,
        number: pad.number,
        position: { x: cx, y: cy },
        radius,
        side,
        net: pad.net,
        padBounds: { minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2 }
      });
      allPinPositions.push({ x: cx, y: cy });
    }
    let bounds;
    if (pins.length > 0) {
      const xs = pins.map((p) => p.position.x);
      const ys = pins.map((p) => p.position.y);
      const margin = 20;
      bounds = {
        minX: Math.min(...xs) - margin,
        minY: Math.min(...ys) - margin,
        maxX: Math.max(...xs) + margin,
        maxY: Math.max(...ys) + margin
      };
    } else {
      const placeholderHalf = 30;
      bounds = { minX: ox - placeholderHalf, minY: oy - placeholderHalf, maxX: ox + placeholderHalf, maxY: oy + placeholderHalf };
    }
    parts.push({
      name: refdes,
      side,
      type: hasThru ? "throughhole" : "smd",
      origin: { x: ox, y: oy },
      pins,
      bounds,
      ...fpName ? { meta: { package: fpName } } : {}
    });
  }
  dbg2.log(
    `v15: ${parts.length} parts (${skippedSymbols} instance-less drawing symbols skipped, ${ringless} parts without a pad ring), ${allPinPositions.length} pins, ${parts.reduce((n, p) => n + p.pins.filter((q) => q.net).length, 0)} with a net`
  );
  return { parts, allPinPositions };
}
function extractPins(db, fpInst, ver, div, netAssignMap) {
  const pins = [];
  let padKey = fpInst.firstPadPtr;
  const MAX_PADS = 1e6;
  const visited = /* @__PURE__ */ new Set();
  let hasThru = false;
  for (let i = 0; i < MAX_PADS && padKey !== 0; i++) {
    if (visited.has(padKey)) break;
    visited.add(padKey);
    const pad = db.getBlockAs(padKey, 50);
    if (!pad) break;
    const [cx1, cy1, cx2, cy2] = pad.coords;
    const px = (cx1 + cx2) / 2 / div;
    const py = (cy1 + cy2) / 2 / div;
    let pinNumber = "";
    const pinNumBlk = db.getBlockAs(pad.ptrPinNumber, 8);
    if (pinNumBlk) {
      const strKey = ver >= FmtVer.V_172 ? pinNumBlk.strPtr : pinNumBlk.strPtr16x;
      if (strKey) {
        pinNumber = db.getString(strKey);
      }
    }
    let pinName = "";
    if (pinNumBlk && pinNumBlk.pinNamePtr) {
      const pinNameBlk = db.getBlockAs(pinNumBlk.pinNamePtr, 17);
      if (pinNameBlk) {
        pinName = db.getString(pinNameBlk.pinNameStrPtr);
      }
    }
    const net = netAssignMap.get(pad.netPtr) ?? "";
    const bw = Math.abs(cx2 - cx1) / div;
    const bh = Math.abs(cy2 - cy1) / div;
    const rawRadius = Math.min(bw, bh) / 2;
    const radius = Math.max(3, Math.min(30, rawRadius));
    const side = footprintSide(db, fpInst);
    const fallbackW = Math.abs(cx2 - cx1) / div;
    const fallbackH = Math.abs(cy2 - cy1) / div;
    let padShape;
    let padW = fallbackW;
    let padH = fallbackH;
    let padAngleDeg = 0;
    const padBlock = db.getBlockAs(pad.padPtr, 13);
    if (padBlock) {
      const ps = db.getBlockAs(padBlock.padStack, 28);
      if (ps) {
        if (ps.layerCount > 1 || ps.drill > 0) hasThru = true;
        const resolved = resolvePadShape(ps);
        if (resolved) {
          padShape = resolved.shape;
          padW = resolved.w / div;
          padH = resolved.h / div;
          padAngleDeg = (fpInst.rotation + padBlock.rotation) / 1e3;
        }
      }
    }
    const rad = padAngleDeg * Math.PI / 180;
    const aCo = Math.abs(Math.cos(rad));
    const aSi = Math.abs(Math.sin(rad));
    const aabbW = padW * aCo + padH * aSi;
    const aabbH = padW * aSi + padH * aCo;
    const padMinX = px - aabbW / 2;
    const padMaxX = px + aabbW / 2;
    const padMinY = py - aabbH / 2;
    const padMaxY = py + aabbH / 2;
    const padCornerRadius = padShape === "roundrect" ? Math.min(padW, padH) / 2 : void 0;
    pins.push({
      name: pinName,
      number: pinNumber,
      position: { x: px, y: py },
      radius,
      side,
      net,
      padBounds: { minX: padMinX, minY: padMinY, maxX: padMaxX, maxY: padMaxY },
      ...padShape ? { padShape, padWidth: padW, padHeight: padH } : {},
      ...padAngleDeg !== 0 ? { padAngleDeg } : {},
      ...padCornerRadius != null ? { padCornerRadius } : {}
    });
    padKey = pad.nextInFp;
  }
  return { pins, hasThru };
}
function recoverUnplacedParts(db, ver, netAssignMap, placed, traces, vias, layerNames) {
  if (traces.length === 0) return [];
  const terminators = /* @__PURE__ */ new Set();
  for (const p of placed) for (const q of p.pins) terminators.add(pointKey(q.position));
  for (const v of vias) terminators.add(pointKey(v.position));
  const idx = buildDanglingIndex(traces, terminators);
  const lastLayer = Math.max(0, layerNames.length - 1);
  const out = [];
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 7) continue;
    const inst = blk;
    const fp = inst.fpInstPtr ? db.getBlock(inst.fpInstPtr) : null;
    if (fp && fp.blockType === 45) continue;
    const name = db.getString(inst.refDesStrPtr);
    if (!name) continue;
    const pinNames = [];
    const pinNets = [];
    let key = inst.firstPadPtr;
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < 1e5 && key !== 0 && !seen.has(key); i++) {
      seen.add(key);
      const pad = db.getBlock(key);
      if (!pad) break;
      if (pad.blockType === 50) {
        const pp = pad;
        let num = "";
        const numBlk = db.getBlockAs(pp.ptrPinNumber, 8);
        if (numBlk) {
          const strKey = ver >= FmtVer.V_172 ? numBlk.strPtr : numBlk.strPtr16x;
          if (strKey) num = db.getString(strKey);
        }
        pinNames.push(num || String(pinNames.length + 1));
        pinNets.push(netAssignMap.get(pp.netPtr) ?? "");
      }
      key = pad.nextInCompInst ?? 0;
    }
    if (pinNets.length === 0) continue;
    const guess = inferPlacement(pinNets, idx, pinNames);
    if (!guess) continue;
    let top = 0, bottom = 0;
    const pins = [];
    guess.pinPositions.forEach((pos, i) => {
      if (!pos) return;
      const layer = idx.layerAt.get(pointKey(pos)) ?? 0;
      if (layer === lastLayer && lastLayer !== 0) bottom++;
      else top++;
      pins.push({
        name: pinNames[i],
        number: pinNames[i],
        position: pos,
        radius: 8,
        side: layer === lastLayer && lastLayer !== 0 ? "bottom" : "top",
        net: pinNets[i]
      });
    });
    if (pins.length === 0) continue;
    const side = bottom > top ? "bottom" : "top";
    for (const q of pins) q.side = side;
    out.push({
      name,
      side,
      type: "unknown",
      origin: guess.origin,
      pins,
      bounds: guess.bounds,
      placementInferred: true,
      meta: {
        package: db.getString(db.getBlock(inst.next)?.compDeviceType ?? 0) ?? void 0,
        note: `Position recovered from routing \u2014 ${guess.resolved} of ${pinNets.length} pads located` + (guess.interpolated > 0 ? ` (${guess.resolved - guess.interpolated} from trace ends, ${guess.interpolated} filled in from the pad pitch)` : "") + `. Not stored in the file.`
      }
    });
  }
  return out;
}
function* etchTrackSubclasses(db) {
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 5) continue;
    const t = blk;
    if (t.layer.classCode === LayerClass.ETCH) yield t.layer.subclass;
  }
}
function etchSubclassBase(subclasses) {
  let base = Infinity;
  for (const s of subclasses) if (s < base) base = s;
  return Number.isFinite(base) ? base : 0;
}
function etchLayerIndex(subclass, base) {
  return Math.max(0, subclass - base);
}
function extractTraces(db, _ver, div, netAssignMap, subclassBase) {
  const traces = [];
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 5) continue;
    const track = blk;
    if (track.layer.classCode !== LayerClass.ETCH) continue;
    if (pointsToFootprintDef(db, track.netAssignment)) continue;
    const net = netAssignMap.get(track.netAssignment) ?? "";
    const layerIdx = etchLayerIndex(track.layer.subclass, subclassBase);
    let segKey = track.firstSegPtr;
    const MAX_SEGS = 1e6;
    for (let i = 0; i < MAX_SEGS && segKey !== 0; i++) {
      const seg = db.getBlock(segKey);
      if (!seg) break;
      if (seg.blockType === 21 || seg.blockType === 22 || seg.blockType === 23) {
        const s = seg;
        const width = s.width / div;
        traces.push({
          start: { x: s.startX / div, y: s.startY / div },
          end: { x: s.endX / div, y: s.endY / div },
          width: width > 0 ? width : 1,
          net,
          layer: layerIdx
        });
        segKey = s.next;
      } else if (seg.blockType === 1) {
        const arc = seg;
        const arcTraces = linearizeArc(arc, div, net, layerIdx);
        for (const t of arcTraces) traces.push(t);
        segKey = arc.next;
      } else {
        break;
      }
    }
  }
  return traces;
}
function linearizeArc(arc, div, net, layer) {
  const traces = [];
  const cx = arc.centerX / div;
  const cy = arc.centerY / div;
  const sx = arc.startX / div;
  const sy = arc.startY / div;
  const ex = arc.endX / div;
  const ey = arc.endY / div;
  const width = arc.width / div || 1;
  const startAngle = Math.atan2(sy - cy, sx - cx);
  const endAngle = Math.atan2(ey - cy, ex - cx);
  const radius = arc.radius / div;
  if (radius <= 0) {
    traces.push({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, width, net, layer });
    return traces;
  }
  const clockwise = (arc.subType & 64) !== 0;
  let sweep;
  if (clockwise) {
    sweep = startAngle - endAngle;
    if (sweep <= 0) sweep += 2 * Math.PI;
  } else {
    sweep = endAngle - startAngle;
    if (sweep <= 0) sweep += 2 * Math.PI;
  }
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const dAngle = (clockwise ? -sweep : sweep) / steps;
  let prevX = sx;
  let prevY = sy;
  for (let i = 1; i <= steps; i++) {
    const angle = startAngle + dAngle * i;
    const nx = i === steps ? ex : cx + radius * Math.cos(angle);
    const ny = i === steps ? ey : cy + radius * Math.sin(angle);
    traces.push({
      start: { x: prevX, y: prevY },
      end: { x: nx, y: ny },
      width,
      net,
      layer
    });
    prevX = nx;
    prevY = ny;
  }
  return traces;
}
function extractSilkscreen(db, div) {
  const out = [];
  const MAX_CHAIN = 1e4;
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 7) continue;
    const inst = blk;
    const fp = db.getBlock(inst.fpInstPtr);
    if (!fp || fp.blockType !== 45) continue;
    const fpInst = fp;
    if (!fpInst.graphicPtr) continue;
    const side = footprintSide(db, fpInst);
    let key = fpInst.graphicPtr;
    const visited = /* @__PURE__ */ new Set();
    for (let i = 0; i < MAX_CHAIN; i++) {
      if (key === 0 || visited.has(key)) break;
      visited.add(key);
      const g = db.getBlock(key);
      if (!g || g.blockType !== 20) break;
      const gfx = g;
      if (gfx.layer.classCode === LayerClass.PACKAGE_GEOMETRY) {
        const points = walkSegmentChain(db, gfx.segmentPtr, div);
        if (points.length >= 2) out.push({ points, side });
      }
      key = gfx.next;
    }
  }
  return out;
}
function resolvePadShape(padstack) {
  const isSmd = padstack.layerCount <= 1;
  let comp = padstack.components[0];
  if (!isSmd) {
    for (let i = 1; i < padstack.components.length; i++) {
      const c = padstack.components[i];
      if (c.type !== 0 && c.w > 0 && c.h > 0 && c.type !== 23) {
        comp = c;
        break;
      }
    }
  }
  if (!comp || comp.type === 0 || comp.w <= 0 || comp.h <= 0) return null;
  const isCircle = comp.w === comp.h;
  let shape;
  switch (comp.type) {
    case 2:
      shape = "round";
      break;
    case 6:
      shape = "rect";
      break;
    case 12:
    case 22:
      shape = isCircle ? "round" : "roundrect";
      break;
    case 23:
      shape = "poly";
      break;
    default:
      return null;
  }
  return { shape, w: comp.w, h: comp.h, isCircle };
}
function extractPads(db, div, netAssignMap) {
  const out = [];
  const MAX_CHAIN = 1e5;
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 7) continue;
    const inst = blk;
    const fp = db.getBlock(inst.fpInstPtr);
    if (!fp || fp.blockType !== 45) continue;
    const fpInst = fp;
    const fpSide = footprintSide(db, fpInst);
    let key = fpInst.firstPadPtr;
    const visited = /* @__PURE__ */ new Set();
    for (let i = 0; i < MAX_CHAIN; i++) {
      if (key === 0 || visited.has(key)) break;
      visited.add(key);
      const placed = db.getBlock(key);
      if (!placed || placed.blockType !== 50) break;
      const pp = placed;
      const [bx1, by1, bx2, by2] = pp.coords;
      const ccx = (bx1 + bx2) / 2 / div;
      const ccy = (by1 + by2) / 2 / div;
      const fallbackW = Math.abs(bx2 - bx1) / div;
      const fallbackH = Math.abs(by2 - by1) / div;
      let side = fpSide;
      let drill;
      let shape;
      let padW = fallbackW;
      let padH = fallbackH;
      let angleDeg = 0;
      const padBlock = db.getBlock(pp.padPtr);
      if (padBlock && padBlock.blockType === 13) {
        const ps = db.getBlock(padBlock.padStack);
        if (ps && ps.blockType === 28) {
          const padstack = ps;
          if (padstack.layerCount > 1) side = "both";
          if (side === "both" && padstack.drill > 0) {
            drill = padstack.drill / div;
          }
          const resolved = resolvePadShape(padstack);
          if (resolved) {
            shape = resolved.shape;
            padW = resolved.w / div;
            padH = resolved.h / div;
            angleDeg = (fpInst.rotation + padBlock.rotation) / 1e3;
          }
        }
      }
      if (padW <= 0 || padH <= 0) {
        key = pp.nextInFp;
        continue;
      }
      const rad = angleDeg * Math.PI / 180;
      const aCo = Math.abs(Math.cos(rad));
      const aSi = Math.abs(Math.sin(rad));
      const aabbW = padW * aCo + padH * aSi;
      const aabbH = padW * aSi + padH * aCo;
      const minX = ccx - aabbW / 2;
      const maxX = ccx + aabbW / 2;
      const minY = ccy - aabbH / 2;
      const maxY = ccy + aabbH / 2;
      const cornerRadius = shape === "roundrect" ? Math.min(padW, padH) / 2 : void 0;
      const net = netAssignMap.get(pp.netPtr);
      out.push({
        bounds: { minX, minY, maxX, maxY },
        side,
        net: net && net.length > 0 ? net : void 0,
        drill,
        ...shape ? { shape, width: padW, height: padH } : {},
        ...angleDeg !== 0 ? { angleDeg } : {},
        ...cornerRadius != null ? { cornerRadius } : {}
      });
      key = pp.nextInFp;
    }
  }
  return out;
}
function extractVias(db, div, netAssignMap) {
  const vias = [];
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 51) continue;
    const via = blk;
    if (pointsToFootprintDef(db, via.netPtr)) continue;
    const x = via.coordsX / div;
    const y = via.coordsY / div;
    const net = netAssignMap.get(via.netPtr) ?? "";
    const padstack = db.getBlock(via.padstack);
    let diameter = 0;
    if (padstack && padstack.blockType === 28) {
      const ps = padstack;
      if (ps.drill > 0) diameter = ps.drill / div;
    }
    if (diameter <= 0) {
      const [bx1, , bx2] = via.bbox;
      diameter = Math.abs(bx2 - bx1) / div;
    }
    vias.push({
      position: { x, y },
      diameter: diameter > 0 ? diameter : 10,
      net,
      layers: []
      // through-hole (all layers)
    });
  }
  return vias;
}
function extractSurfaces(db, div, netAssignMap, subclassBase) {
  const out = [];
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 40) continue;
    const shape = blk;
    if (shape.layer.classCode !== LayerClass.ETCH) continue;
    if (pointsToFootprintDef(db, shape.ptr1)) continue;
    const polygon = walkSegmentChain(db, shape.firstSegmentPtr, div);
    if (polygon.length < 3) continue;
    out.push({
      polygon,
      net: netAssignMap.get(shape.ptr1) ?? "",
      layer: etchLayerIndex(shape.layer.subclass, subclassBase)
    });
  }
  return out;
}
function extractOutline(db, _ver, div) {
  let best = [];
  let bestScore = -1;
  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 40) continue;
    const shape = blk;
    const cc = shape.layer.classCode;
    const sc = shape.layer.subclass;
    const isBoundary = cc === LayerClass.BOUNDARY;
    const isBoardGeomOutline = (cc === LayerClass.BOARD_GEOMETRY || cc === LayerClass.DRAWING_FORMAT) && (sc === 234 || sc === 253);
    if (!isBoundary && !isBoardGeomOutline) continue;
    const pts = walkSegmentChain(db, shape.firstSegmentPtr, div);
    if (pts.length < 2) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const area = (maxX - minX) * (maxY - minY);
    const score = area * 10 + (sc === 234 ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = pts;
    }
  }
  return best;
}
function walkSegmentChain(db, headKey, div) {
  const points = [];
  let key = headKey;
  const MAX_ITER = 1e6;
  for (let i = 0; i < MAX_ITER && key !== 0; i++) {
    const seg = db.getBlock(key);
    if (!seg) break;
    if (seg.blockType === 21 || seg.blockType === 22 || seg.blockType === 23) {
      const s = seg;
      if (points.length === 0) {
        points.push({ x: s.startX / div, y: s.startY / div });
      }
      points.push({ x: s.endX / div, y: s.endY / div });
      key = s.next;
    } else if (seg.blockType === 1) {
      const arc = seg;
      const cx = arc.centerX / div;
      const cy = arc.centerY / div;
      const sx = arc.startX / div;
      const sy = arc.startY / div;
      const ex = arc.endX / div;
      const ey = arc.endY / div;
      const radius = arc.radius / div;
      if (points.length === 0) {
        points.push({ x: sx, y: sy });
      }
      if (radius > 0) {
        const startAngle = Math.atan2(sy - cy, sx - cx);
        const endAngle = Math.atan2(ey - cy, ex - cx);
        const clockwise = (arc.subType & 64) !== 0;
        let sweep;
        if (clockwise) {
          sweep = startAngle - endAngle;
          if (sweep <= 0) sweep += 2 * Math.PI;
        } else {
          sweep = endAngle - startAngle;
          if (sweep <= 0) sweep += 2 * Math.PI;
        }
        const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
        const dAngle = (clockwise ? -sweep : sweep) / steps;
        for (let j = 1; j <= steps; j++) {
          const angle = startAngle + dAngle * j;
          const nx = j === steps ? ex : cx + radius * Math.cos(angle);
          const ny = j === steps ? ey : cy + radius * Math.sin(angle);
          points.push({ x: nx, y: ny });
        }
      } else {
        points.push({ x: ex, y: ey });
      }
      key = arc.next;
    } else {
      break;
    }
  }
  return points;
}
function extractLayerNames(db) {
  const fromList = (layerList) => {
    const out = [];
    if (layerList.refEntries) {
      for (const e of layerList.refEntries) {
        const name = db.getString(e.layerNameId);
        if (name) out.push(name);
      }
    } else if (layerList.nonRefEntries) {
      for (const e of layerList.nonRefEntries) if (e.name) out.push(e.name);
    }
    return out;
  };
  const tryAt = (idx) => {
    if (idx < 0 || idx >= db.header.layerMap.length) return [];
    const ent = db.header.layerMap[idx];
    if (!ent || ent.layerList0x2A === 0) return [];
    const ll2 = db.getBlockAs(ent.layerList0x2A, 42);
    return ll2 ? fromList(ll2) : [];
  };
  const primary = tryAt(LayerClass.ETCH);
  if (primary.length > 0) return primary;
  const refCount = /* @__PURE__ */ new Map();
  for (const ent of db.header.layerMap) {
    if (ent.layerList0x2A === 0) continue;
    refCount.set(ent.layerList0x2A, (refCount.get(ent.layerList0x2A) ?? 0) + 1);
  }
  let bestKey = 0, bestN = 0;
  for (const [k, n] of refCount) if (n > bestN) {
    bestN = n;
    bestKey = k;
  }
  if (bestKey === 0) return [];
  const ll = db.getBlockAs(bestKey, 42);
  return ll ? fromList(ll) : [];
}

// api/board/parser/_boardripper/vendor/parsers/allegro/allegro-brd-parser.ts
function parseAllegroBRD(buffer) {
  const db = new AllegroDb(buffer);
  return assembleBoard(db);
}

// api/board/parser/_boardripper/bridge.ts
try {
  const bytes = (0, import_node_fs.readFileSync)(0);
  const data = parseAllegroBRD(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (bytes.length >= 4 && bytes.readUInt32LE(0) >>> 16 === 18) data.formatVersion = "15.x";
  process.stdout.write(JSON.stringify({ ...data, nets: [...data.nets.values()] }));
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error).slice(0, 2e3));
  process.exitCode = 1;
}
