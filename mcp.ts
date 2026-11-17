// MCP (Model Context Protocol) over Streamable HTTP: JSON-RPC 2.0 POSTs to
// /mcp. The server speaks the modern discovery era (server/discover) and also
// answers a legacy initialize handshake. The tools act on the same store as
// the REST surface, so objects are identical across surfaces.

import { sendJson, type Ctx } from './githttp.ts';
import { issueJson, mergePull, pullJson, repoJson } from './rest.ts';
import type { IssueRec, PullRec } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const MODERN_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated account.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// Built once so repeated tools/list answers are byte-for-byte identical.
const TOOLS_LIST_RESULT = { tools: TOOLS };

type Json = Record<string, unknown>;

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolOk(payload: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Json,
    isError: false,
  };
}

function toolError(message: string): Json {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function strArg(args: Json, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function callTool(ctx: Ctx, name: string, args: Json): Json {
  const store = ctx.store;
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      if (repoName === '') return toolError('name is required');
      if (store.repos.has(repoName)) return toolError(`A repository with that name already exists`);
      const repo = store.createRepo(repoName, {
        description: strArg(args, 'description'),
        isPrivate: args.private === true,
      });
      return toolOk(repoJson(ctx, repo));
    }
    case 'get_repo': {
      const repo = store.repoFor(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError('repository not found');
      return toolOk(repoJson(ctx, repo));
    }
    case 'create_issue': {
      const repo = store.repoFor(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError('repository not found');
      const title = strArg(args, 'title');
      if (title === '') return toolError('title is required');
      const number = repo.nextNumber++;
      const issue: IssueRec = {
        kind: 'issue',
        number,
        dbId: store.allocDbId(),
        title,
        body: strArg(args, 'body'),
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: number,
        createdEpoch: store.tick(),
      };
      repo.numbered.set(number, issue);
      return toolOk(issueJson(ctx, repo, issue));
    }
    case 'list_issues': {
      const repo = store.repoFor(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError('repository not found');
      const state = strArg(args, 'state') || 'open';
      let issues = [...repo.numbered.values()].filter((rec): rec is IssueRec => rec.kind === 'issue');
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolOk(issues.map((issue) => issueJson(ctx, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = store.repoFor(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError('repository not found');
      const title = strArg(args, 'title');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
      if (!store.branchTip(repo, head) || !store.branchTip(repo, base)) {
        return toolError('head or base branch does not exist');
      }
      for (const rec of repo.numbered.values()) {
        if (rec.kind === 'pull' && rec.state === 'open' && rec.headRef === head && rec.baseRef === base) {
          return toolOk(pullJson(ctx, repo, rec));
        }
      }
      const number = repo.nextNumber++;
      const pull: PullRec = {
        kind: 'pull',
        number,
        dbId: store.allocDbId(),
        title,
        body: strArg(args, 'body'),
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
      return toolOk(pullJson(ctx, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.repoFor(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError('repository not found');
      const numberRaw = args.pull_number;
      const number = typeof numberRaw === 'number' ? numberRaw : Number.parseInt(String(numberRaw ?? ''), 10);
      const rec = Number.isFinite(number) ? repo.numbered.get(number) : undefined;
      if (!rec || rec.kind !== 'pull') return toolError('pull request not found');
      if (rec.state !== 'open') return toolError('pull request is not open');
      const outcome = mergePull(ctx, repo, rec);
      if (!outcome.ok) return toolError('merge conflict');
      return toolOk(pullJson(ctx, repo, rec));
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

function handleRpc(ctx: Ctx, message: Json): Json | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Json;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: [MODERN_VERSION, '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26';
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Json;
      if (!TOOLS.some((tool) => tool.name === name)) {
        return rpcError(id, -32602, `unknown tool: ${name}`);
      }
      const def = TOOLS.find((tool) => tool.name === name)!;
      for (const required of def.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcResult(id, toolError(`missing required argument: ${required}`));
        }
      }
      return rpcResult(id, callTool(ctx, name, args));
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export function handleMcp(ctx: Ctx): boolean {
  if (ctx.req.method !== 'POST') {
    ctx.res.writeHead(405, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': ctx.requestId,
      allow: 'POST',
    });
    ctx.res.end(JSON.stringify(rpcError(null, -32601, 'method not allowed: use POST')));
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    ctx.res.writeHead(400, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': ctx.requestId,
    });
    ctx.res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return true;
  }
  if (Array.isArray(body)) {
    const responses = body
      .map((entry) => handleRpc(ctx, (entry ?? {}) as Json))
      .filter((entry): entry is Json => entry !== null);
    sendJson(ctx, 200, responses);
    return true;
  }
  const response = handleRpc(ctx, (body ?? {}) as Json);
  if (response === null) {
    // A notification: acknowledge with no body.
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return true;
  }
  sendJson(ctx, 200, response);
  return true;
}
