// The control plane over a real HTTP server.
//
// Routing and auth are the kind of thing that looks right in unit tests and
// fails on the wire, so these run actual requests through node:http rather than
// calling the handler with a fake IncomingMessage.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ControlPlaneHttpError,
  createControlPlaneRouter,
  isControlPlanePath,
  readBearerToken,
  type ControlPlaneRoute
} from './control-plane-router'

const TOKEN = 'a-valid-device-token'

const ROUTES: ControlPlaneRoute[] = [
  { method: 'GET', pattern: '/v1/things', handle: () => ({ things: [] }) },
  { method: 'GET', pattern: '/v1/things/:id', handle: ({ params }) => ({ id: params.id }) },
  { method: 'PUT', pattern: '/v1/things/:id', handle: ({ params, body }) => ({ params, body }) },
  {
    method: 'GET',
    pattern: '/v1/boom',
    handle: () => {
      throw new Error('a secret internal detail')
    }
  },
  {
    method: 'GET',
    pattern: '/v1/refused',
    handle: () => {
      throw new ControlPlaneHttpError(409, 'that conflicts')
    }
  }
]

let server: Server
let origin: string

beforeEach(async () => {
  const router = createControlPlaneRouter({
    routes: ROUTES,
    authenticate: (request) => readBearerToken(request) === TOKEN
  })
  server = createServer((request, response) => {
    void router(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(418).end('not mine')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function call(
  path: string,
  init: RequestInit & { token?: string | null } = {}
): Promise<{ status: number; body: unknown }> {
  const { token = TOKEN, ...rest } = init
  const response = await fetch(`${origin}${path}`, {
    ...rest,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(rest.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...rest.headers
    }
  })
  const text = await response.text()
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined }
}

describe('control plane routing', () => {
  it('serves a route and its parameterised form', async () => {
    expect(await call('/v1/things')).toEqual({ status: 200, body: { things: [] } })
    expect(await call('/v1/things/abc')).toEqual({ status: 200, body: { id: 'abc' } })
  })

  it('reads a JSON body on a write', async () => {
    const result = await call('/v1/things/abc', {
      method: 'PUT',
      body: JSON.stringify({ maxSpawns: 3 })
    })
    expect(result.body).toEqual({ params: { id: 'abc' }, body: { maxSpawns: 3 } })
  })

  it('decodes a percent-encoded path parameter', async () => {
    expect((await call('/v1/things/a%2Fb')).body).toEqual({ id: 'a/b' })
  })

  it('404s an unknown route and passes non-/v1 requests through', async () => {
    expect((await call('/v1/nope')).status).toBe(404)
    // The router reports "not mine" so the listener can still serve the web client.
    const passthrough = await fetch(`${origin}/web-index.html`)
    expect(passthrough.status).toBe(418)
  })

  // A known path with the wrong verb is a different problem from a missing one.
  it('405s a known path with the wrong method', async () => {
    expect((await call('/v1/things', { method: 'PUT', body: '{}' })).status).toBe(405)
  })

  it('reports a route-raised error with its own status', async () => {
    expect(await call('/v1/refused')).toEqual({ status: 409, body: { error: 'that conflicts' } })
  })

  // An unexpected throw is a bug, and its message is not the caller's business.
  it('does not leak internal detail from an unexpected throw', async () => {
    const result = await call('/v1/boom')
    expect(result).toEqual({ status: 500, body: { error: 'internal_error' } })
    expect(JSON.stringify(result.body)).not.toContain('secret')
  })

  it('refuses a body that is not JSON', async () => {
    expect((await call('/v1/things/abc', { method: 'PUT', body: 'not json' })).status).toBe(400)
  })
})

describe('control plane authentication', () => {
  it('rejects a missing, malformed or wrong token', async () => {
    expect((await call('/v1/things', { token: null })).status).toBe(401)
    expect((await call('/v1/things', { token: 'wrong' })).status).toBe(401)
    const raw = await fetch(`${origin}/v1/things`, { headers: { authorization: TOKEN } })
    expect(raw.status).toBe(401)
  })

  // Answering 404 vs 405 before checking the token would let an unauthenticated
  // caller map the surface by comparing responses.
  it('checks the token before routing, so an anonymous caller learns nothing', async () => {
    expect((await call('/v1/nope', { token: null })).status).toBe(401)
    expect((await call('/v1/things', { method: 'PUT', body: '{}', token: null })).status).toBe(401)
  })
})

describe('path classification', () => {
  it('claims /v1 and nothing else', () => {
    expect(isControlPlanePath('/v1')).toBe(true)
    expect(isControlPlanePath('/v1/tasks')).toBe(true)
    expect(isControlPlanePath('/web-index.html')).toBe(false)
    expect(isControlPlanePath('/assets/app.js')).toBe(false)
    // A path that merely starts with the same letters is not the control plane.
    expect(isControlPlanePath('/v1extra')).toBe(false)
  })
})
