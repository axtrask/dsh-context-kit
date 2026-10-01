/**
 * The panel's HTTP channel, owned by the panel.
 *
 * ## Why this module exists instead of `connection.rpc.handle`
 *
 * `connection.rpc.handle(channel, handler)` looks like the right seam, and it is
 * unusable from a plugin row. Its registration ends with
 * `owner.effect(() => owner.webServer.register(route))`
 * (`dsh-client-connection/lib/index.js:540-546`, `:618`), and the owner has to
 * answer BOTH `effect` and `webServer` from the very same scope:
 *
 * - the loader entry's own context (`lib/edit-host.js`) answers `effect`, but the
 *   route registration resolves `webServer` through the connection and gets
 *   `cannot get property "webServer" without inject`;
 * - the injected scope answers `webServer`, but not `effect`;
 * - the connection's own context answers neither — `cannot get property "register"
 *   without inject` — because `get('webServer')` on a context that does not
 *   publish the service throws instead of returning `undefined`;
 * - a hand-built owner object does not survive it either: cordis's traceable
 *   wrapper re-reads through the registration's own context, so the third failure
 *   comes back verbatim.
 *
 * Every one of those was a real boot failure, not a hypothesis. So the panel does
 * what the shipped GUI's own fetch routes do — `webServer.register` with a
 * `kind: "prefix"` route — and speaks the same protocol on the other side, built
 * from the schemas the connection package DOES export
 * (`clientRequestSchema`, `serverResponseSchema`).
 *
 * ## The protocol
 *
 * `POST <channel>/<method>` with `content-type: application/json`:
 *
 * ```json
 * { "type": "client-request", "rpcId": "1", "method": "<method>", "payload": { … } }
 * ```
 *
 * answered with
 *
 * ```json
 * { "type": "server-response", "rpcId": "1", "result": { "ok": true, "value": { … } } }
 * ```
 *
 * A handler that throws is reported to the caller as `ok: false` with the message,
 * and the HTTP status stays 200 so the panel can show the refusal instead of a
 * network error. Bodies are capped, and a request-role check rejects anything that
 * does not look like a same-origin browser POST.
 *
 * @module dsh-context-kit/edit-route
 */

import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';

/** A commit carries two texts (replacement and expected); keep their combined body bounded. */
const MAX_BODY_BYTES = 128 * 1024;

/** Segment shape the connection's own `endpointFromPath` accepts. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/u;

/**
 * Build the index-independent HTTP handler for one channel.
 *
 * @param channel - the channel path, e.g. `/ctxkit.edit`.
 * @param handler - `(method, payload) => value`.
 * @returns a node-style `(req, res) => Promise<void>` handler.
 */
export function createChannelHandler(channel, handler) {
  const prefix = `${channel}/`;
  return async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) {
      send(response, 404, 'not found');
      return;
    }
    const method = pathname.slice(prefix.length);
    if (method.length === 0 || method.split('/').some((segment) => segment === '' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
      send(response, 404, 'not found');
      return;
    }
    if (request.method !== 'POST') {
      send(response, 405, 'method not allowed');
      return;
    }
    if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      send(response, 415, 'content type must be application/json');
      return;
    }

    let raw = '';
    try {
      raw = await readBody(request);
    } catch (error) {
      send(response, 413, String(error?.message ?? error));
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(response, 400, 'body is not JSON');
      return;
    }
    const envelope = clientRequestSchema.safeParse(parsed);
    if (!envelope.success) {
      sendJson(response, 200, {
        type: 'server-response',
        rpcId: typeof parsed?.rpcId === 'string' ? parsed.rpcId : 'invalid',
        result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message' } }
      });
      return;
    }
    const message = envelope.data;
    if (message.method !== method) {
      sendJson(response, 200, {
        type: 'server-response',
        rpcId: message.rpcId,
        result: {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(method)}`
          }
        }
      });
      return;
    }

    try {
      const value = await handler(method, message.payload);
      sendJson(response, 200, { type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } });
    } catch (error) {
      // A refusal is content, not a transport failure: the panel shows the reason.
      sendJson(response, 200, {
        type: 'server-response',
        rpcId: message.rpcId,
        result: { ok: false, error: { code: 'context-kit/refused', message: String(error?.message ?? error) } }
      });
    }
  };
}

/**
 * Read a request body, refusing anything over the cap.
 *
 * @param request - the node request.
 * @returns the body as text.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body larger than ${String(MAX_BODY_BYTES)} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Answer with plain text.
 *
 * @param response - the node response.
 * @param status - HTTP status.
 * @param text - body.
 */
function send(response, status, text) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

/**
 * Answer with JSON.
 *
 * @param response - the node response.
 * @param status - HTTP status.
 * @param body - the body, serialized as-is.
 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}
