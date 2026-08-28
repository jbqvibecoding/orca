// Composes the two things served over the pairing listener's HTTP side.
//
// Split from ws-transport.ts to keep that file within its line budget, and
// because "which handler answers this request" is its own decision, separate
// from binding, TLS and socket lifecycle.

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'

export type ControlPlaneHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<boolean>

/**
 * Control plane first, static client second: `/v1/*` is never a web asset, and
 * the static handler's allowlist would 404 it anyway. Returns undefined when
 * there is nothing to serve, which leaves the HTTP server without a listener —
 * the same as before either existed.
 */
export function composeHttpRequestListener(args: {
  controlPlane?: ControlPlaneHandler
  staticHandler?: RequestListener
}): RequestListener | undefined {
  const { controlPlane, staticHandler } = args
  if (!controlPlane) {
    return staticHandler
  }
  return (request, response) => {
    void controlPlane(request, response).then(
      (handled) => {
        if (handled) {
          return
        }
        if (staticHandler) {
          staticHandler(request, response)
          return
        }
        response.writeHead(404).end()
      },
      () => {
        // The control plane router answers its own errors; reaching here means
        // it threw outside them, which is a fault, not a routing outcome.
        if (!response.headersSent) {
          response.writeHead(500).end()
        }
      }
    )
  }
}
