// Process entry point for the forge.
//
// The trial harness starts an env service next to this process and points
// MAKEFUN_ENV_URL at it. This file owns everything around the HTTP surface
// in app.ts: bind the forge to a port the kernel chooses, tell the env
// which port that was, stay alive while the suite drives the forge, and
// shut down with a success status once the env says its export is done.
//
// There is deliberately no standalone mode: without an env there is no
// suite to serve and nothing to register with, so the process refuses to
// start (exit 1) when MAKEFUN_ENV_URL is missing.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

/** Delay before the first retry of a failed env call, in milliseconds. */
const RETRY_FLOOR_MS = 100;
/** Cap for the exponential retry delay, in milliseconds. */
const RETRY_CEILING_MS = 2_000;
/** Pause between two successful /done polls, in milliseconds. */
const DONE_POLL_MS = 250;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff: floor, doubling per consecutive failure, capped. */
function retryDelay(consecutiveFailures: number): number {
  return Math.min(RETRY_FLOOR_MS * 2 ** consecutiveFailures, RETRY_CEILING_MS);
}

/** The env's origin with any trailing slashes removed; throws when unset. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: this entry only runs beside the trial env');
  }
  return raw.replace(/\/+$/, '');
}

/** Read and discard a response body so its connection can be reused. */
async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    // A body that cannot be read is not worth failing over.
  }
}

/**
 * POST the bound port to the env's /register until it accepts. The env
 * keeps the first registration it sees, so a 409 (already registered)
 * counts as success too; anything else is retried with backoff.
 */
async function registerBoundPort(origin: string, port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ port }),
      });
      await drain(res);
      if (res.ok || res.status === 409) return;
    } catch {
      // The env may still be coming up; fall through to the retry delay.
    }
    await pause(retryDelay(failures));
    failures += 1;
  }
}

/**
 * Poll the env's /done until it reports completion. Each poll is a fresh
 * short request (never held open); a failed poll backs off exponentially
 * and a successful one resets the backoff.
 */
async function waitForSuiteEnd(origin: string): Promise<void> {
  let failures = 0;
  for (;;) {
    let wait = DONE_POLL_MS;
    try {
      const res = await fetch(`${origin}/done`, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`done poll answered ${res.status}`);
      const payload = (await res.json()) as { done?: unknown };
      if (payload.done === true) return;
      failures = 0;
    } catch {
      wait = retryDelay(failures);
      failures += 1;
    }
    await pause(wait);
  }
}

/** Listen on an ephemeral port and resolve with the port that was bound. */
function bindEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(0, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** Close the server, resolving once every connection has ended. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Let an operator stop the process tidily: on SIGINT or SIGTERM, close the
 * server and exit successfully instead of being killed mid-request. A
 * connection that refuses to end only delays the exit by a short grace
 * period, never indefinitely.
 */
function exitCleanlyOnStopSignal(server: Server): void {
  const stop = (): void => {
    void closeServer(server).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function run(): Promise<number> {
  let origin: string;
  try {
    origin = envOrigin();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const server = createApp();
  exitCleanlyOnStopSignal(server);
  const port = await bindEphemeral(server);
  console.log(`forge bound to port ${port}; registering with the env at ${origin}`);
  await registerBoundPort(origin, port);
  await waitForSuiteEnd(origin);
  await closeServer(server);
  return 0;
}

run().then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
