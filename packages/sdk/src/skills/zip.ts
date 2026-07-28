import { inflateRawSync } from 'node:zlib';

import { DagentError } from '../errors.js';

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectorySignature = 0x02014b50;
const localFileSignature = 0x04034b50;
const maxArchiveEntries = 256;
const maxArchiveBytes = 10 * 1024 * 1024;

export type ZipEntry = {
  readonly path: string;
  readonly content: Uint8Array;
};

export function readZipArchive(input: Uint8Array): readonly ZipEntry[] {
  const bytes = Buffer.from(input);
  const endOffset = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const directorySize = bytes.readUInt32LE(endOffset + 12);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    entryCount > maxArchiveEntries ||
    directoryOffset + directorySize > bytes.length ||
    directoryOffset + directorySize > endOffset
  ) {
    throw invalidArchive('ZIP central directory is invalid or exceeds package limits.');
  }

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== centralDirectorySignature) {
      throw invalidArchive('ZIP central directory entry is invalid.');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > bytes.length || (flags & 0x1) !== 0) {
      throw invalidArchive('Encrypted or truncated ZIP entries are not supported.');
    }
    const path = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength), flags);
    offset = nextOffset;
    if (path.endsWith('/')) continue;
    assertSafeArchivePath(path);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) {
      throw invalidArchive(`ZIP entry '${path}' is a symbolic link.`);
    }
    if (compression !== 0 && compression !== 8) {
      throw invalidArchive(
        `ZIP entry '${path}' uses unsupported compression method ${compression}.`,
      );
    }
    totalBytes += uncompressedSize;
    if (uncompressedSize > maxArchiveBytes || totalBytes > maxArchiveBytes) {
      throw invalidArchive('ZIP package exceeds the uncompressed size limit.');
    }
    const compressed = localEntryContent(bytes, localOffset, compressedSize, path);
    const content = compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (content.length !== uncompressedSize || crc32(content) !== expectedCrc) {
      throw invalidArchive(`ZIP entry '${path}' failed its size or CRC check.`);
    }
    entries.push({ path, content });
  }
  return entries;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === endOfCentralDirectorySignature) {
      const disk = bytes.readUInt16LE(offset + 4);
      const directoryDisk = bytes.readUInt16LE(offset + 6);
      const diskEntries = bytes.readUInt16LE(offset + 8);
      const entries = bytes.readUInt16LE(offset + 10);
      if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entries) {
        throw invalidArchive('Multi-disk and ZIP64 packages are not supported.');
      }
      return offset;
    }
  }
  throw invalidArchive('Input is not a valid ZIP package.');
}

function localEntryContent(bytes: Buffer, offset: number, size: number, path: string): Buffer {
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== localFileSignature) {
    throw invalidArchive(`ZIP entry '${path}' has an invalid local header.`);
  }
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + size;
  if (end > bytes.length) throw invalidArchive(`ZIP entry '${path}' is truncated.`);
  return bytes.subarray(start, end);
}

function decodeName(bytes: Buffer, flags: number): string {
  if ((flags & 0x800) === 0) {
    for (const byte of bytes) {
      if (byte > 0x7f) {
        throw invalidArchive('Non-UTF-8 ZIP entry names are not supported.');
      }
    }
  }
  return bytes.toString('utf8').replaceAll('\\', '/');
}

function assertSafeArchivePath(path: string): void {
  const segments = path.split('/');
  if (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw invalidArchive(`ZIP entry '${path}' is not a safe relative path.`);
  }
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  crcTable ??= createCrcTable();
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function invalidArchive(message: string): DagentError {
  return new DagentError('INVALID_INPUT', message);
}
