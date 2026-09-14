/**
 * Calling a Server Action the way the browser calls it.
 *
 * `helpers/http.ts` covers the actions that live on a rendered `<form>`: React
 * writes the action reference into the markup for the no-JavaScript path, and
 * replaying those fields is that path. An action a client component calls
 * directly has no form to replay — the Visual Editor's do not, because the
 * inspector is a panel, not a page — so this is the other half of the same
 * idea: the request a browser actually sends.
 *
 * Three real pieces, none of them invented here:
 *
 *  · the action id, read from the build's own `server-reference-manifest.json`
 *    by file and export name, so a renamed action fails loudly rather than
 *    testing nothing;
 *  · the body, produced by React's own `encodeReply` — the function the browser
 *    runs — so the wire format is whatever React says it is today;
 *  · the `Next-Action` header, the session cookie and the origin, exactly as
 *    the browser sends them, through the same route and the same CSRF check.
 *
 * No test-only endpoint exists, and nothing is mocked in between.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { REPO_ROOT } from "./env";

type Reference = { filename: string; exportedName: string };

const MANIFEST = path.join(REPO_ROOT, ".next", "server", "server-reference-manifest.json");

let ids: Map<string, string> | null = null;

/** `<file>#<export>` → action id, from the build the tests are running. */
function actionId(file: string, exported: string): string {
  if (!ids) {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      node: Record<string, Reference>;
    };
    ids = new Map();
    for (const [id, entry] of Object.entries(manifest.node)) {
      ids.set(`${entry.filename}#${entry.exportedName}`, id);
    }
  }
  const id = ids.get(`${file}#${exported}`);
  if (!id) throw new Error(`no server action ${exported} in ${file} — was it renamed?`);
  return id;
}

type Encode = (args: unknown[]) => Promise<FormData | string>;
let encode: Encode | null = null;

function encoder(): Encode {
  if (encode) return encode;
  // The browser build reaches for webpack's chunk loader when it is imported.
  // A stub satisfies that: nothing here loads a chunk, it only encodes
  // arguments.
  const globals = globalThis as Record<string, unknown>;
  globals.__webpack_require__ ??= { u: () => "", f: {}, e: () => Promise.resolve() };
  const require = createRequire(path.join(REPO_ROOT, "package.json"));
  const flight = require("next/dist/compiled/react-server-dom-webpack/client.browser.js") as {
    encodeReply: Encode;
  };
  encode = flight.encodeReply;
  return encode;
}

/**
 * The value the action returned, lifted out of the flight response.
 *
 * The response is a stream of rows, `<hex id>:<payload>`. Two shapes matter
 * here: an ordinary row is one line of JSON, and a long string is its own row,
 * `<id>:T<hex byte length>,<the bytes>` — which is why this reads bytes rather
 * than lines. A body long enough to be hoisted into a text row is exactly the
 * content worth asserting about, so a line-based reader would miss the cases
 * that matter and look like it was working.
 *
 * Row `0` is the model; its `a` names the action's result by reference. The
 * references inside that value are resolved against the other rows, and `$$x`
 * is an escaped literal `$`. Plain data only: a result carrying an element, a
 * stream or a Promise comes back as a reference this does not follow, and the
 * caller is told the action returned nothing rather than handed half of it.
 */
const COLON = 0x3a;
const COMMA = 0x2c;
const NEWLINE = 0x0a;
const TEXT_ROW = 0x54; // "T"

function flightRows(payload: Buffer): Map<string, unknown> {
  const rows = new Map<string, unknown>();
  let at = 0;
  while (at < payload.length) {
    const colon = payload.indexOf(COLON, at);
    if (colon < 0) break;
    const id = payload.toString("utf8", at, colon);
    const body = colon + 1;

    if (payload[body] === TEXT_ROW) {
      const comma = payload.indexOf(COMMA, body + 1);
      if (comma < 0) break;
      const length = Number.parseInt(payload.toString("utf8", body + 1, comma), 16);
      if (!Number.isFinite(length)) break;
      const start = comma + 1;
      rows.set(id, payload.toString("utf8", start, start + length));
      at = start + length;
      if (payload[at] === NEWLINE) at += 1;
      continue;
    }

    const newline = payload.indexOf(NEWLINE, body);
    const end = newline < 0 ? payload.length : newline;
    const raw = payload.toString("utf8", body, end);
    try {
      rows.set(id, JSON.parse(raw));
    } catch {
      // A module, hint or suspense row. Kept raw so a reference to it is
      // visible as such rather than silently becoming null.
      rows.set(id, raw);
    }
    at = end + 1;
  }
  return rows;
}

const MAX_DEPTH = 24;

function resolveRefs(value: unknown, rows: Map<string, unknown>, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    if (value.startsWith("$$")) return value.slice(1);
    if (value.startsWith("$")) {
      const ref = value.slice(1);
      if (/^[0-9a-f]+$/.test(ref) && rows.has(ref)) {
        return resolveRefs(rows.get(ref), rows, depth + 1);
      }
      return value;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, rows, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveRefs(entry, rows, depth + 1);
    return out;
  }
  return value;
}

export function actionResult<T>(payload: Buffer): T | null {
  const rows = flightRows(payload);
  const root = rows.get("0") as { a?: unknown } | undefined;
  const pointer = typeof root?.a === "string" ? /^\$@([0-9a-f]+)$/.exec(root.a)?.[1] : undefined;
  if (pointer === undefined || !rows.has(pointer)) return null;
  return resolveRefs(rows.get(pointer), rows) as T;
}

export type ActionResponse<T> = { status: number; value: T | null; text: string };

export async function callAction<T>(options: {
  origin: string;
  /** The route the panel is on — a Server Action is posted to its own page. */
  route: string;
  file: string;
  action: string;
  args: unknown[];
  cookie?: string;
}): Promise<ActionResponse<T>> {
  const body = await encoder()(options.args);
  const headers: Record<string, string> = {
    "Next-Action": actionId(options.file, options.action),
    origin: options.origin,
  };
  if (options.cookie) headers.cookie = options.cookie;
  // A FormData body carries its own multipart boundary; a plain-argument call
  // encodes to a string and has to say so.
  if (typeof body === "string") headers["content-type"] = "text/plain;charset=UTF-8";

  const response = await fetch(`${options.origin}${options.route}`, {
    method: "POST",
    headers,
    body: body as BodyInit,
    redirect: "manual",
  });
  const payload = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    value: actionResult<T>(payload),
    text: payload.toString("utf8"),
  };
}
