/**
 * Whether a `robots.txt` lets a crawler fetch a path — RFC 9309, the way
 * Google and X read it (Batch 26).
 *
 * The groups whose `User-agent` names the crawler's product token are its
 * rules, else the `*` groups; of those rules, the one whose pattern is longest
 * among those that match wins, and an `Allow` wins a tie. `*` stands for any
 * run of characters and a final `$` anchors the end; otherwise a pattern
 * matches a prefix. An empty `Disallow` forbids nothing, and a path no rule
 * matches may be fetched.
 *
 * A test asks this of the `robots.txt` the server actually answers with and
 * the address a page actually names, so neither is ever restated by hand.
 */

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[] };

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let collectingAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      // Consecutive user-agent lines share one group; one after a rule starts the next.
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }
    collectingAgents = false;
    if (!current || (key !== "allow" && key !== "disallow")) continue;
    if (key === "disallow" && value === "") continue;
    current.rules.push({ allow: key === "allow", pattern: value });
  }
  return groups;
}

const escape = (part: string) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  return new RegExp(`^${body.split("*").map(escape).join(".*")}${anchored ? "$" : ""}`).test(path);
}

/** The rule that decides `path` for `agent`, or null when none matches (allowed). */
export function decidingRule(text: string, agent: string, path: string): Rule | null {
  const groups = parseRobots(text);
  const token = agent.toLowerCase();
  let chosen = groups.filter((group) => group.agents.includes(token));
  if (!chosen.length) chosen = groups.filter((group) => group.agents.includes("*"));
  let best: Rule | null = null;
  for (const rule of chosen.flatMap((group) => group.rules)) {
    if (!matches(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best;
}

export function robotsAllows(text: string, agent: string, path: string): boolean {
  return decidingRule(text, agent, path)?.allow ?? true;
}
