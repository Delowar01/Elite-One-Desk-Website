/**
 * Asking for a page's React Server Components payload the way the client
 * router asks for it.
 *
 * Next 16 answers an RSC request only at the address the router would use:
 * `_rsc` carries a digest of the router's own request headers, so a cache that
 * ignores `Vary` cannot hand one router's payload to another, and any other
 * request is answered with a 307 to that address before anything renders. A
 * test that sent `RSC: 1` alone would be measuring the redirect, not the page —
 * and on a public page it never gets past it: with no router header the digest
 * is empty, the bare `?_rsc` that stands for it does not survive the
 * middleware's rewrite to `/en/…`, and the redirect is answered with another.
 * The router itself never sends a bare request; every navigation carries
 * `Next-Router-State-Tree` and `Next-Url` (docs/release/next16-qualification-batch-27.md).
 *
 * So this sends `Next-Url` as the router does — the internal address of the
 * page the visitor is on, `/en` for Home — and leaves out the state tree, which
 * would trim the answer to what that page lacks. The server answers with the
 * whole page, the payload a bare request received before Next 16; `Next-Url`
 * only picks between intercepting routes, and this site has none. `_rsc` is
 * set by Next's own function, the one the router runs, over the same headers.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { REPO_ROOT } from "./env";

type SetDigest = (url: URL, headers: Record<string, string>) => Promise<void>;

let setDigest: SetDigest | null = null;

/** The address and headers of a router's request for `url`'s payload, made from the page at `from`. */
export async function rscRequest(url: string, from = "/en"): Promise<{ url: string; headers: Record<string, string> }> {
  setDigest ??= (
    createRequire(path.join(REPO_ROOT, "package.json"))(
      "next/dist/client/components/router-reducer/set-cache-busting-search-param.js",
    ) as { setCacheBustingSearchParam: SetDigest }
  ).setCacheBustingSearchParam;
  const headers = { rsc: "1", "next-url": from };
  const address = new URL(url);
  await setDigest(address, headers);
  return { url: address.toString(), headers };
}
