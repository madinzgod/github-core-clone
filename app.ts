// The forge application: one HTTP server routing the git smart-HTTP surface,
// the REST v3 API, GraphQL and MCP onto a single in-memory store.
//
// Auth: every surface except /healthz requires the bearer token the trial
// hands the process in MAKEFUN_SHOP_TOKEN. Request ids and all other
// server-generated values come from counters, never the wall clock, so a
// replayed request sequence reproduces identical state.

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGitRoute, sendError, type Ctx } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `req-${requestCounter}`;
      try {
        const url = new URL(req.url ?? '/', 'http://forge.invalid');
        const pathname = url.pathname;

        if (pathname === '/healthz') {
          const body = Buffer.from(JSON.stringify({ status: 'ok' }), 'utf8');
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(body.length),
            'x-github-request-id': requestId,
          });
          res.end(body);
          return;
        }

        const ctx: Ctx = {
          store,
          req,
          res,
          body: Buffer.alloc(0),
          query: url.searchParams,
          token,
          requestId,
        };

        // Auth: the exact bearer token, on every surface but /healthz.
        if (token !== '') {
          const presented = req.headers.authorization ?? '';
          if (presented !== `Bearer ${token}`) {
            sendError(ctx, 401, 'Bad credentials');
            return;
          }
        }

        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
          ctx.body = await readBody(req);
        }

        const segments = pathname
          .split('/')
          .filter((segment) => segment.length > 0)
          .map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          });

        // Git smart HTTP: /<owner>/<repo>.git/<suffix>
        if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
          const owner = segments[0]!;
          const repoName = segments[1]!.slice(0, -'.git'.length);
          const suffix = `/${segments.slice(2).join('/')}`;
          await handleGitRoute(ctx, owner, repoName, suffix === '/' ? '' : suffix);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'graphql' && req.method === 'POST') {
          handleGraphql(ctx);
          return;
        }

        if (segments[0] === 'mcp') {
          handleMcp(ctx);
          return;
        }

        if (handleRest(ctx, segments)) return;

        sendError(ctx, 404, 'Not Found');
      } catch (err) {
        try {
          if (!res.headersSent) {
            const body = Buffer.from(JSON.stringify({ message: `internal error: ${err instanceof Error ? err.message : String(err)}` }), 'utf8');
            res.writeHead(500, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(body.length),
              'x-github-request-id': requestId,
            });
            res.end(body);
          } else {
            res.end();
          }
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });

  return server;
}
