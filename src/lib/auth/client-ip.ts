/**
 * The visitor's address, as the server in front of this one saw it.
 *
 * nginx (`deploy/nginx.conf`) sets `X-Real-IP` to `$remote_addr` and *appends*
 * `$remote_addr` to whatever `X-Forwarded-For` the client sent. The first
 * `X-Forwarded-For` hop is therefore whatever the client chose to write: a
 * throttle keyed on it can be dodged by changing it, and an audit hash built
 * from it can be forged. `X-Real-IP`, and the last hop, are the proxy's own
 * word. With neither header — development, the test server — there is no
 * address, as before (19B).
 *
 * A plain function of the headers, so the rule is testable without a request.
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const hops = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.at(-1) ?? "";
}
