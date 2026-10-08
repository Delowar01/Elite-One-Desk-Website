/**
 * A page's search and sharing metadata, read from the HTML a visitor gets
 * (Batch 25) — every tag `buildMetadata` writes, the way a crawler reads it.
 *
 * Next streams metadata for ordinary browsers, so the tags are looked for in
 * the whole document rather than inside `<head>` alone. Values are unescaped
 * the way an HTML parser would.
 */

export type Head = {
  status: number;
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  /** hreflang → address. */
  alternates: Record<string, string>;
  og: Record<string, string[]>;
  twitter: Record<string, string>;
  headers: Headers;
  html: string;
};

const decode = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string): string | null => {
  const found = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
  return found ? decode(found[1]!) : null;
};

/** Every `<meta …>` and `<link …>` tag in the document. */
const tags = (html: string, element: "meta" | "link") => html.match(new RegExp(`<${element}\\b[^>]*>`, "gi")) ?? [];

export function readHead(html: string, status = 200, headers = new Headers()): Head {
  const title = /<title>([^<]*)<\/title>/i.exec(html);
  const metas = tags(html, "meta");
  const links = tags(html, "link");
  const metaNamed = (name: string) => {
    const tag = metas.find((candidate) => attr(candidate, "name") === name);
    return tag ? attr(tag, "content") : null;
  };
  const og: Record<string, string[]> = {};
  const twitter: Record<string, string> = {};
  for (const tag of metas) {
    const property = attr(tag, "property");
    const content = attr(tag, "content");
    if (property?.startsWith("og:") && content !== null) (og[property] ??= []).push(content);
    const name = attr(tag, "name");
    if (name?.startsWith("twitter:") && content !== null) twitter[name] = content;
  }
  const alternates: Record<string, string> = {};
  let canonical: string | null = null;
  for (const tag of links) {
    const rel = attr(tag, "rel");
    if (rel === "canonical") canonical = attr(tag, "href");
    if (rel === "alternate") {
      const lang = attr(tag, "hreflang") ?? attr(tag, "hrefLang");
      const href = attr(tag, "href");
      if (lang && href) alternates[lang] = href;
    }
  }
  return {
    status,
    title: title ? decode(title[1]!) : null,
    description: metaNamed("description"),
    canonical,
    robots: metaNamed("robots"),
    alternates,
    og,
    twitter,
    headers,
    html,
  };
}

/** One page's head, as an anonymous visitor (or the given cookie) receives it. */
export async function fetchHead(origin: string, path: string, cookie?: string): Promise<Head> {
  const response = await fetch(`${origin}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return readHead(await response.text(), response.status, response.headers);
}

/** The JSON-LD nodes a page carries. */
export function jsonLdOf(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const match of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const parsed = JSON.parse(match[1]!.replace(/\\u003c/g, "<")) as unknown;
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) out.push(node as Record<string, unknown>);
  }
  return out;
}
