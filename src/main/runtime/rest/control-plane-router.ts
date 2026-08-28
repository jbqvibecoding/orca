// The minimal control-plane REST surface (ADR-0009).
//
// It rides the listener that already serves the web client and the mobile
// WebSocket, so it inherits that listener's whole security posture: per-device
// token auth, the loopback-by-default bind that only widens once a network
// device is paired, and TLS when certificates are configured. A second HTTP
// server would have had to restate all of it, and would most likely have
// restated it worse.
//
// What it does NOT inherit is the mobile socket's per-device E2EE — a REST
// request cannot carry it. So this is token auth over TLS or loopback, and that
// difference is written down in docs/reference/control-plane-rest.md rather than
// left for someone to discover.
//
// Deliberately minimal, per ADR-0009: read tasks, read and set budgets, read and
// resolve approvals. Org charts, multi-company isolation, SSO, RBAC and GRC are
// out of scope until someone asks with a use case.

import type { IncomingMessage, ServerResponse } from 'node:http'

export const CONTROL_PLANE_PREFIX = '/v1/'

export type ControlPlaneRoute = {
  method: 'GET' | 'PUT' | 'POST'
  /** Path with `:param` segments, e.g. `/v1/tasks/:id`. */
  pattern: string
  handle: (args: {
    params: Record<string, string>
    query: URLSearchParams
    body: unknown
    // `unknown` covers a promise too; the router awaits either way, so a route
    // may be sync or async without declaring which.
  }) => unknown
}

export type ControlPlaneAuth = (request: IncomingMessage) => boolean

export class ControlPlaneHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** Requests larger than this are refused before being buffered. */
const MAX_BODY_BYTES = 64 * 1024

export function isControlPlanePath(pathname: string): boolean {
  return pathname === '/v1' || pathname.startsWith(CONTROL_PLANE_PREFIX)
}

type CompiledRoute = ControlPlaneRoute & { segments: string[] }

function compile(route: ControlPlaneRoute): CompiledRoute {
  return { ...route, segments: route.pattern.split('/').filter((part) => part.length > 0) }
}

function matchRoute(
  routes: readonly CompiledRoute[],
  method: string,
  pathname: string
): { route: CompiledRoute; params: Record<string, string> } | { methodMismatch: true } | null {
  const parts = pathname.split('/').filter((part) => part.length > 0)
  let sawPath = false
  for (const route of routes) {
    if (route.segments.length !== parts.length) {
      continue
    }
    const params: Record<string, string> = {}
    const matched = route.segments.every((segment, index) => {
      const part = parts[index] as string
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(part)
        return true
      }
      return segment === part
    })
    if (!matched) {
      continue
    }
    sawPath = true
    if (route.method === method) {
      return { route, params }
    }
  }
  // A known path with the wrong verb is a 405, not a 404: telling a client its
  // method is wrong is the difference between a typo and a missing feature.
  return sawPath ? { methodMismatch: true } : null
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) {
      throw new ControlPlaneHttpError(413, 'Request body is too large.')
    }
    chunks.push(chunk as Buffer)
  }
  if (total === 0) {
    return undefined
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  } catch {
    throw new ControlPlaneHttpError(400, 'Request body is not valid JSON.')
  }
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // The control plane is data, never a document: refusing to sniff keeps a
    // stored string from ever being interpreted as markup by a browser.
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store'
  })
  response.end(body)
}

/**
 * Builds the `/v1` handler. Returns false when the request is not a control
 * plane request, so the caller can fall through to whatever else it serves.
 */
export function createControlPlaneRouter(args: {
  routes: readonly ControlPlaneRoute[]
  authenticate: ControlPlaneAuth
}): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const routes = args.routes.map(compile)

  return async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (!isControlPlanePath(pathname)) {
      return false
    }
    // Authentication comes before routing so an unauthenticated caller cannot
    // learn which paths exist by comparing 404s against 405s.
    if (!args.authenticate(request)) {
      send(response, 401, { error: 'unauthorized' })
      return true
    }
    const matched = matchRoute(routes, request.method ?? 'GET', pathname)
    if (matched === null) {
      send(response, 404, { error: 'not_found' })
      return true
    }
    if ('methodMismatch' in matched) {
      send(response, 405, { error: 'method_not_allowed' })
      return true
    }
    try {
      const body = request.method === 'GET' ? undefined : await readBody(request)
      const query = new URL(request.url ?? '/', 'http://localhost').searchParams
      const result = await matched.route.handle({ params: matched.params, query, body })
      send(response, 200, result)
    } catch (error) {
      if (error instanceof ControlPlaneHttpError) {
        send(response, error.status, { error: error.message })
        return true
      }
      // Internal detail stays in the log, not in the response body.
      send(response, 500, { error: 'internal_error' })
    }
    return true
  }
}

/** Bearer token from the Authorization header, or null when absent or malformed. */
export function readBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') {
    return null
  }
  const match = /^Bearer (.+)$/.exec(header.trim())
  return match ? (match[1] as string) : null
}
