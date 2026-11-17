# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/madinzgod/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/madinzgod/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)


A standalone GitHub-compatible git forge in a single Node process, written
from scratch against the make.fun `github-core-clone-01` rulebook. Node
standard library only; TypeScript in type-stripping-compatible form.

## Surfaces

- **Git smart HTTP** (`/<owner>/<repo>.git/...`): protocol v0 and v2
  advertisements, `ls-refs`, fetch with shallow/deepen support, and
  receive-pack with report-status — all over an in-memory git object store
  with hand-rolled packfile read/write.
- **REST v3** (`/api/v3/...`): repositories, contents backed by the git
  store, git refs, branches, commits, labels, issues, comments and pull
  requests with squash merges and file diffs.
- **GraphQL** (`/api/graphql`): a small parser/executor covering the
  viewer/repository/issue/pull-request graph, mutations, cursor pagination
  and the introspection the API contract requires.
- **MCP** (`/mcp`): JSON-RPC tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) acting on the same store as REST.

## Design notes

- The trial hands the process one bearer token (`MAKEFUN_SHOP_TOKEN`). The
  account's login is bound by the first owner-named access to an existing
  repository, mirroring how the suite addresses the token's repos.
- Determinism is a hard requirement: ids are sequential counters and every
  timestamp comes from a logical clock (a fixed base epoch advanced per
  event). No wall clock or randomness reaches stored state, so replaying a
  request sequence reproduces the same state byte-for-byte.
- `main.ts` is the harness lifecycle (register the bound port with the env,
  poll `/done`, exit); `app.ts` builds the server.

## Run

```
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> npm start
```
