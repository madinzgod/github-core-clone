// Pure git object-model primitives: hashing, tree/commit/tag codecs, packfile
// read/write and the pkt-line framing the smart-HTTP protocol speaks.
// Node standard library only; no state lives here.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';

export type GitObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const TYPE_TO_NUM: Record<GitObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_TO_TYPE: Record<number, GitObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // e.g. '100644', '100755', '120000', '40000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('utf8', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // Git orders tree entries by name, with directories compared as name + '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string; // full ident line value: "Name <email> ts +0000"
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = ZERO_OID;
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n`;
  return Buffer.from(`${head}\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const info: TagInfo = { object: ZERO_OID, type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Parse an ident line value ("Name <email> 1700000000 +0000") into its parts. */
export function parseIdent(ident: string): { name: string; email: string; timestamp: number } {
  const lt = ident.indexOf('<');
  const gt = ident.indexOf('>', lt + 1);
  const name = lt === -1 ? ident.trim() : ident.slice(0, lt).trim();
  const email = lt === -1 || gt === -1 ? '' : ident.slice(lt + 1, gt);
  const rest = gt === -1 ? '' : ident.slice(gt + 1).trim();
  const ts = Number.parseInt(rest.split(' ')[0] ?? '', 10);
  return { name, email, timestamp: Number.isFinite(ts) ? ts : 0 };
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const prefix = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktFrame {
  kind: 'data' | 'flush' | 'delim';
  data: Buffer;
}

/** Split a buffer into pkt-line frames; returns the frames and bytes consumed. */
export function readPktLines(buf: Buffer, start = 0): { frames: PktFrame[]; next: number } {
  const frames: PktFrame[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const hex = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = Number.parseInt(hex, 16);
    if (len === 0) {
      frames.push({ kind: 'flush', data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 1) {
      frames.push({ kind: 'delim', data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2 || len === 3) break; // response-end / error markers: not expected here
    if (pos + len > buf.length) break;
    frames.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { frames, next: pos };
}

// ---------------------------------------------------------------- packfiles

export function buildPack(objects: { oid: string; type: GitObjType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    parts.push(encodePackEntryHeader(TYPE_TO_NUM[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function encodePackEntryHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++]!;
      if (op & 0x02) offset += delta[pos++]! * 256;
      if (op & 0x04) offset += delta[pos++]! * 65536;
      if (op & 0x08) offset += delta[pos++]! * 16777216;
      if (op & 0x10) size = delta[pos++]!;
      if (op & 0x20) size += delta[pos++]! * 256;
      if (op & 0x40) size += delta[pos++]! * 65536;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== dstSize || result.length !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  count: number;
}

/** Inflate the first zlib stream in `buf`; reports the compressed bytes consumed. */
function inflateOne(buf: Buffer): Promise<{ raw: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      const consumed = (stream as unknown as { bytesWritten?: number }).bytesWritten;
      if (typeof consumed !== 'number' || consumed <= 0) {
        reject(new Error('inflate did not report consumed bytes'));
        return;
      }
      resolve({ raw: Buffer.concat(chunks), consumed });
    });
    stream.end(buf);
  });
}

/** Parse a whole packfile (as received by receive-pack). Throws on malformed input. */
export async function readPack(pack: Buffer): Promise<PackReadResult> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Verify the trailing checksum over everything before it.
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  const byOid = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let pos = 12;
  const end = pack.length - 20;

  for (let i = 0; i < count; i++) {
    const entryStart = pos;
    let byte = pack[pos++]!;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeNum === 6) {
      // OFS_DELTA: negative offset encoded as a varint with the +1 twist.
      let b = pack[pos++]!;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos++]!;
        offset = (offset + 1) * 128 + (b & 0x7f);
      }
      baseOffset = entryStart - offset;
    } else if (typeNum === 7) {
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const { raw, consumed } = await inflateOne(pack.subarray(pos, end));
    if (raw.length !== size) throw new Error('pack entry size mismatch');
    pos += consumed;
    if (typeNum >= 1 && typeNum <= 4) {
      const obj: GitObject = { type: NUM_TO_TYPE[typeNum]!, data: raw };
      const oid = hashObject(obj.type, obj.data);
      byOid.set(oid, obj);
      byOffset.set(entryStart, obj);
    } else if (typeNum === 6 || typeNum === 7) {
      const base = typeNum === 6 ? byOffset.get(baseOffset) : byOid.get(baseOid!);
      if (!base) throw new Error('delta base not in pack');
      const resolved: GitObject = { type: base.type, data: applyDelta(base.data, raw) };
      const oid = hashObject(resolved.type, resolved.data);
      byOid.set(oid, resolved);
      byOffset.set(entryStart, resolved);
    } else {
      throw new Error(`unknown pack object type ${typeNum}`);
    }
  }
  return { objects: byOid, count };
}
