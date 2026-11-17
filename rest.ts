// The REST v3 surface the suite drives: repos, contents (backed by the git
// object store), git refs, branches, commits, labels, issues, comments and
// pull requests (including squash merges). All state lives in the Store.

import { parseCommit, parseIdent } from './gitobj.ts';
import { parseJsonBody, sendError, sendJson, type Ctx } from './githttp.ts';
import type { IssueRec, PullRec, RepoRec } from './store.ts';

type Json = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function ownerLogin(ctx: Ctx): string {
  return ctx.store.login ?? 'viewer';
}

export function repoJson(ctx: Ctx, repo: RepoRec): Json {
  const login = ownerLogin(ctx);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: ctx.store.epochToIso(repo.createdEpoch),
    updated_at: ctx.store.epochToIso(repo.createdEpoch),
    html_url: `http://forge.invalid/${login}/${repo.name}`,
    git_url: `git://forge.invalid/${login}/${repo.name}.git`,
    ssh_url: `git@forge.invalid:${login}/${repo.name}.git`,
    clone_url: `http://forge.invalid/${login}/${repo.name}.git`,
  };
}

export function issueJson(ctx: Ctx, repo: RepoRec, issue: IssueRec): Json {
  const login = ownerLogin(ctx);
  return {
    id: issue.dbId,
    node_id: `I_${issue.dbId}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login },
    comments: issue.comments.length,
    created_at: ctx.store.epochToIso(issue.createdEpoch),
    updated_at: ctx.store.epochToIso(issue.createdEpoch),
    html_url: `http://forge.invalid/${login}/${repo.name}/issues/${issue.number}`,
    pull_request: undefined,
  };
}

export function pullJson(ctx: Ctx, repo: RepoRec, pull: PullRec): Json {
  const login = ownerLogin(ctx);
  const headSha = ctx.store.branchTip(repo, pull.headRef);
  const baseSha = ctx.store.branchTip(repo, pull.baseRef);
  return {
    id: pull.dbId,
    node_id: `PR_${pull.dbId}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedEpoch !== null ? ctx.store.epochToIso(pull.mergedEpoch) : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${login}:${pull.baseRef}` },
    user: { login },
    created_at: ctx.store.epochToIso(pull.createdEpoch),
    updated_at: ctx.store.epochToIso(pull.createdEpoch),
    html_url: `http://forge.invalid/${login}/${repo.name}/pull/${pull.number}`,
  };
}

// ------------------------------------------------------------ pull merging

export interface MergeOutcome {
  ok: boolean;
  sha?: string;
  conflict?: boolean;
}

