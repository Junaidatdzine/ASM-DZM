import { createHash } from 'node:crypto';
import { AppError } from '../errors';

export function md5hex(data: Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

export interface ParsedImage {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}

/**
 * Read dimensions straight from the header bytes (PNG IHDR / JPEG SOF) —
 * no image decoding library needed.
 */
export function parseImageHeader(buf: Buffer): ParsedImage {
  // PNG: 8-byte signature, then IHDR chunk: length(4) 'IHDR'(4) width(4) height(4)
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan markers for SOF0/1/2 (0xC0/0xC1/0xC2)
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1]!;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return {
          format: 'jpeg',
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      const len = buf.readUInt16BE(offset + 2);
      offset += 2 + len;
    }
  }
  throw new AppError('invalid-argument', 'Only PNG and JPEG images are supported.');
}
