// Reading a file that is still being appended to, without reading it whole
// every time: a byte offset says how far the caller got, and only what came
// after it is returned. Split out of resolvedIds.js when a second caller
// (agentTranscript.js) needed the identical reading.
import fs from 'node:fs';

// One megabyte per read: enough that a first pass over a multi-megabyte
// transcript takes a handful of reads, small enough that neither the peak
// nor the blocked event loop is noticeable.
const CHUNK_BYTES = 1024 * 1024;

export function readAppendedLines(filePath, offset) {
  const size = fs.statSync(filePath).size;
  // A transcript only ever grows, so a shorter file is a different file
  // under the same path - reading it from the old offset would never find
  // anything again.
  let at = offset > size ? 0 : offset;
  if (at >= size) return { text: '', offset: at };

  const fd = fs.openSync(filePath, 'r');
  // Buffers rather than strings for the boundary arithmetic: a chunk border
  // falls inside a multi-byte character often enough, and decoding the
  // halves separately would corrupt exactly the line that matters.
  const complete = [];
  let carry = Buffer.alloc(0);
  try {
    while (at < size) {
      const want = Math.min(CHUNK_BYTES, size - at);
      const buffer = Buffer.alloc(want);
      const read = fs.readSync(fd, buffer, 0, want, at);
      if (read <= 0) break;
      at += read;
      const block = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
      const lastNewline = block.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        carry = Buffer.from(block);
        continue;
      }
      complete.push(block.subarray(0, lastNewline + 1));
      carry = Buffer.from(block.subarray(lastNewline + 1));
    }
  } finally {
    fs.closeSync(fd);
  }
  // The file regularly ends mid-line while Claude Code appends. That line
  // stays unread: winding the offset back is what makes the next call see
  // it whole.
  return { text: Buffer.concat(complete).toString('utf8'), offset: at - carry.length };
}