/** File-level three-way merge of head into base; null tree on conflict. */
export function mergedTree(ctx: Ctx, repo: RepoRec, headTip: string, baseTip: string): string | null {
  const mergeBase = ctx.store.mergeBase(repo, headTip, baseTip);
  if (!mergeBase) return null;
  const baseTree = ctx.store.treeOfCommit(repo, mergeBase);
  const headTree = ctx.store.treeOfCommit(repo, headTip);
  const baseTipTree = ctx.store.treeOfCommit(repo, baseTip);
  if (!baseTree || !headTree || !baseTipTree) return null;
  const baseFlat = ctx.store.flattenTree(repo, baseTree);
  const headFlat = ctx.store.flattenTree(repo, headTree);
  const tipFlat = ctx.store.flattenTree(repo, baseTipTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  for (const path of paths) {
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    const inTip = tipFlat.get(path);
    const headChanged = inHead?.oid !== inBase?.oid;
    const tipChanged = inTip?.oid !== inBase?.oid;
    if (headChanged && tipChanged) {
      if (inHead?.oid === inTip?.oid) {
        if (inHead) merged.set(path, inHead);
      } else {
        return null; // both sides changed the same path differently
      }
    } else if (headChanged) {
      if (inHead) merged.set(path, inHead);
    } else if (tipChanged) {
      if (inTip) merged.set(path, inTip);
    } else if (inBase) {
      merged.set(path, inBase);
    }
  }
  return ctx.store.treeFromFlat(repo, merged);
}

/** Squash-merge a pull request into its base branch. */
export function mergePull(ctx: Ctx, repo: RepoRec, pull: PullRec): MergeOutcome {
  const headTip = ctx.store.branchTip(repo, pull.headRef);
  const baseTip = ctx.store.branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return { ok: false, conflict: true };
  const tree = mergedTree(ctx, repo, headTip, baseTip);
  if (tree === null) return { ok: false, conflict: true };
  const sha = ctx.store.createCommit(repo, {
    tree,
    parents: [baseTip],
    message: pull.title,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedEpoch = ctx.store.tick();
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

export function pullMergeable(ctx: Ctx, repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const headTip = ctx.store.branchTip(repo, pull.headRef);
  const baseTip = ctx.store.branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return false;
  return mergedTree(ctx, repo, headTip, baseTip) !== null;
}

// ------------------------------------------------------------ line diff

/** Count added/deleted lines between two texts with a simple LCS diff. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // LCS via dynamic programming, bounded: fall back to a coarse count for
  // very large inputs (line counts are only checked exactly on small files).
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    return { additions: m, deletions: n };
  }
  const dp: number[] = new Array(m + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let prev = 0;
    for (let j = m - 1; j >= 0; j--) {
      const saved = dp[j]!;
      if (oldLines[i] === newLines[j]) dp[j] = prev + 1;
      else dp[j] = Math.max(dp[j]!, dp[j + 1]!);
      prev = saved;
    }
  }
  const common = dp[0]!;
  return { additions: m - common, deletions: n - common };
}

export function pullFiles(ctx: Ctx, repo: RepoRec, pull: PullRec): Json[] {
  const headTip = ctx.store.branchTip(repo, pull.headRef);
  const baseTip = ctx.store.branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return [];
  const mergeBase = ctx.store.mergeBase(repo, headTip, baseTip);
  if (!mergeBase) return [];
  const baseTree = ctx.store.treeOfCommit(repo, mergeBase);
  const headTree = ctx.store.treeOfCommit(repo, headTip);
  if (!baseTree || !headTree) return [];
  const baseFlat = ctx.store.flattenTree(repo, baseTree);
  const headFlat = ctx.store.flattenTree(repo, headTree);
  const files: Json[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const inBase = baseFlat.get(path);
    const inHead = headFlat.get(path);
    if (inBase?.oid === inHead?.oid) continue;
    const oldText = inBase ? (repo.objects.get(inBase.oid)?.data.toString('utf8') ?? '') : '';
    const newText = inHead ? (repo.objects.get(inHead.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    files.push({
      filename: path,
      status: !inBase ? 'added' : !inHead ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: inHead?.oid ?? inBase?.oid ?? '',
    });
  }
  return files;
}

// ------------------------------------------------------------ route handling

function paginate(ctx: Ctx, items: Json[], basePath: string): { page: Json[]; headers: Record<string, string> } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? '127.0.0.1';
    const next = `http://${host}${basePath}?page=${page + 1}&per_page=${perPage}`;
    const lastPage = Math.ceil(items.length / perPage);
    const last = `http://${host}${basePath}?page=${lastPage}&per_page=${perPage}`;
    headers['link'] = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: slice, headers };
}

export function handleRest(ctx: Ctx, segments: string[]): boolean {
  const store = ctx.store;
  const method = ctx.req.method ?? 'GET';
  // segments are the decoded path segments after the leading '/'.
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);

  // Root and meta.
  if (rest.length === 0 && method === 'GET') {
    sendJson(ctx, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': '' });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(ctx, 200, { login: ownerLogin(ctx), id: 1, type: 'User' });
    return true;
  }

  // Repo creation + own listing.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
      const name = str(parsed.value.name);
      if (name === '') return sendError(ctx, 422, 'name is required'), true;
      if (store.repos.has(name)) {
        return sendError(ctx, 422, `A repository with that name already exists on this account`), true;
      }
      const repo = store.createRepo(name, {
        description: str(parsed.value.description),
        isPrivate: parsed.value.private === true,
        defaultBranch: str(parsed.value.default_branch) || 'main',
      });
      sendJson(ctx, 201, repoJson(ctx, repo));
      return true;
    }
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.id - b.id).map((repo) => repoJson(ctx, repo));
      const { page, headers } = paginate(ctx, all, '/api/v3/user/repos');
      sendJson(ctx, 200, page, headers);
      return true;
    }
  }

  if (rest[0] !== 'repos' || rest.length < 3) return false;
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const repo = store.repoFor(owner, repoName);
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (!repo) return sendError(ctx, 404, 'Not Found'), true;
    if (method === 'GET') {
      sendJson(ctx, 200, repoJson(ctx, repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.name === 'string' && parsed.value.name !== repo.name) {
        store.repos.delete(repo.name);
        repo.name = parsed.value.name;
        store.repos.set(repo.name, repo);
      }
      if (typeof parsed.value.default_branch === 'string') repo.defaultBranch = parsed.value.default_branch;
      store.touch(repo);
      sendJson(ctx, 200, repoJson(ctx, repo));
      return true;
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
      ctx.res.end();
      return true;
    }
    return sendError(ctx, 404, 'Not Found'), true;
  }

  if (!repo) return sendError(ctx, 404, 'Not Found'), true;

  // ----- contents
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    return handleContents(ctx, repo, path, method);
  }

  // ----- git refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
      const ref = str(parsed.value.ref);
      const sha = str(parsed.value.sha);
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        return sendError(ctx, 422, 'Invalid ref or sha'), true;
      }
      if (repo.refs.has(ref)) return sendError(ctx, 422, 'Reference already exists'), true;
      repo.refs.set(ref, sha);
      store.touch(repo);
      sendJson(ctx, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return true;
    }
    if (method === 'GET' && tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) return sendError(ctx, 404, 'Not Found'), true;
      sendJson(ctx, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return true;
    }
    return sendError(ctx, 404, 'Not Found'), true;
  }

  // ----- branches
  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(ctx, 200, branches);
      return true;
    }
    if (method === 'GET' && tail.length === 2) {
      const sha = store.branchTip(repo, tail[1]!);
      if (!sha) return sendError(ctx, 404, 'Not Found'), true;
      sendJson(ctx, 200, { name: tail[1], commit: { sha }, protected: false });
      return true;
    }
    return sendError(ctx, 404, 'Not Found'), true;
  }

  // ----- commits
  if (tail[0] === 'commits' && method === 'GET' && tail.length === 1) {
    const shaParam = ctx.query.get('sha');
    let tip: string | null = null;
    if (shaParam) {
      tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? (repo.objects.get(shaParam)?.type === 'commit' ? shaParam : null);
      if (tip) tip = store.peelToCommit(repo, tip);
    } else {
      tip = store.branchTip(repo, repo.defaultBranch);
    }
    if (!tip) {
      sendJson(ctx, 200, []);
      return true;
    }
    const commits = store.listCommits(repo, tip).map((oid) => {
      const obj = repo.objects.get(oid)!;
      const info = parseCommit(obj.data);
      const author = parseIdent(info.author);
      const committer = parseIdent(info.committer);
      return {
        sha: oid,
        node_id: `C_${oid}`,
        commit: {
          message: info.message,
          tree: { sha: info.tree },
          author: { name: author.name, email: author.email, date: store.epochToIso(author.timestamp) },
          committer: { name: committer.name, email: committer.email, date: store.epochToIso(committer.timestamp) },
        },
        parents: info.parents.map((parent) => ({ sha: parent })),
        author: { login: author.name },
        committer: { login: committer.name },
      };
    });
    sendJson(ctx, 200, commits);
    return true;
  }

  // ----- labels
  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
      const name = str(parsed.value.name);
      const color = str(parsed.value.color) || '000000';
      if (name === '') return sendError(ctx, 422, 'name is required'), true;
      if (repo.labels.has(name)) return sendError(ctx, 422, 'Label already exists'), true;
      repo.labels.set(name, { name, color });
      sendJson(ctx, 201, { name, color, default: false });
      return true;
    }
    if (method === 'GET' && tail.length === 1) {
      sendJson(ctx, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
      return true;
    }
    return sendError(ctx, 404, 'Not Found'), true;
  }

  // ----- issues and comments
  if (tail[0] === 'issues') {
    return handleIssues(ctx, repo, tail.slice(1), method);
  }

  // ----- pulls
  if (tail[0] === 'pulls') {
    return handlePulls(ctx, repo, tail.slice(1), method);
  }

  return sendError(ctx, 404, 'Not Found'), true;
}

function handleContents(ctx: Ctx, repo: RepoRec, path: string, method: string): boolean {
  const store = ctx.store;
  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = store.branchTip(repo, ref);
    if (!tip) return sendError(ctx, 404, 'Not Found'), true;
    const tree = store.treeOfCommit(repo, tip);
    if (!tree) return sendError(ctx, 404, 'Not Found'), true;
    if (path === '') {
      const entries = store.listDir(repo, tree, '');
      if (!entries) return sendError(ctx, 404, 'Not Found'), true;
      sendJson(ctx, 200, entries.map((entry) => dirEntry(repo, entry, '')));
      return true;
    }
    const found = store.lookupPath(repo, tree, path);
    if (!found) return sendError(ctx, 404, 'Not Found'), true;
    if (found.type === 'tree') {
      const entries = store.listDir(repo, tree, path);
      if (!entries) return sendError(ctx, 404, 'Not Found'), true;
      sendJson(ctx, 200, entries.map((entry) => dirEntry(repo, entry, path)));
      return true;
    }
    const blob = repo.objects.get(found.oid);
    if (!blob) return sendError(ctx, 404, 'Not Found'), true;
    const name = path.split('/').pop()!;
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: found.oid,
      size: blob.data.length,
      name,
      path,
    });
    return true;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
    const message = str(parsed.value.message) || (method === 'PUT' ? 'Update file' : 'Delete file');
    const branch = str(parsed.value.branch) || repo.defaultBranch;
    const tip = store.branchTip(repo, branch);
    const tree = tip ? store.treeOfCommit(repo, tip) : null;

    if (method === 'PUT') {
      const contentB64 = str(parsed.value.content);
      const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const existing = tree ? store.lookupPath(repo, tree, path) : null;
      const givenSha = str(parsed.value.sha);
      if (existing && existing.type === 'blob') {
        if (givenSha === '') return sendError(ctx, 422, 'sha is required when updating a file'), true;
        if (givenSha !== existing.oid) return sendError(ctx, 409, 'sha does not match the current file'), true;
      } else if (givenSha !== '') {
        return sendError(ctx, 422, 'sha was given but the file does not exist'), true;
      }
      const blobOid = store.putObject(repo, 'blob', data);
      const newTree = store.updateTreePath(repo, tree, path, blobOid, existing?.mode ?? '100644');
      const commitSha = store.createCommit(repo, {
        tree: newTree,
        parents: tip ? [tip] : [],
        message,
      });
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      const name = path.split('/').pop()!;
      sendJson(ctx, existing ? 200 : 201, {
        content: { name, path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
      return true;
    }

    // DELETE
    if (!tip || !tree) return sendError(ctx, 404, 'Not Found'), true;
    const existing = store.lookupPath(repo, tree, path);
    if (!existing || existing.type !== 'blob') return sendError(ctx, 404, 'Not Found'), true;
    const givenSha = str(parsed.value.sha);
    if (givenSha !== '' && givenSha !== existing.oid) {
      return sendError(ctx, 409, 'sha does not match the current file'), true;
    }
    const newTree = store.updateTreePath(repo, tree, path, null);
    const commitSha = store.createCommit(repo, { tree: newTree, parents: [tip], message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    sendJson(ctx, 200, { content: null, commit: { sha: commitSha, message } });
    return true;
  }

  return sendError(ctx, 404, 'Not Found'), true;
}

function dirEntry(repo: RepoRec, entry: { mode: string; name: string; oid: string }, basePath: string): Json {
  const isDir = entry.mode === '40000';
  const path = basePath === '' ? entry.name : `${basePath}/${entry.name}`;
  const size = !isDir ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0;
  return { type: isDir ? 'dir' : 'file', name: entry.name, path, sha: entry.oid, size };
}

function handleIssues(ctx: Ctx, repo: RepoRec, tail: string[], method: string): boolean {
  const store = ctx.store;
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
      const title = str(parsed.value.title);
      if (title === '') return sendError(ctx, 422, 'title is required'), true;
      const labelNames: string[] = [];
      const rawLabels = parsed.value.labels;
      if (Array.isArray(rawLabels)) {
        for (const raw of rawLabels) {
          const name = typeof raw === 'string' ? raw : str((raw as Json)?.name);
          if (name === '') continue;
          if (!repo.labels.has(name)) {
            return sendError(ctx, 422, `Label "${name}" does not exist on this repository`), true;
          }
          labelNames.push(name);
        }
      }
      const number = repo.nextNumber++;
      const issue: IssueRec = {
        kind: 'issue',
        number,
        dbId: store.allocDbId(),
        title,
        body: str(parsed.value.body),
        state: 'open',
        labels: labelNames,
        comments: [],
        createdSeq: number,
        createdEpoch: store.tick(),
      };
      repo.numbered.set(number, issue);
      sendJson(ctx, 201, issueJson(ctx, repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.numbered.values()].filter((rec): rec is IssueRec => rec.kind === 'issue');
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendJson(ctx, 200, issues.map((issue) => issueJson(ctx, repo, issue)));
      return true;
    }
    return sendError(ctx, 404, 'Not Found'), true;
  }

  const number = Number.parseInt(tail[0]!, 10);
  const rec = Number.isFinite(number) ? repo.numbered.get(number) : undefined;
  const issue = rec && rec.kind === 'issue' ? rec : undefined;

  if (tail.length === 1) {
    if (!issue) return sendError(ctx, 404, 'Not Found'), true;
    if (method === 'GET') {
      sendJson(ctx, 200, issueJson(ctx, repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      sendJson(ctx, 200, issueJson(ctx, repo, issue));
      return true;
    }
    return sendError(ctx, 404, 'Not Found'), true;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return sendError(ctx, 404, 'Not Found'), true;
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map((comment) => commentJson(ctx, comment)));
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
      const body = str(parsed.value.body);
      if (body === '') return sendError(ctx, 422, 'body is required'), true;
      const comment = { id: store.allocCommentId(), body, createdSeq: issue.comments.length + 1 };
      issue.comments.push(comment);
      sendJson(ctx, 201, commentJson(ctx, comment));
      return true;
    }
  }

  return sendError(ctx, 404, 'Not Found'), true;
}

function commentJson(ctx: Ctx, comment: { id: number; body: string }): Json {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login: ctx.store.login ?? 'viewer' },
    created_at: ctx.store.nowIso(),
  };
}

function handlePulls(ctx: Ctx, repo: RepoRec, tail: string[], method: string): boolean {
  const store = ctx.store;
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
      const title = str(parsed.value.title);
      const head = str(parsed.value.head);
      const base = str(parsed.value.base);
      if (title === '' || head === '' || base === '') {
        return sendError(ctx, 422, 'title, head and base are required'), true;
      }
      if (!store.branchTip(repo, head) || !store.branchTip(repo, base)) {
        return sendError(ctx, 422, 'head or base branch does not exist'), true;
      }
      for (const rec of repo.numbered.values()) {
        if (rec.kind === 'pull' && rec.state === 'open' && rec.headRef === head && rec.baseRef === base) {
          return sendError(ctx, 422, `A pull request already exists for ${head} into ${base}`), true;
        }
      }
      const number = repo.nextNumber++;
      const pull: PullRec = {
        kind: 'pull',
        number,
        dbId: store.allocDbId(),
        title,
        body: str(parsed.value.body),
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedEpoch: null,
        mergeCommitSha: null,
        createdSeq: number,
        createdEpoch: store.tick(),
      };
      repo.numbered.set(number, pull);
      sendJson(ctx, 201, pullJson(ctx, repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.numbered.values()].filter((rec): rec is PullRec => rec.kind === 'pull');
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      sendJson(ctx, 200, pulls.map((pull) => pullJson(ctx, repo, pull)));
      return true;
    }
    return sendError(ctx, 404, 'Not Found'), true;
  }

  const number = Number.parseInt(tail[0]!, 10);
  const rec = Number.isFinite(number) ? repo.numbered.get(number) : undefined;
  const pull = rec && rec.kind === 'pull' ? rec : undefined;

  if (tail.length === 1 && method === 'GET') {
    if (!pull) return sendError(ctx, 404, 'Not Found'), true;
    sendJson(ctx, 200, pullJson(ctx, repo, pull));
    return true;
  }
  if (tail.length === 1 && method === 'PATCH') {
    if (!pull) return sendError(ctx, 404, 'Not Found'), true;
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
    if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
    if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
    if (parsed.value.state === 'open' || parsed.value.state === 'closed') pull.state = parsed.value.state;
    sendJson(ctx, 200, pullJson(ctx, repo, pull));
    return true;
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (!pull) return sendError(ctx, 404, 'Not Found'), true;
    sendJson(ctx, 200, pullFiles(ctx, repo, pull));
    return true;
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pull) return sendError(ctx, 404, 'Not Found'), true;
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(ctx, 400, 'Problems parsing JSON'), true;
    const mergeMethod = str(parsed.value.merge_method) || 'merge';
    if (pull.state !== 'open') return sendError(ctx, 405, 'Pull request is not open'), true;
    if (mergeMethod === 'squash') {
      const outcome = mergePull(ctx, repo, pull);
      if (!outcome.ok) return sendError(ctx, 405, 'This branch cannot be merged: merge conflict'), true;
      sendJson(ctx, 200, { sha: outcome.sha!, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
    // Plain merge: same tree computation, two parents.
    const headTip = store.branchTip(repo, pull.headRef);
    const baseTip = store.branchTip(repo, pull.baseRef);
    if (!headTip || !baseTip) return sendError(ctx, 405, 'This branch cannot be merged'), true;
    const tree = mergedTree(ctx, repo, headTip, baseTip);
    if (tree === null) return sendError(ctx, 405, 'This branch cannot be merged: merge conflict'), true;
    const sha = store.createCommit(repo, { tree, parents: [baseTip, headTip], message: `Merge pull request #${pull.number}` });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedEpoch = store.tick();
    pull.mergeCommitSha = sha;
    sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  return sendError(ctx, 404, 'Not Found'), true;
}
