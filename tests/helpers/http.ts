/**
 * Talking to the running site the way a browser without JavaScript does.
 *
 * Server Actions are reachable that way on purpose: React renders the action
 * reference into the form as hidden fields so a submit works before hydration.
 * Replaying those fields is therefore not a trick — it is the documented
 * no-JavaScript path, through the same route, the same session cookie and the
 * same CSRF check an editor's click goes through. No browser is needed to prove
 * a button works, and no test-only endpoint has to exist for one.
 */

export type Page = { status: number; location: string | null; html: string };

const unescape = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

export async function get(
  origin: string,
  path: string,
  options: { cookie?: string; follow?: boolean } = {},
): Promise<Page> {
  const response = await fetch(`${origin}${path}`, {
    headers: options.cookie ? { cookie: options.cookie } : {},
    redirect: options.follow ? "follow" : "manual",
  });
  // Text, XML and JSON all come back as a string; anything else is drained so
  // the connection is not left open. A sitemap is application/xml, which the
  // earlier `text/` test missed entirely.
  const type = response.headers.get("content-type") ?? "";
  const readable = /text\/|xml|json/.test(type);
  const html = readable ? await response.text() : "";
  if (!readable) await response.arrayBuffer().catch(() => undefined);
  return { status: response.status, location: response.headers.get("location"), html };
}

/** Every `<form>` on a page, as raw markup. */
export const formsOn = (html: string): string[] =>
  [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((match) => match[0]);

/** Every `<input>`, `<textarea>` and `<select>` a form declares is replayed, so
 * a round trip through the panel is the real thing rather than a partial one —
 * including the list editors, which serialise into a hidden field on the server
 * as well as in the browser.
 */

/** The one form whose markup contains `label` — usually its button's text. */
export function formContaining(html: string, label: string): string {
  const form = formsOn(html).find((candidate) => candidate.includes(label));
  if (!form) throw new Error(`no form on the page contains “${label}”`);
  return form;
}

/**
 * Submits a rendered form back to `action` (or the page it came from), carrying
 * every `<input>` it declares — the action reference React wrote for the no-JS
 * path, the CSRF token, and any values.
 */
export async function submitForm(
  origin: string,
  pageUrl: string,
  formHtml: string,
  cookie: string,
  overrides: Record<string, string> = {},
): Promise<Page> {
  const body = new FormData();
  for (const tag of formHtml.matchAll(/<input\b[^>]*>/g)) {
    const input = tag[0];
    const name = /\bname="([^"]*)"/.exec(input)?.[1];
    if (!name) continue;
    const type = /\btype="([^"]*)"/.exec(input)?.[1] ?? "text";
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/.test(input)) continue;
    const value = /\bvalue="([^"]*)"/.exec(input)?.[1] ?? (type === "checkbox" ? "on" : "");
    body.set(name, unescape(value));
  }
  for (const area of formHtml.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const name = /\bname="([^"]*)"/.exec(area[1]!)?.[1];
    if (name) body.set(name, unescape(area[2]!));
  }
  for (const select of formHtml.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = /\bname="([^"]*)"/.exec(select[1]!)?.[1];
    if (!name) continue;
    const options = [...select[2]!.matchAll(/<option\b([^>]*)>/g)].map((option) => option[1]!);
    const chosen = options.find((option) => /\bselected\b/.test(option)) ?? options[0] ?? "";
    body.set(name, unescape(/\bvalue="([^"]*)"/.exec(chosen)?.[1] ?? ""));
  }
  for (const [key, value] of Object.entries(overrides)) body.set(key, value);

  const target = /\baction="([^"]*)"/.exec(formHtml)?.[1];
  const url = target && !target.startsWith("$") ? `${origin}${unescape(target)}` : `${origin}${pageUrl}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { cookie, origin },
    body,
    redirect: "manual",
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
  };
}
