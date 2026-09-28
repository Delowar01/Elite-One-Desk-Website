import { getBlock, type BlockDef, type FieldDef } from "../blocks";
import { blockKindOf, kindDef } from "./kinds";

/**
 * How a page section refers to a reusable component (Batch 17).
 *
 * ## Where the reference lives, and why there is no instances table
 *
 * Inside the section's own content document, under one reserved key:
 *
 *     _reuse: { primaryCta: { c: 12 }, cta: { c: 7, o: ["ctaLabel.ar"] } }
 *
 * A section's content already has a draft and a published form, already goes
 * through a guarded save, a publication, a discard, a restore point, a restore,
 * a duplicate, the page Undo history and Version Compare. A reference stored
 * *in* that document rides every one of those for free and stays exactly as
 * consistent with the rest of the section as the section's own text is — the
 * published reference is promoted with the published text, in the same write,
 * or not at all. A separate `instances` table would be a second authority over
 * the same fact, and every one of those paths would have to be taught to keep
 * the two in step. The relation is still exact and still queryable:
 * `page_sections_reuse_idx` holds the few rows that carry the key, and
 * `lib/cms/reuse/usage.ts` derives usage from them.
 *
 * ## The shape
 *
 *   · **slot** — what the reference fills. `block` is the whole section (for
 *     the block types in `REUSABLE_BLOCK_TYPES`); otherwise a call-to-action
 *     stem of the block (`primaryCta`, `secondaryCta`, `cta`), which covers the
 *     pair `<stem>Label` / `<stem>Href`. A whole-block reference excludes the
 *     CTA slots: it already supplies them.
 *   · **`c`** — the component's id. The only identity: never its name, never a
 *     position, never a selector.
 *   · **`o`** — which of the covered fields this page overrides, as sorted
 *     keys: `primaryCtaLabel.ar` for one edition of a localised field,
 *     `primaryCtaHref` for a plain one. Sparse: absent means "inherit it all".
 *   · **`v`** — in a page *snapshot* only: the component version the page was
 *     showing when the snapshot was taken. Never in a draft or a live row.
 *
 * ## Where the override values are
 *
 * In the section's own declared fields. An overridden key's value is simply the
 * section's value for that field and edition, validated by the ordinary block
 * validator — so there is no second validator for overrides and no second
 * place a CTA's text can be. The reference only says *which* keys are local.
 *
 * The covered fields that are **not** overridden hold a fallback: a copy of the
 * component's content, made when the section was linked. It is drawn only when
 * the component cannot be (a component that has gone, which the delete guard
 * prevents; or an older build after a rollback, which cannot read `_reuse` and
 * draws the section's own fields). It is never the normal representation.
 */

export const REUSE_KEY = "_reuse";
export const BLOCK_SLOT = "block";

/** The largest id a Postgres `serial` can hold. */
const MAX_ID = 2_147_483_647;

export type SlotRef = { c: number; o?: string[] };
/** A reference as a page snapshot keeps it: with the version it was showing. */
export type PinnedSlotRef = SlotRef & { v?: number };
export type ReuseMap = Record<string, PinnedSlotRef>;

export type SlotDef = {
  slot: string;
  /** The component kind this slot accepts. */
  kind: string;
  /** What an editor calls the slot: "Primary call to action", "Whole section". */
  label: string;
  /** The section fields the slot covers, in registry order. */
  fields: FieldDef[];
  /** Section field name → the component's field name. */
  componentField: Record<string, string>;
  /** Every key the slot may override. */
  overridable: string[];
};

type Values = Record<string, unknown>;

const isRecord = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_ID;

const CTA_LABEL = /^([a-z]+Cta|cta)Label$/;

/** Only text a person types is overridable: never a picture, a choice, a switch or rich text. */
const OVERRIDABLE_TYPES = new Set(["text", "textarea", "link"]);

function overrideKeysFor(fields: readonly FieldDef[]): string[] {
  const out: string[] = [];
  for (const field of fields) {
    if (!OVERRIDABLE_TYPES.has(field.type)) continue;
    if (field.localised) out.push(`${field.name}.en`, `${field.name}.ar`);
    else out.push(field.name);
  }
  return out.sort();
}

function ctaSlots(block: BlockDef): SlotDef[] {
  const out: SlotDef[] = [];
  for (const field of block.fields) {
    const match = CTA_LABEL.exec(field.name);
    if (!match || field.type !== "text" || !field.localised) continue;
    const stem = match[1]!;
    const href = block.fields.find((candidate) => candidate.name === `${stem}Href` && candidate.type === "link");
    if (!href) continue;
    const prefix = field.label.replace(/\s+—\s+button text$/, "").trim();
    const label = stem === "cta" || /^call to action$/i.test(prefix) ? "Call to action" : `${prefix} call to action`;
    const fields = [field, href];
    out.push({
      slot: stem,
      kind: "cta",
      label,
      fields,
      componentField: { [field.name]: "label", [href.name]: "href" },
      overridable: overrideKeysFor(fields),
    });
  }
  return out;
}

