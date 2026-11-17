// A small GraphQL engine for the subset the forge's API exposes: queries and
// mutations with variables, aliases, inline/named fragments, input objects
// and enum lists, plus the introspection the suite reads (__type field and
// enum lists). Field resolution is table-driven per type; unknown fields
// produce a GraphQL error naming the field, as the real API does.

import { sendError, sendJson, type Ctx } from './githttp.ts';
import { mergePull, pullFiles, pullMergeable } from './rest.ts';
import type { IssueRec, PullRec, RepoRec } from './store.ts';

// ------------------------------------------------------------ global ids

export function encodeId(...parts: (string | number)[]): string {
  return Buffer.from(parts.join(':'), 'utf8').toString('base64');
}

export function decodeId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    if (!text.includes(':')) return null;
    return text.split(':');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ lexer / parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'scalar'; value: string | number | boolean | null }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  selection: SelectionNode[] | null;
}
interface FragmentSpread {
  kind: 'spread';
  name: string;
}
interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpread | InlineFragment;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, Value>;
  selection: SelectionNode[];
}

class GqlError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      if (end === -1) throw new GqlError('unterminated block string');
      tokens.push(`S:${source.slice(i + 3, end)}`);
      i = end + 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new GqlError('unterminated string');
      tokens.push(`S:${out}`);
      i = j + 1;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j]!)) j++;
      tokens.push(`N:${source.slice(i, j)}`);
      i = j;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[-0-9.eE+]/.test(source[j]!)) j++;
      tokens.push(`#:${source.slice(i, j)}`);
      i = j;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    throw new GqlError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new GqlError('unexpected end of document');
    return token;
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlError(`expected ${token}, got ${got}`);
  }
  name(): string {
    const token = this.next();
    if (!token.startsWith('N:')) throw new GqlError(`expected a name, got ${token}`);
    return token.slice(2);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, SelectionNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ type: 'query', name: null, varDefaults: new Map(), selection: this.parseSelectionSet() });
      } else if (token === 'N:query' || token === 'N:mutation' || token === 'N:subscription') {
        this.next();
        const type = token === 'N:mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (this.peek()?.startsWith('N:')) name = this.name();
        const varDefaults = new Map<string, Value>();
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.name();
            this.expect(':');
            this.parseType();
            if (this.peek() === '=') {
              this.next();
              varDefaults.set(varName, this.parseValue());
            }
            if (this.peek() === '@') this.parseDirectives();
          }
          this.expect(')');
        }
        if (this.peek() === '@') this.parseDirectives();
        operations.push({ type, name, varDefaults, selection: this.parseSelectionSet() });
      } else if (token === 'N:fragment') {
        this.next();
        const fragName = this.name();
        const onToken = this.next();
        if (onToken !== 'N:on') throw new GqlError('fragment needs a type condition');
        this.name(); // type condition (expansion is unconditional in this engine)
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new GqlError(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.name();
    }
    if (this.peek() === '!') this.next();
  }

  private parseDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.name();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          this.name();
          this.expect(':');
          this.parseValue();
        }
        this.expect(')');
      }
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      const token = this.peek()!;
      if (token === '...') {
        this.next();
        if (this.peek() === 'N:on') {
          this.next();
          const typeCondition = this.name();
          if (this.peek() === '@') this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek()?.startsWith('N:')) {
          selections.push({ kind: 'spread', name: this.name() });
          if (this.peek() === '@') this.parseDirectives();
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.name();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.name();
      }
      const args: { name: string; value: Value }[] = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.name();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      if (this.peek() === '@') this.parseDirectives();
      let selection: SelectionNode[] | null = null;
      if (this.peek() === '{') {
        selection = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    this.expect('}');
    return selections;
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.name() };
    if (token.startsWith('S:')) return { kind: 'scalar', value: token.slice(2) };
    if (token.startsWith('#:')) {
      const raw = token.slice(2);
      return { kind: 'scalar', value: raw.includes('.') || /[eE]/.test(raw) ? Number.parseFloat(raw) : Number.parseInt(raw, 10) };
    }
    if (token.startsWith('N:')) {
      const word = token.slice(2);
      if (word === 'true') return { kind: 'scalar', value: true };
      if (word === 'false') return { kind: 'scalar', value: false };
      if (word === 'null') return { kind: 'scalar', value: null };
      return { kind: 'enum', value: word };
    }
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const fieldName = this.name();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new GqlError(`unexpected value token ${token}`);
  }
}

