// Git smart-HTTP: info/refs advertisements (protocol v0 and v2), ls-refs,
// fetch (upload-pack, with shallow support) and receive-pack with
// report-status. Objects live in the repo's in-memory store; packs are built
// as plain (undeltified) objects, which the protocol happily accepts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  buildPack,
  hashObject,
  parseCommit as parseCommitImpl,
  parseTag,
  parseTree as parseTreeImpl,
  pktLine,
  readPack,
  readPktLines,
  type GitObject,
} from './gitobj.ts';
import { Store, type RepoRec } from './store.ts';

export interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
  query: URLSearchParams;
  token: string;
  requestId: string;
}

const AGENT = 'forge/1.0';
const ZERO = ZERO_OID;

export function sendJson(ctx: Ctx, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  });
  ctx.res.end(body);
}

export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

export function parseJsonBody(ctx: Ctx): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function send(ctx: Ctx, status: number, contentType: string, body: Buffer): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': ctx.requestId,
    'cache-control': 'no-cache',
  });
  ctx.res.end(body);
}

function send404(ctx: Ctx): void {
  send(ctx, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n'));
}

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peeledOf(repo: RepoRec, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

// ------------------------------------------------------------ advertisements

// Response caches for the read-only git endpoints. Keys carry the repo id
// and its mutation version, so a cached answer is only ever served for the
// exact store state it was computed from.
const responseCache = new Map<string, Buffer>();
function cached(key: string): Buffer | null {
  return responseCache.get(key) ?? null;
}
function cachePut(key: string, body: Buffer): void {
  if (responseCache.size > 256) responseCache.clear();
  responseCache.set(key, body);
}

function v0Advertisement(ctx: Ctx, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const cacheKey = `adv|${repo.id}|${repo.version}|${service}`;
  const hit = cached(cacheKey);
  if (hit) {
    send(ctx, 200, `application/x-${service}-advertisement`, hit);
    return;
  }
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTarget = repo.refs.get(ctx.store.headRef(repo));
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO} capabilities^{}`);
  } else {
    if (headTarget) lines.push(`${headTarget} HEAD`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}`);
      const peeled = peeledOf(repo, oid);
      if (peeled) lines.push(`${peeled} ${name}^{}`);
    }
  }
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  cachePut(cacheKey, body);
  send(ctx, 200, `application/x-${service}-advertisement`, body);
}

function v2Advertisement(ctx: Ctx): void {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  send(ctx, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
}

export function handleInfoRefs(ctx: Ctx, repo: RepoRec, service: string | null): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    send(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('unknown service\n'));
    return;
  }
  const protocol = (ctx.req.headers['git-protocol'] as string | undefined) ?? '';
  if (service === 'git-upload-pack' && /version=2/.test(protocol)) {
    v2Advertisement(ctx);
    return;
  }
  // Receive-pack always answers in v0 form; this client speaks v0 push.
  v0Advertisement(ctx, repo, service);
}

// ------------------------------------------------------------ object closure

/** Walk commit ancestry from the tips; stopAt commits are included but their parents are not walked. */
function collectCommits(store: Store, repo: RepoRec, tips: string[], stopAt: Set<string>): Set<string> {
  const commits = new Set<string>();
  const stack = tips.map((tip) => store.peelToCommit(repo, tip));
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (commits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    commits.add(oid);
    if (stopAt.has(oid)) continue;
    const info = store.commitInfo(repo, oid);
    if (info) for (const parent of info.parents) stack.push(parent);
  }
  return commits;
}

/** The full object closure of an explicit commit set: those commits, their trees and blobs, plus any extra tip objects (tags). */
function closureOfCommitSet(repo: RepoRec, commits: Set<string>, extraTips: string[] = []): Set<string> {
  const out = new Set<string>();
  const visitObject = (oid: string): void => {
    if (out.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTreeImpl(obj.data)) visitObject(entry.oid);
    } else if (obj.type === 'tag') {
      visitObject(parseTag(obj.data).object);
    } else if (obj.type === 'commit') {
      const info = parseCommitImpl(obj.data);
      visitObject(info.tree);
    }
  };
  for (const oid of commits) visitObject(oid);
  for (const oid of extraTips) visitObject(oid);
  return out;
}