const SLOT_CACHE = new Map<string, SlotDef[]>();

/**
 * Every slot a block type has: its call-to-action stems, and the whole section
 * when the type may be shared as a block. Derived from the registry — the
 * `<stem>Label` / `<stem>Href` pairs `ctaFields` declares — so a block that
 * gains a call to action gains a slot with no change here.
 */
export function slotsOf(blockType: string): SlotDef[] {
  const cached = SLOT_CACHE.get(blockType);
  if (cached) return cached;
  const block = getBlock(blockType);
  if (!block) return [];
  const out = ctaSlots(block);
  const whole = blockKindOf(blockType);
  if (whole) {
    out.push({
      slot: BLOCK_SLOT,
      kind: whole,
      label: "Whole section",
      fields: [...block.fields],
      componentField: Object.fromEntries(block.fields.map((field) => [field.name, field.name])),
      overridable: overrideKeysFor(block.fields),
    });
  }
  SLOT_CACHE.set(blockType, out);
  return out;
}

export const slotDef = (blockType: string, slot: string): SlotDef | null =>
  slotsOf(blockType).find((entry) => entry.slot === slot) ?? null;

/* -------------------------------------------------------------------------- */
/* Reading and writing the reference                                          */
/* -------------------------------------------------------------------------- */

function readEntry(slot: SlotDef, raw: unknown, pins: boolean): PinnedSlotRef | null {
  if (!isRecord(raw) || !isId(raw.c)) return null;
  const entry: PinnedSlotRef = { c: raw.c };
  if (Array.isArray(raw.o)) {
    const allowed = new Set(slot.overridable);
    const keys = [...new Set(raw.o.filter((key): key is string => typeof key === "string" && allowed.has(key)))].sort();
    if (keys.length) entry.o = keys;
  }
  if (pins && isId(raw.v)) entry.v = raw.v;
  return entry;
}

/**
 * The references a section's values carry, tolerantly: an entry this build
 * cannot read is dropped, and the section then draws its own fields. For
 * reading and rendering — never for deciding what a save may store; that is
 * `parseReuse`.
 */
export function readReuse(values: unknown, blockType: string, options: { pins?: boolean } = {}): ReuseMap {
  if (!isRecord(values)) return {};
  const raw = values[REUSE_KEY];
  if (!isRecord(raw)) return {};
  const out: ReuseMap = {};
  for (const slot of slotsOf(blockType)) {
    if (!(slot.slot in raw)) continue;
    const entry = readEntry(slot, raw[slot.slot], options.pins === true);
    if (entry) out[slot.slot] = entry;
  }
  // A whole-block reference supplies the calls to action too; a stray CTA
  // reference beside it would be a second answer for the same fields.
  if (out[BLOCK_SLOT]) return { [BLOCK_SLOT]: out[BLOCK_SLOT]! };
  return out;
}

export type ParsedReuse = { ok: true; map: ReuseMap } | { ok: false };

/**
 * The strict reading, for a save.
 *
 * A save that carries a reference this build cannot read is refused rather
 * than cleaned: dropping an unreadable entry would silently unlink a section,
 * which is a change nobody asked for. Pins (`v`) are refused too — they are a
 * snapshot's, and a draft that claims one is not something this editor wrote.
 */
export function parseReuse(raw: unknown, blockType: string): ParsedReuse {
  if (raw === undefined || raw === null) return { ok: true, map: {} };
  if (!isRecord(raw)) return { ok: false };
  const slots = new Map(slotsOf(blockType).map((slot) => [slot.slot, slot]));
  const out: ReuseMap = {};
  for (const [key, entry] of Object.entries(raw)) {
    const slot = slots.get(key);
    if (!slot || !isRecord(entry)) return { ok: false };
    if (Object.keys(entry).some((name) => name !== "c" && name !== "o")) return { ok: false };
    if (!isId(entry.c)) return { ok: false };
    if (entry.o !== undefined) {
      if (!Array.isArray(entry.o)) return { ok: false };
      const allowed = new Set(slot.overridable);
      if (entry.o.some((name) => typeof name !== "string" || !allowed.has(name))) return { ok: false };
      if (new Set(entry.o).size !== entry.o.length) return { ok: false };
    }
    const keys = Array.isArray(entry.o) ? [...(entry.o as string[])].sort() : [];
    out[key] = keys.length ? { c: entry.c, o: keys } : { c: entry.c };
  }
  if (out[BLOCK_SLOT] && Object.keys(out).length > 1) return { ok: false };
  return { ok: true, map: out };
}