// ------------------------------------------------------------ schema

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['login', 'id', 'name', 'url', 'databaseId', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt', '__typename',
  ],
  Ref: ['name', 'prefix', 'target', '__typename'],
  RefTarget: ['oid', '__typename'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments', 'repository',
    'createdAt', 'updatedAt', '__typename',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'url', 'author', 'repository',
    'createdAt', 'updatedAt', '__typename',
  ],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  PullRequestEdge: ['node', 'cursor', '__typename'],
  PullRequestFileEdge: ['node', 'cursor', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  Label: ['name', 'color', '__typename'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId', '__typename'],
  IssueCommentEdge: ['node', 'cursor', '__typename'],
  TypeInfo: ['name', 'kind', 'fields', 'enumValues', 'description', '__typename'],
  FieldInfo: ['name', 'description', 'type', '__typename'],
  EnumValueInfo: ['name', 'description', '__typename'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'REBASE', 'SQUASH'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  State: ['OPEN', 'CLOSED'],
};

const OBJECT_TYPES = new Set(Object.keys(TYPE_FIELDS));

// ------------------------------------------------------------ execution

type GObj = { __type: string; [key: string]: unknown };

interface ExecCtx {
  ctx: Ctx;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, SelectionNode[]>;
}

function resolveValue(value: Value, exec: ExecCtx): unknown {
  switch (value.kind) {
    case 'var': {
      const found = exec.variables[value.name];
      return found === undefined ? null : found;
    }
    case 'scalar':
      return value.value;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, exec));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, exec);
      return out;
    }
  }
}

function argsOf(node: FieldNode, exec: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of node.args) out[arg.name] = resolveValue(arg.value, exec);
  return out;
}

function userObj(): GObj {
  return { __type: 'User' };
}

function repoObj(repo: RepoRec): GObj {
  return { __type: 'Repository', repo };
}

function issueObj(repo: RepoRec, rec: IssueRec): GObj {
  return { __type: 'Issue', repo, rec };
}

