// The forge's state: one token account, repositories with their git object
// stores, issues, pull requests, labels and comments. Everything in memory in
// this one process.
//
// Determinism: nothing here reads the wall clock or a random source. Ids are
// sequential counters and timestamps come from a logical clock (a fixed base
// epoch advanced by one second per stamped event), so replaying the same
// request sequence reproduces the same state byte-for-byte.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type CommitInfo,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';

export const CLOCK_BASE_EPOCH = 1_735_689_600; // 2025-01-01T00:00:00Z
export const ZERO_OID = '0000000000000000000000000000000000000000';

export interface CommentRec {
  id: number;
  body: string;
  createdSeq: number;
}

export interface IssueRec {
  kind: 'issue';
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
  createdEpoch: number;
}

export interface PullRec {
  kind: 'pull';
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string; // branch name
  baseRef: string; // branch name
  merged: boolean;
  mergedEpoch: number | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdEpoch: number;
}

export type NumberedRec = IssueRec | PullRec;

export interface RepoRec {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  parsedCommits: Map<string, CommitInfo>; // oid -> parsed commit (objects are immutable)
  refs: Map<string, string>; // full refname -> oid
  version: number; // bumped on any git-visible mutation; keys response caches
  labels: Map<string, { name: string; color: string }>;
  numbered: Map<number, NumberedRec>;
  nextNumber: number;
  commitSeq: Map<string, number>; // oid -> arrival order, for stable listings
  seqCounter: number;
  createdEpoch: number;
}

export class Store {
  /** The token account's login; bound by the first owner-named repo access. */
  login: string | null = null;
  repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextDbId = 1;
  private nextCommentId = 1;
  private clockTicks = 0;
  private isoCache = new Map<number, string>();
  seq = 0;

  /** Advance the logical clock and return the new epoch second. */
  tick(): number {
    this.clockTicks += 1;
    return CLOCK_BASE_EPOCH + this.clockTicks;
  }

  epochToIso(epoch: number): string {
    // Pure function of the epoch; the same few epochs recur constantly
    // (every record's created_at), so memoize instead of re-formatting.
    let iso = this.isoCache.get(epoch);
    if (iso === undefined) {
      iso = new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      this.isoCache.set(epoch, iso);
    }
    return iso;
  }

  nowIso(): string {
    return this.epochToIso(CLOCK_BASE_EPOCH + this.clockTicks);
  }

  allocDbId(): number {
    return this.nextDbId++;
  }

  allocCommentId(): number {
    return this.nextCommentId++;
  }