/** The same map in one canonical form: slots in order, overrides sorted, nothing empty. */
function canonical(map: ReuseMap): ReuseMap {
  const out: ReuseMap = {};
  for (const slot of Object.keys(map).sort()) {
    const entry = map[slot]!;
    const next: PinnedSlotRef = { c: entry.c };
    if (entry.o?.length) next.o = [...new Set(entry.o)].sort();
    if (entry.v !== undefined) next.v = entry.v;
    out[slot] = next;
  }
  return out;
}

/** Values with the map written in, or the key removed when there is nothing to write. */
export function withReuse(values: Values, map: ReuseMap): Values {
  const out: Values = { ...values };
  delete out[REUSE_KEY];
  if (Object.keys(map).length) out[REUSE_KEY] = canonical(map);
  return out;
}

/** The values a renderer, a form or a public page may see: no reference at all. */
export function stripReuse(values: Values): Values {
  if (!isRecord(values) || !(REUSE_KEY in values)) return values;
  const out: Values = { ...values };
  delete out[REUSE_KEY];
  return out;
}

/**
 * A snapshot's reference with its pins taken off — what a restore writes back.
 *
 * A restored section follows its component again from the moment it is
 * restored; the version it was showing then is history, and history is the
 * component's own to put back.
 */
export function unpinReuse(values: Values, blockType: string): Values {
  if (!isRecord(values) || !(REUSE_KEY in values)) return values;
  // Read without pins, so the map written back has none.
  return withReuse(values, readReuse(values, blockType));
}

/** Every component a section's values refer to. */
export const referencedIds = (values: unknown, blockType: string): number[] => [
  ...new Set(Object.values(readReuse(values, blockType)).map((entry) => entry.c)),
];

/* -------------------------------------------------------------------------- */
/* Resolving                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A component as a resolver sees it: its kind, the values this render should
 * use — published ones for the site and for a page's preview, the draft in the
 * component's own preview — and the version those values are.
 */
export type ComponentSource = {
  id: number;
  kind: string;
  /** `null` for a component that has never been published (outside its own preview). */
  values: Values | null;
  version: number;
};

export type InstanceState = "linked" | "unavailable";

/** What the editor is told about one reference. Never sent to a public page. */
export type InstanceView = {
  slot: string;
  kind: string;
  componentId: number;
  overrides: string[];
  state: InstanceState;
  /** Why an unavailable reference is drawn from its fallback. */
  reason?: "missing" | "kind" | "unpublished";
  /** The component version drawn, when one is. */
  version: number | null;
};

const localisedOf = (value: unknown): { en: string; ar: string } => {
  const source = isRecord(value) ? value : {};
  return {
    en: typeof source.en === "string" ? source.en : "",
    ar: typeof source.ar === "string" ? source.ar : "",
  };
};

/**
 * The covered fields as they should be drawn: each overridden key from the
 * section, every other key from the component, and — when there is no
 * component to read — every key from the section's own fallback.
 */
export function effectiveSlotValues(
  slot: SlotDef,
  local: Values,
  component: Values | null,
  overrides: readonly string[] = [],
): Values {
  const local_ = new Set(overrides);
  const out: Values = {};
  for (const field of slot.fields) {
    const own = local[field.name];
    if (!component) {
      out[field.name] = own;
      continue;
    }
    const theirs = component[slot.componentField[field.name]!];
    if (field.localised && OVERRIDABLE_TYPES.has(field.type)) {
      const mine = localisedOf(own);
      const shared = localisedOf(theirs);
      out[field.name] = {
        en: local_.has(`${field.name}.en`) ? mine.en : shared.en,
        ar: local_.has(`${field.name}.ar`) ? mine.ar : shared.ar,
      };
      continue;
    }
    if (OVERRIDABLE_TYPES.has(field.type) && local_.has(field.name)) {
      out[field.name] = own;
      continue;
    }
    out[field.name] = theirs === undefined ? own : theirs;
  }
  return out;
}

/** Whether a component source can be drawn in this slot, and if not, why not. */
function availability(slot: SlotDef, source: ComponentSource | undefined): InstanceView["reason"] | null {
  if (!source) return "missing";
  if (source.kind !== slot.kind) return "kind";
  if (!source.values) return "unpublished";
  return null;
}