function pullObj(repo: RepoRec, rec: PullRec): GObj {
  return { __type: 'PullRequest', repo, rec };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface ConnectionSpec {
  type: string;
  edgeType: string;
  items: GObj[];
  numbers: number[]; // parallel to items, for cursors
  total: number;
}

function connection(spec: ConnectionSpec, args: Record<string, unknown>): GObj {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : spec.items.length;
  let startIndex = 0;
  if (typeof args.after === 'string') {
    const afterNumber = numberFromCursor(args.after);
    if (afterNumber !== null) {
      const idx = spec.numbers.indexOf(afterNumber);
      if (idx >= 0) startIndex = idx + 1;
    }
  }
  const slice = spec.items.slice(startIndex, startIndex + first);
  const sliceNumbers = spec.numbers.slice(startIndex, startIndex + first);
  const hasNext = startIndex + first < spec.items.length;
  const pageInfo: GObj = {
    __type: 'PageInfo',
    hasNextPage: hasNext,
    hasPreviousPage: startIndex > 0,
    startCursor: sliceNumbers.length > 0 ? cursorFor(sliceNumbers[0]!) : null,
    endCursor: sliceNumbers.length > 0 ? cursorFor(sliceNumbers[sliceNumbers.length - 1]!) : null,
  };
  return {
    __type: spec.type,
    nodes: slice,
    edges: slice.map((node, i) => ({ __type: spec.edgeType, node, cursor: cursorFor(sliceNumbers[i]!) })),
    pageInfo,
    totalCount: spec.total,
  };
}

function repoById(ctx: Ctx, id: number): RepoRec | null {
  for (const repo of ctx.store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function decodeRepoId(id: unknown): number | null {
  if (typeof id !== 'string') return null;
  const parts = decodeId(id);
  if (!parts || parts[0] !== 'Repository') return null;
  const num = Number(parts[1]);
  return Number.isFinite(num) ? num : null;
}

function resolveField(obj: GObj | null, node: FieldNode, exec: ExecCtx): unknown {
  const { ctx } = exec;
  const store = ctx.store;
  const args = argsOf(node, exec);
  const field = node.name;

  if (field === '__typename') return obj ? obj.__type : null;

  // Introspection at the root.
  if (obj === null || obj.__type === 'Query') {
    switch (field) {
      case '__type': {
        const name = String(args.name ?? '');
        if (OBJECT_TYPES.has(name)) return { __type: 'TypeInfo', name, kind: 'OBJECT' };
        if (name in ENUM_VALUES) return { __type: 'TypeInfo', name, kind: 'ENUM' };
        return null;
      }
      case '__schema':
        return null;
      case 'viewer':
        return userObj();
      case 'repository': {
        const repo = store.repoFor(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObj(repo) : null;
      }
      case 'node': {
        return nodeById(ctx, args.id);
      }
      case 'nodes': {
        const ids = Array.isArray(args.ids) ? args.ids : [];
        return ids.map((id) => nodeById(ctx, id));
      }
      case 'user': {
        return userObj();
      }
      default:
        exec.errors.push({ message: `Field '${field}' doesn't exist on type 'Query'` });
        return null;
    }
  }

  const type = obj.__type;
  const known = TYPE_FIELDS[type];
  if (!known || !known.includes(field)) {
    exec.errors.push({ message: `Field '${field}' doesn't exist on type '${type}'` });
    return null;
  }

  switch (type) {
    case 'User': {
      if (field === 'login') return store.login ?? 'viewer';
      if (field === 'id') return encodeId('User', 1);
      if (field === 'databaseId') return 1;
      if (field === 'name') return store.login ?? 'viewer';
      if (field === 'url') return `http://forge.invalid/${store.login ?? 'viewer'}`;
      return null;
    }
    case 'Repository': {
      const repo = obj.repo as RepoRec;
      switch (field) {
        case 'id': return encodeId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${store.login ?? 'viewer'}/${repo.name}`;
        case 'owner': return userObj();
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'url': return `http://forge.invalid/${store.login ?? 'viewer'}/${repo.name}`;
        case 'createdAt': return store.epochToIso(repo.createdEpoch);
        case 'updatedAt': return store.epochToIso(repo.createdEpoch);
        case 'defaultBranchRef': {
          const tip = store.branchTip(repo, repo.defaultBranch);
          return tip ? { __type: 'Ref', name: repo.defaultBranch } : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const rec = repo.numbered.get(Number(args.number));
          return rec && rec.kind === 'issue' ? issueObj(repo, rec) : null;
        }
        case 'issues': {
          let issues = [...repo.numbered.values()].filter((rec): rec is IssueRec => rec.kind === 'issue');
          const states = args.states as unknown[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          const direction = orderBy?.direction === 'DESC' ? 'DESC' : 'ASC';
          issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
          return connection(
            {
              type: 'IssueConnection',
              edgeType: 'IssueEdge',
              items: issues.map((issue) => issueObj(repo, issue)),
              numbers: issues.map((issue) => issue.number),
              total: issues.length,
            },
            args,
          );
        }
        case 'pullRequest': {
          const rec = repo.numbered.get(Number(args.number));
          return rec && rec.kind === 'pull' ? pullObj(repo, rec) : null;
        }
        case 'pullRequests': {
          let pulls = [...repo.numbered.values()].filter((rec): rec is PullRec => rec.kind === 'pull');
          const states = args.states as unknown[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state)));
            pulls = pulls.filter((pull) => {
              const gqlState = pull.merged ? 'MERGED' : pull.state.toUpperCase();
              return wanted.has(gqlState);
            });
          }
          pulls.sort((a, b) => a.number - b.number);
          return connection(
            {
              type: 'PullRequestConnection',
              edgeType: 'PullRequestEdge',
              items: pulls.map((pull) => pullObj(repo, pull)),
              numbers: pulls.map((pull) => pull.number),
              total: pulls.length,
            },
            args,
          );
        }
      }
      return null;
    }
    case 'Ref': {
      if (field === 'name') return obj.name as string;
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') return { __type: 'RefTarget', oid: obj.oid ?? null };
      return null;
    }
    case 'RefTarget': {
      if (field === 'oid') return obj.oid ?? null;
      return null;
    }
    case 'Issue': {
      const repo = obj.repo as RepoRec;
      const rec = obj.rec as IssueRec;
      switch (field) {
        case 'id': return encodeId('Issue', repo.id, rec.number);
        case 'number': return rec.number;
        case 'title': return rec.title;
        case 'state': return rec.state.toUpperCase();
        case 'body': return rec.body;
        case 'url': return `http://forge.invalid/${store.login ?? 'viewer'}/${repo.name}/issues/${rec.number}`;
        case 'author': return userObj();
        case 'repository': return repoObj(repo);
        case 'createdAt': return store.epochToIso(rec.createdEpoch);
        case 'updatedAt': return store.epochToIso(rec.createdEpoch);
        case 'labels': {
          const nodes = rec.labels.map((name) => ({ __type: 'Label', name, color: repo.labels.get(name)?.color ?? '000000' }));
          return {
            __type: 'LabelConnection',
            nodes,
            edges: nodes.map((labelNode, i) => ({ __type: 'IssueEdge', node: labelNode, cursor: cursorFor(i + 1) })),
            pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: nodes.length,
          };
        }
        case 'comments': {
          const nodes = rec.comments.map((comment) => commentObj(repo, rec, comment));
          return connection(
            {
              type: 'IssueCommentConnection',
              edgeType: 'IssueCommentEdge',
              items: nodes,
              numbers: rec.comments.map((comment) => comment.id),
              total: nodes.length,
            },
            args,
          );
        }
      }
      return null;
    }
    case 'PullRequest': {
      const repo = obj.repo as RepoRec;
      const rec = obj.rec as PullRec;
      switch (field) {
        case 'id': return encodeId('PullRequest', repo.id, rec.number);
        case 'number': return rec.number;
        case 'title': return rec.title;
        case 'body': return rec.body;
        case 'state': return rec.merged ? 'MERGED' : rec.state.toUpperCase();
        case 'merged': return rec.merged;
        case 'mergedAt': return rec.mergedEpoch !== null ? store.epochToIso(rec.mergedEpoch) : null;
        case 'mergeCommit': return rec.mergeCommitSha ? { __type: 'RefTarget', oid: rec.mergeCommitSha } : null;
        case 'headRefName': return rec.headRef;
        case 'baseRefName': return rec.baseRef;
        case 'headRefOid': return store.branchTip(repo, rec.headRef);
        case 'baseRefOid': return store.branchTip(repo, rec.baseRef);
        case 'mergeable': {
          if (rec.state !== 'open') return 'UNKNOWN';
          return pullMergeable(ctx, repo, rec) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'url': return `http://forge.invalid/${store.login ?? 'viewer'}/${repo.name}/pull/${rec.number}`;
        case 'author': return userObj();
        case 'repository': return repoObj(repo);
        case 'createdAt': return store.epochToIso(rec.createdEpoch);
        case 'updatedAt': return store.epochToIso(rec.createdEpoch);
        case 'files': {
          const files = pullFiles(ctx, repo, rec);
          const nodes: GObj[] = files.map((file, i) => ({
            __type: 'PullRequestChangedFile',
            path: String(file.filename),
            additions: file.additions as number,
            deletions: file.deletions as number,
            changeType: String(file.status).toUpperCase(),
            index: i + 1,
          }));
          return connection(
            {
              type: 'PullRequestFileConnection',
              edgeType: 'PullRequestFileEdge',
              items: nodes,
              numbers: nodes.map((_, i) => i + 1),
              total: nodes.length,
            },
            args,
          );
        }
      }
      return null;
    }
    case 'IssueComment': {
      const rec = obj.comment as { id: number; body: string };
      if (field === 'id') return encodeId('IssueComment', (obj.repo as RepoRec).id, obj.issueNumber as number, rec.id);
      if (field === 'body') return rec.body;
      if (field === 'author') return userObj();
      if (field === 'createdAt') return store.nowIso();
      return null;
    }
    case 'Label': {
      if (field === 'name') return obj.name as string;
      if (field === 'color') return obj.color as string;
      return null;
    }
    case 'PageInfo': {
      return (obj[field] as unknown) ?? null;
    }
    case 'TypeInfo': {
      if (field === 'name') return obj.name as string;
      if (field === 'kind') return obj.kind as string;
      if (field === 'fields') {
        const fields = TYPE_FIELDS[obj.name as string] ?? [];
        return fields.filter((name) => name !== '__typename').map((name) => ({ __type: 'FieldInfo', name }));
      }
      if (field === 'enumValues') {
        const values = ENUM_VALUES[obj.name as string] ?? [];
        return values.map((name) => ({ __type: 'EnumValueInfo', name }));
      }
      return null;
    }
    case 'FieldInfo':
    case 'EnumValueInfo': {
      if (field === 'name') return obj.name as string;
      return null;
    }
  }

  // Connections and edges expose their stored parts generically.
  if (type.endsWith('Connection')) {
    if (field === 'nodes') return obj.nodes as GObj[];
    if (field === 'edges') return obj.edges as GObj[];
    if (field === 'pageInfo') return obj.pageInfo as GObj;
    if (field === 'totalCount') return obj.totalCount as number;
  }
  if (type.endsWith('Edge')) {
    if (field === 'node') return obj.node as GObj;
    if (field === 'cursor') return obj.cursor as string;
  }
  if (type === 'PullRequestChangedFile') {
    if (field === 'path') return obj.path as string;
    if (field === 'additions') return obj.additions as number;
    if (field === 'deletions') return obj.deletions as number;
    if (field === 'changeType') return obj.changeType as string;
  }
  // Mutation payloads.
  if (type.endsWith('Payload')) {
    if (field === 'clientMutationId') return null;
    if (field === 'issue') return obj.issue as GObj;
    if (field === 'pullRequest') return obj.pullRequest as GObj;
    if (field === 'commentEdge') return obj.commentEdge as GObj;
    if (field === 'subject') return obj.subject as GObj;
  }

  exec.errors.push({ message: `Field '${field}' doesn't exist on type '${type}'` });
  return null;
}

function commentObj(repo: RepoRec, issue: IssueRec, comment: { id: number; body: string }): GObj {
  return { __type: 'IssueComment', repo, issueNumber: issue.number, comment };
}

function nodeById(ctx: Ctx, id: unknown): GObj | null {
  if (typeof id !== 'string') return null;
  const parts = decodeId(id);
  if (!parts) return null;
  const [kind, a, b] = parts;
  if (kind === 'Repository') {
    const repo = repoById(ctx, Number(a));
    return repo ? repoObj(repo) : null;
  }
  if (kind === 'Issue' || kind === 'PullRequest') {
    const repo = repoById(ctx, Number(a));
    if (!repo) return null;
    const rec = repo.numbered.get(Number(b));
    if (!rec) return null;
    if (kind === 'Issue' && rec.kind === 'issue') return issueObj(repo, rec);
    if (kind === 'PullRequest' && rec.kind === 'pull') return pullObj(repo, rec);
    return null;
  }
  if (kind === 'User') return userObj();
  return null;
}

// ------------------------------------------------------------ mutations

function resolveMutation(node: FieldNode, exec: ExecCtx): unknown {
  const { ctx } = exec;
  const store = ctx.store;
  const args = argsOf(node, exec);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const field = node.name;

  switch (field) {
    case 'createIssue': {
      const repo = repoById(ctx, decodeRepoId(input.repositoryId) ?? -1);
      if (!repo) {
        exec.errors.push({ message: 'repository not found' });
        return null;
      }
      const number = repo.nextNumber++;
      const rec: IssueRec = {
        kind: 'issue',
        number,
        dbId: store.allocDbId(),
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: number,
        createdEpoch: store.tick(),
      };
      repo.numbered.set(number, rec);
      return { __type: 'CreateIssuePayload', issue: issueObj(repo, rec) };
    }
    case 'closeIssue': {
      const target = nodeById(ctx, input.issueId);
      if (!target || target.__type !== 'Issue') {
        exec.errors.push({ message: 'issue not found' });
        return null;
      }
      const rec = target.rec as IssueRec;
      rec.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: target };
    }
    case 'createPullRequest': {
      const repo = repoById(ctx, decodeRepoId(input.repositoryId) ?? -1);
      if (!repo) {
        exec.errors.push({ message: 'repository not found' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!store.branchTip(repo, head) || !store.branchTip(repo, base)) {
        exec.errors.push({ message: 'head or base branch does not exist' });
        return null;
      }
      for (const rec of repo.numbered.values()) {
        if (rec.kind === 'pull' && rec.state === 'open' && rec.headRef === head && rec.baseRef === base) {
          return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, rec) };
        }
      }
      const number = repo.nextNumber++;
      const rec: PullRec = {
        kind: 'pull',
        number,
        dbId: store.allocDbId(),
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedEpoch: null,
        mergeCommitSha: null,
        createdSeq: number,
        createdEpoch: store.tick(),
      };
      repo.numbered.set(number, rec);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, rec) };
    }
    case 'mergePullRequest': {
      const target = nodeById(ctx, input.pullRequestId);
      if (!target || target.__type !== 'PullRequest') {
        exec.errors.push({ message: 'pull request not found' });
        return null;
      }
      const repo = target.repo as RepoRec;
      const rec = target.rec as PullRec;
      if (rec.state !== 'open') {
        exec.errors.push({ message: 'pull request is not open' });
        return null;
      }
      const outcome = mergePull(ctx, repo, rec);
      if (!outcome.ok) {
        exec.errors.push({ message: 'merge conflict' });
        return null;
      }
      return { __type: 'MergePullRequestPayload', pullRequest: target };
    }
    case 'addComment': {
      const target = nodeById(ctx, input.subjectId);
      if (!target || target.__type !== 'Issue') {
        exec.errors.push({ message: 'subject not found' });
        return null;
      }
      const repo = target.repo as RepoRec;
      const rec = target.rec as IssueRec;
      const comment = { id: store.allocCommentId(), body: String(input.body ?? ''), createdSeq: rec.comments.length + 1 };
      rec.comments.push(comment);
      const node = commentObj(repo, rec, comment);
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) },
        subject: target,
      };
    }
    default:
      exec.errors.push({ message: `Field '${field}' doesn't exist on type 'Mutation'` });
      return null;
  }
}