  createRepo(name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string } = {}): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId++,
      name,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      objects: new Map(),
      parsedCommits: new Map(),
      refs: new Map(),
      version: 0,
      labels: new Map(),
      numbered: new Map(),
      nextNumber: 1,
      commitSeq: new Map(),
      seqCounter: 0,
      createdEpoch: this.tick(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * Resolve a repo by name for an owner-named surface. Binds the account login
   * on first sight of an existing repo; after binding, other owners miss.
   */
  repoFor(owner: string, name: string): RepoRec | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (this.login === null) {
      this.login = owner;
      return repo;
    }
    return this.login === owner ? repo : null;
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
    return this.putHashed(repo, hashObject(type, data), type, data);
  }

  /** Insert an object whose oid the caller already computed (pack ingest). */
  putHashed(repo: RepoRec, oid: string, type: GitObject['type'], data: Buffer): string {
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.seqCounter += 1;
      repo.commitSeq.set(oid, repo.seqCounter);
      repo.version += 1;
    }
    return oid;
  }

  /** Mark a repo's git-visible state changed (ref moves without new objects). */
  touch(repo: RepoRec): void {
    repo.version += 1;
  }

  getObject(repo: RepoRec, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Follow tag objects to the commit they point at (or return the oid itself). */
  peelToCommit(repo: RepoRec, oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 16; depth++) {
      const obj = repo.objects.get(current);
      if (!obj) return current;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      return current;
    }
    return current;
  }

  commitInfo(repo: RepoRec, oid: string) {
    const cached = repo.parsedCommits.get(oid);
    if (cached) return cached;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    const info = parseCommit(obj.data);
    repo.parsedCommits.set(oid, info);
    return info;
  }

  /** Create a commit authored by the account holder, on the logical clock. */
  createCommit(
    repo: RepoRec,
    args: { tree: string; parents: string[]; message: string },
  ): string {
    const epoch = this.tick();
    const login = this.login ?? 'viewer';
    const ident = `${login} <${login}@forge.invalid> ${epoch} +0000`;
    const data = buildCommit({
      tree: args.tree,
      parents: args.parents,
      author: ident,
      committer: ident,
      message: args.message,
    });
    return this.putObject(repo, 'commit', data);
  }

  headRef(repo: RepoRec): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All commits reachable from `tip`, newest first (timestamp, then arrival). */
  listCommits(repo: RepoRec, tip: string): string[] {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const info = this.commitInfo(repo, oid);
      if (!info) continue;
      seen.add(oid);
      for (const parent of info.parents) stack.push(parent);
    }
    const withMeta = [...seen].map((oid) => {
      const info = this.commitInfo(repo, oid)!;
      const tsMatch = / (\d+) [+-]\d{4}$/.exec(info.committer);
      return { oid, ts: tsMatch ? Number(tsMatch[1]) : 0, seq: repo.commitSeq.get(oid) ?? 0 };
    });
    withMeta.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
    return withMeta.map((entry) => entry.oid);
  }

  isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const info = this.commitInfo(repo, oid);
      if (info) for (const parent of info.parents) stack.push(parent);
    }
    return false;
  }

  /** The best common ancestor of two commits (first found by BFS from b). */
  mergeBase(repo: RepoRec, a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop()!;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.add(oid);
      const info = this.commitInfo(repo, oid);
      if (info) for (const parent of info.parents) stackA.push(parent);
    }
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const info = this.commitInfo(repo, oid);
      if (info) for (const parent of info.parents) queue.push(parent);
    }
    return null;
  }

  // ------------------------------------------------------------ trees / files

  /** Flatten a tree (recursively) into path -> blob entry. */
  flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  treeOfCommit(repo: RepoRec, commitOid: string): string | null {
    const info = this.commitInfo(repo, commitOid);
    return info ? info.tree : null;
  }

  /** Look up one path inside a tree; returns the entry or null. */
  lookupPath(repo: RepoRec, treeOid: string, path: string): { oid: string; mode: string; type: 'blob' | 'tree' } | null {
    const parts = path.split('/').filter((part) => part.length > 0);
    let current = treeOid;
    for (let i = 0; i < parts.length; i++) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        return entry.mode === '40000'
          ? { oid: entry.oid, mode: entry.mode, type: 'tree' }
          : { oid: entry.oid, mode: entry.mode, type: 'blob' };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  listDir(repo: RepoRec, treeOid: string, path: string): TreeEntry[] | null {
    if (path === '' || path === '/') {
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return null;
      return parseTree(obj.data);
    }
    const found = this.lookupPath(repo, treeOid, path);
    if (!found || found.type !== 'tree') return null;
    const obj = repo.objects.get(found.oid);
    if (!obj || obj.type !== 'tree') return null;
    return parseTree(obj.data);
  }

  /**
   * Return a new tree oid with `path` set to the given blob oid (or removed
   * when blobOid is null), creating intermediate trees as needed.
   */
  updateTreePath(repo: RepoRec, treeOid: string | null, path: string, blobOid: string | null, mode = '100644'): string {
    const parts = path.split('/').filter((part) => part.length > 0);
    const build = (currentOid: string | null, depth: number): string => {
      const entries: TreeEntry[] = currentOid
        ? parseTree(repo.objects.get(currentOid)?.data ?? Buffer.alloc(0)).map((entry) => ({ ...entry }))
        : [];
      const name = parts[depth]!;
      const index = entries.findIndex((entry) => entry.name === name);
      if (depth === parts.length - 1) {
        if (blobOid === null) {
          if (index >= 0) entries.splice(index, 1);
        } else if (index >= 0) {
          entries[index] = { mode, name, oid: blobOid };
        } else {
          entries.push({ mode, name, oid: blobOid });
        }
      } else {
        const childOid = index >= 0 && entries[index]!.mode === '40000' ? entries[index]!.oid : null;
        const newChild = build(childOid, depth + 1);
        if (index >= 0) entries[index] = { mode: '40000', name, oid: newChild };
        else entries.push({ mode: '40000', name, oid: newChild });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(treeOid, 0);
  }

  /** Build a tree object from a flattened path -> blob map. */
  treeFromFlat(repo: RepoRec, flat: Map<string, { oid: string; mode: string }>): string {
    let root = this.putObject(repo, 'tree', buildTree([]));
    // Insert shallow paths first so intermediate trees accumulate correctly.
    const paths = [...flat.keys()].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
    for (const path of paths) {
      const entry = flat.get(path)!;
      root = this.updateTreePath(repo, root, path, entry.oid, entry.mode);
    }
    return root;
  }
}
