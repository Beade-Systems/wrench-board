// Wrench Board Node entry point. BoardRipper sources are vendored unchanged.
import { readFileSync } from 'node:fs';
import { parseAllegroBRD } from './vendor/parsers/allegro/allegro-brd-parser';
try {
  const bytes = readFileSync(0);
  const data = parseAllegroBRD(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (bytes.length >= 4 && (bytes.readUInt32LE(0) >>> 16) === 0x12) data.formatVersion = '15.x';
  process.stdout.write(JSON.stringify({ ...data, nets: [...data.nets.values()] }));
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error).slice(0, 2000));
  process.exitCode = 1;
}