/**
 * The one resolver every scope uses — the public page, a page's preview and
 * canvas, a component's own preview, detaching and snapshot capture differ
 * only in which values `lookup` hands back.
 *
 * Returns the values to draw, with the reference removed so no renderer and no
 * public payload ever carries it, and one view per reference for the editor.
 * An unavailable component never throws and never blanks the section: it is
 * drawn from its fallback, and the editor is told.
 */
export function resolveReuse(
  blockType: string,
  values: Values,
  lookup: (id: number) => ComponentSource | undefined,
): { values: Values; instances: InstanceView[] } {
  const map = readReuse(values, blockType);
  const out = stripReuse(values);
  const slots = Object.keys(map);
  if (!slots.length) return { values: out, instances: [] };

  const resolved: Values = { ...out };
  const instances: InstanceView[] = [];
  for (const slotName of slots) {
    const slot = slotDef(blockType, slotName);
    const ref = map[slotName]!;
    if (!slot) continue;
    const source = lookup(ref.c);
    const reason = availability(slot, source);
    Object.assign(resolved, effectiveSlotValues(slot, values, reason ? null : source!.values, ref.o));
    instances.push({
      slot: slotName,
      kind: slot.kind,
      componentId: ref.c,
      overrides: ref.o ?? [],
      state: reason ? "unavailable" : "linked",
      ...(reason ? { reason } : {}),
      version: reason ? null : source!.version,
    });
  }
  return { values: resolved, instances };
}

/**
 * A live section's values as a page snapshot keeps them: the content visitors
 * saw in the section's own fields, and the reference pinned to the version that
 * content was. Exact history without depending on the component's own history
 * being retained — and an older build that cannot read the reference restores
 * the right words anyway.
 */
export function pinReuse(
  blockType: string,
  values: Values,
  lookup: (id: number) => ComponentSource | undefined,
): Values {
  const map = readReuse(values, blockType);
  if (!Object.keys(map).length) return values;
  const { values: resolved, instances } = resolveReuse(blockType, values, lookup);
  const pinned: ReuseMap = {};
  for (const [slot, ref] of Object.entries(map)) {
    const view = instances.find((instance) => instance.slot === slot);
    pinned[slot] = view?.version ? { ...ref, v: view.version } : { ...ref };
  }
  return withReuse(resolved, pinned);
}

/* -------------------------------------------------------------------------- */
/* Instance edits — pure, shared by the editor and the server                 */
/* -------------------------------------------------------------------------- */

/** Said wherever the whole section is refused for a call to action linked on its own. */
export const WHOLE_BLOCK_REFUSAL =
  "Detach the reusable CTA links in this section before making the whole section reusable.";

/**
 * Whether a call to action in this section is linked on its own — which rules
 * out making the whole section reusable, or linking it to a reusable block.
 *
 * That CTA's fields hold only the copy kept when it was linked, while the page
 * shows the component's current version: a whole-section component made from
 * them would bake the stale copy in, and a whole-section link laid over them
 * would drop the CTA's link without anyone asking. Reusable components do not
 * nest, so the CTA link is detached first — detaching writes what the page
 * shows into those fields.
 */
export const hasSeparateLinks = (blockType: string, values: unknown): boolean =>
  Object.keys(readReuse(values, blockType)).some((slot) => slot !== BLOCK_SLOT);

/**
 * Links one slot to a component.
 *
 * The covered fields take a copy of the component's published content as their
 * fallback, and every override is cleared: a fresh link inherits everything.
 * `null` when the slot does not exist or the kind does not fit it — and for
 * the whole block while a call to action in it is linked on its own
 * (`hasSeparateLinks`), rather than dropping that link.
 */
export function linkSlot(
  blockType: string,
  values: Values,
  slotName: string,
  component: { id: number; kind: string; values: Values },
): Values | null {
  const slot = slotDef(blockType, slotName);
  if (!slot || slot.kind !== component.kind || !isId(component.id)) return null;
  const map = readReuse(values, blockType);
  if (slotName !== BLOCK_SLOT && map[BLOCK_SLOT]) return null;
  if (slotName === BLOCK_SLOT && hasSeparateLinks(blockType, values)) return null;
  const next: ReuseMap = slotName === BLOCK_SLOT ? {} : { ...map };
  next[slotName] = { c: component.id };
  const copied = effectiveSlotValues(slot, values, component.values, []);
  return withReuse({ ...values, ...copied }, next);
}

/**
 * Turns one override on or off.
 *
 * On: the key becomes local, starting from `value` — what the page was showing,
 * so switching an override on changes nothing visible until somebody types.
 * Off (Reset override): the key inherits again, and its fallback is refreshed
 * to `value` — the component's current text — so the section's own fields
 * never keep a stale override as their fallback.
 */