/** BFS distances of commits from the wants (want = distance 0), not expanding past `limit`. */
function commitDistances(store: Store, repo: RepoRec, wants: string[], limit: number): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = store.peelToCommit(repo, want);
    if (!dist.has(commit)) {
      dist.set(commit, 0);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const d = dist.get(oid)!;
    if (d >= limit) continue;
    const info = store.commitInfo(repo, oid);
    if (!info) continue;
    for (const parent of info.parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  return dist;
}

interface FetchPlan {
  packOids: string[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(
  store: Store,
  repo: RepoRec,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // What the client already holds: closure of its haves, never descending
  // past a commit the client itself lists as shallow.
  const haveCommits = collectCommits(store, repo, haves.filter((oid) => repo.objects.has(oid)), shallowSet);
  const haveSet = closureOfCommitSet(repo, haveCommits);

  let includedCommits: Set<string>;
  let boundary: string[] = [];
  if (depth !== null) {
    const dist = commitDistances(store, repo, wants, depth - 1);
    includedCommits = new Set([...dist.entries()].filter(([, d]) => d < depth).map(([oid]) => oid));
    boundary = [...includedCommits].filter((oid) => {
      if (dist.get(oid) !== depth - 1) return false;
      const info = store.commitInfo(repo, oid);
      return info !== null && info.parents.length > 0;
    });
  } else {
    // Full history, but a shallow client's boundary is honoured: do not
    // descend past commits it already holds shallow.
    includedCommits = collectCommits(store, repo, wants, shallowSet);
  }

  const tagWants = wants.filter((oid) => repo.objects.get(oid)?.type === 'tag');
  const wantSet = closureOfCommitSet(repo, includedCommits, tagWants);
  const packOids = [...wantSet].filter((oid) => !haveSet.has(oid));
  // Deterministic pack order: commits, trees, blobs, tags — stable within kind.
  const rank = (oid: string): number => {
    const type = repo.objects.get(oid)?.type;
    return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3;
  };
  packOids.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const unshallow = clientShallow.filter((oid) => includedCommits.has(oid) && !boundary.includes(oid));
  return { packOids, shallow: boundary, unshallow };
}

const packCache = new Map<string, Buffer>();
function buildPackCached(repo: RepoRec, packOids: string[]): Buffer {
  const key = hashObject('blob', Buffer.from(packOids.join(',')));
  const cached = packCache.get(key);
  if (cached) return cached;
  const objects: { oid: string; type: GitObject['type']; data: Buffer }[] = [];
  for (const oid of packOids) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push({ oid, type: obj.type, data: obj.data });
  }
  const pack = buildPack(objects);
  if (packCache.size > 16) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  return parts;
}

// ------------------------------------------------------------ ls-refs (v2)

function handleLsRefs(ctx: Ctx, repo: RepoRec, args: string[]): void {
  const cacheKey = `ls|${repo.id}|${repo.version}|${args.join('|')}`;
  const hit = cached(cacheKey);
  if (hit) {
    send(ctx, 200, 'application/x-git-upload-pack-result', hit);
    return;
  }
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = ctx.store.headRef(repo);
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  cachePut(cacheKey, body);
  send(ctx, 200, 'application/x-git-upload-pack-result', body);
}

// ------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  if (args.depth !== null && (!Number.isFinite(args.depth) || args.depth < 1)) args.depth = null;
  return args;
}

function fetchResponse(ctx: Ctx, repo: RepoRec, args: FetchArgs, v2: boolean): void {
  const cacheKey = `fetch|${repo.id}|${repo.version}|${v2 ? '2' : '0'}|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
  const hit = cached(cacheKey);
  if (hit) {
    send(ctx, 200, 'application/x-git-upload-pack-result', hit);
    return;
  }
  const plan = planFetch(ctx.store, repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = buildPackCached(repo, plan.packOids);
  const parts: Buffer[] = [];
  const shallowInvolved = args.depth !== null || args.shallow.length > 0;
  if (v2) {
    if (args.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      const acked = args.haves.filter((oid) => repo.objects.has(oid));
      if (acked.length === 0) parts.push(pktLine('NAK\n'));
      else for (const oid of acked) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    if (shallowInvolved) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(PKT_FLUSH);
  } else {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    const acked = args.haves.find((oid) => repo.objects.has(oid));
    parts.push(pktLine(acked ? `ACK ${acked}\n` : 'NAK\n'));
    parts.push(...sidebandPack(pack));
    parts.push(PKT_FLUSH);
  }
  const body = Buffer.concat(parts);
  cachePut(cacheKey, body);
  send(ctx, 200, 'application/x-git-upload-pack-result', body);
}

export function handleUploadPack(ctx: Ctx, repo: RepoRec): void {
  const body = ctx.body;
  const protocol = (ctx.req.headers['git-protocol'] as string | undefined) ?? '';
  const isV2 = /version=2/.test(protocol);
  const { frames } = readPktLines(body);
  const lines: string[] = [];
  for (const frame of frames) {
    if (frame.kind === 'data') lines.push(frame.data.toString('utf8').replace(/\n$/, ''));
  }
  if (isV2) {
    const commandLine = lines.find((line) => line.startsWith('command='));
    if (!commandLine) {
      send(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('missing command\n'));
      return;
    }
    const command = commandLine.slice('command='.length);
    const argLines = lines.slice(lines.indexOf(commandLine) + 1).filter((line) => !line.startsWith('agent=') && !line.startsWith('object-format='));
    if (command === 'ls-refs') {
      handleLsRefs(ctx, repo, argLines);
      return;
    }
    if (command === 'fetch') {
      fetchResponse(ctx, repo, parseFetchArgs(argLines), true);
      return;
    }
    send(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('unknown command\n'));
    return;
  }
  // Protocol v0: want lines, flush, have lines, done, flush.
  if (lines.length === 0 || !lines[0]!.startsWith('want ')) {
    send(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('expected want lines\n'));
    return;
  }
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') args.done = true;
  }
  if (args.depth !== null && (!Number.isFinite(args.depth) || args.depth < 1)) args.depth = null;
  fetchResponse(ctx, repo, args, false);
}

// ------------------------------------------------------------ receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(ctx: Ctx, repo: RepoRec): Promise<void> {
  const body = ctx.body;
  const { frames, next } = readPktLines(body);
  const commands: RefCommand[] = [];
  let caps = '';
  let sawFlush = false;
  for (const frame of frames) {
    if (frame.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (frame.kind !== 'data') continue;
    let text = frame.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length === 3) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }
  if (!sawFlush && commands.length === 0) {
    send(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('malformed receive-pack request\n'));
    return;
  }
  const packBytes = body.subarray(next);
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes);
      for (const [oid, obj] of objects) {
        ctx.store.putHashed(repo, oid, obj.type, obj.data);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO;
    const isDelete = command.newOid === ZERO;
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (isDelete) {
      if (current === ZERO) {
        results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
      } else if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'stale ref' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({
        ref: command.ref,
        ok: false,
        reason: current === ZERO ? 'reference already exists' : 'non-fast-forward',
      });
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && current !== ZERO) {
      const newCommit = ctx.store.peelToCommit(repo, command.newOid);
      if (!ctx.store.isAncestor(repo, current, newCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  if (results.some((result) => result.ok)) ctx.store.touch(repo);

  const wantReport = caps.includes('report-status');
  const wantSideband = caps.includes('side-band-64k');
  if (!wantReport) {
    send(ctx, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportParts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError || 'failed'}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (wantSideband) {
    const chunks: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + CHUNK))])));
    }
    send(ctx, 200, 'application/x-git-receive-pack-result', Buffer.concat(chunks));
  } else {
    send(ctx, 200, 'application/x-git-receive-pack-result', report);
  }
}

export async function handleGitRoute(
  ctx: Ctx,
  owner: string,
  repoName: string,
  suffix: string,
): Promise<boolean> {
  const repo = ctx.store.repoFor(owner, repoName);
  if (!repo) {
    send404(ctx);
    return true;
  }
  if (suffix === '/info/refs' && ctx.req.method === 'GET') {
    handleInfoRefs(ctx, repo, ctx.query.get('service'));
    return true;
  }
  if (suffix === '/git-upload-pack' && ctx.req.method === 'POST') {
    handleUploadPack(ctx, repo);
    return true;
  }
  if (suffix === '/git-receive-pack' && ctx.req.method === 'POST') {
    await handleReceivePack(ctx, repo);
    return true;
  }
  send404(ctx);
  return true;
}