// ------------------------------------------------------------ completion

function completeValue(value: unknown, selection: SelectionNode[] | null, exec: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selection, exec));
  if (typeof value === 'object' && '__type' in (value as GObj)) {
    if (!selection) return null;
    return executeSelectionSet(value as GObj, selection, exec);
  }
  return value;
}

function executeSelectionSet(obj: GObj | null, selections: SelectionNode[], exec: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(obj, fragment, exec));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || obj === null || obj.__type === selection.typeCondition) {
        Object.assign(out, executeSelectionSet(obj, selection.selection, exec));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = obj ? obj.__type : null;
      continue;
    }
    const value = obj !== null && obj.__type === 'Mutation'
      ? resolveMutation(selection, exec)
      : resolveField(obj, selection, exec);
    out[key] = completeValue(value, selection.selection, exec);
  }
  return out;
}

export function executeGraphql(ctx: Ctx, body: unknown): { status: number; payload: unknown } {
  const runOne = (entry: Record<string, unknown>): Record<string, unknown> => {
    const query = String(entry.query ?? '');
    const variables = (typeof entry.variables === 'object' && entry.variables !== null ? entry.variables : {}) as Record<string, unknown>;
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
    let parsed;
    try {
      parsed = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const operation = parsed.operations.find((op) => operationName === null || op.name === operationName) ?? parsed.operations[0];
    if (!operation) return { errors: [{ message: 'no operation in document' }] };
    const exec: ExecCtx = { ctx, variables: { ...variables }, errors: [], fragments: parsed.fragments };
    for (const [name, defaultValue] of operation.varDefaults) {
      if (exec.variables[name] === undefined) exec.variables[name] = resolveValue(defaultValue, exec);
    }
    const root: GObj = { __type: operation.type === 'mutation' ? 'Mutation' : 'Query' };
    const data = executeSelectionSet(root, operation.selection, exec);
    const result: Record<string, unknown> = { data };
    if (exec.errors.length > 0) result.errors = exec.errors;
    return result;
  };

  if (Array.isArray(body)) {
    return { status: 200, payload: body.map((entry) => runOne((entry ?? {}) as Record<string, unknown>)) };
  }
  if (typeof body === 'object' && body !== null) {
    return { status: 200, payload: runOne(body as Record<string, unknown>) };
  }
  return { status: 400, payload: { errors: [{ message: 'request body must be a JSON object or array' }] } };
}

export function handleGraphql(ctx: Ctx): boolean {
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendError(ctx, 400, 'Problems parsing JSON');
    return true;
  }
  const { status, payload } = executeGraphql(ctx, body);
  sendJson(ctx, status, payload);
  return true;
}