export function setOverride(
  blockType: string,
  values: Values,
  slotName: string,
  key: string,
  on: boolean,
  value: unknown,
): Values | null {
  const slot = slotDef(blockType, slotName);
  const map = readReuse(values, blockType);
  const ref = map[slotName];
  if (!slot || !ref || !slot.overridable.includes(key)) return null;
  const keys = new Set(ref.o ?? []);
  if (on) keys.add(key);
  else keys.delete(key);
  const next: ReuseMap = { ...map, [slotName]: keys.size ? { c: ref.c, o: [...keys].sort() } : { c: ref.c } };
  const [fieldName, edition] = key.split(".") as [string, "en" | "ar" | undefined];
  const written: Values = { ...values };
  if (edition) {
    written[fieldName] = { ...localisedOf(values[fieldName]), [edition]: typeof value === "string" ? value : "" };
  } else {
    written[fieldName] = typeof value === "string" ? value : "";
  }
  return withReuse(written, next);
}

/**
 * Detaches one slot: the covered fields take the content the page is showing —
 * the component's, with this page's overrides on top — and the reference is
 * removed. The component is not touched. `component` is `null` when there is
 * none to read, in which case the fallback is what the page was showing.
 */
export function detachSlot(blockType: string, values: Values, slotName: string, component: Values | null): Values | null {
  const slot = slotDef(blockType, slotName);
  const map = readReuse(values, blockType);
  const ref = map[slotName];
  if (!slot || !ref) return null;
  const effective = effectiveSlotValues(slot, values, component, ref.o);
  const next: ReuseMap = { ...map };
  delete next[slotName];
  return withReuse({ ...values, ...effective }, next);
}

/**
 * The component content a section's slot holds right now — what "Save as
 * reusable" turns into a component. Read from the section's own fields; the
 * server validates it as the kind before anything is stored.
 */
export function slotContent(blockType: string, values: Values, slotName: string): Values | null {
  const slot = slotDef(blockType, slotName);
  if (!slot) return null;
  const out: Values = {};
  for (const field of slot.fields) out[slot.componentField[field.name]!] = values[field.name];
  return out;
}

/** The kind definition's field for a key of a slot, for naming it: "Button text (Arabic)". */
export function overrideLabel(blockType: string, slotName: string, key: string): string {
  const slot = slotDef(blockType, slotName);
  const [fieldName, edition] = key.split(".");
  const field = slot?.fields.find((candidate) => candidate.name === fieldName);
  const kind = slot ? kindDef(slot.kind) : null;
  const own = kind?.definition.fields.find((candidate) => candidate.name === slot?.componentField[fieldName!]);
  const name = (slot?.kind === "cta" ? own?.label : field?.label) ?? fieldName ?? key;
  return edition ? `${name} (${edition === "ar" ? "Arabic" : "English"})` : name;
}

/** Which field of a block a node path names, when it is a top-level field. */
export const fieldOfPath = (relativePath: string): string | null => {
  const match = /^field:([A-Za-z0-9_-]+)$/.exec(relativePath);
  return match ? match[1]! : null;
};

/** The slot a top-level field belongs to under this map, if it is linked. */
export function linkedSlotOfField(blockType: string, map: ReuseMap, fieldName: string): SlotDef | null {
  for (const slotName of Object.keys(map)) {
    const slot = slotDef(blockType, slotName);
    if (slot?.fields.some((field) => field.name === fieldName)) return slot;
  }
  return null;
}

/**
 * Whether the canvas may type into one node of a section (Batch 17).
 *
 * A field a reusable component supplies is typed into only where this page
 * overrides it, in the edition being edited: that value is the section's own.
 * Anywhere else the text is the component's, the section holds only a
 * fallback copy, and typing into it would change nothing anybody sees — so
 * the answer is no, with the slot and the key, for the editor to say where
 * the text comes from and offer the override. Fields no component supplies
 * are not this function's business, and answer yes.
 */
export function directEditDecision(
  blockType: string,
  values: unknown,
  relativePath: string,
  locale: "en" | "ar",
): { ok: true } | { ok: false; slot: string; key: string } {
  const field = fieldOfPath(relativePath);
  if (!field) return { ok: true };
  const links = readReuse(values, blockType);
  const slot = linkedSlotOfField(blockType, links, field);
  if (!slot) return { ok: true };
  const def = slot.fields.find((candidate) => candidate.name === field);
  const key = def?.localised ? `${field}.${locale}` : field;
  return (links[slot.slot]?.o ?? []).includes(key) ? { ok: true } : { ok: false, slot: slot.slot, key };
}
