import { parseNodePath } from "@/lib/cms/address";
import { getBlock, type FieldDef, type ItemFieldDef } from "@/lib/cms/blocks";
import { ITEM_ID_KEY } from "@/lib/cms/item-id";
import { pick, type Locale } from "@/lib/i18n/config";

/**
 * Turning an address into something a person can read.
 *
 * `section:21/field:links/item:i_8Gk3pZmQ2v/field:label` is precise and
 * unreadable. An editor should be told "Quick service navigation → Links →
 * Plan a Trip → Label" and be able to find the address underneath if they want
 * it — the address is the machine's name for the node, not the interface.
 *
 * Every label comes from the block registry, which is the same declaration the
 * admin form is generated from, so a field renamed there is renamed here with
 * no second list to remember. The one exception is a repeatable row: the
 * registry knows the list is called "Links" but not that this row says "Plan a
 * Trip", and that comes from what the canvas can actually see on screen.
 */

/** Title case for a field the registry somehow does not declare. */
const humanise = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

const fieldLabel = (field: FieldDef | ItemFieldDef | undefined, name: string): string =>
  field?.label ?? humanise(name);

export type AddressDescription = {
  /** The block's own name, then one crumb per step of the path. */
  crumbs: string[];
  /** The last crumb — what to show when there is only room for one. */
  label: string;
  /** The block's registry name, for the inspector's own heading. */
  blockName: string;
};

/**
 * `text` is the node's own visible text, used to name a repeatable row. It is
 * only ever a label: nothing is read back out of it and nothing is saved from
 * it.
 */
export function describeAddress(
  blockType: string,
  relativePath: string,
  text?: string,
): AddressDescription {
  const block = getBlock(blockType);
  const blockName = block?.name ?? humanise(blockType);
  const path = parseNodePath(relativePath);

  if (!path || path.length === 0) {
    return { crumbs: [blockName], label: blockName, blockName };
  }

  const crumbs: string[] = [blockName];
  // Narrows as the path descends: a top-level field, then the row's fields.
  let fields: readonly (FieldDef | ItemFieldDef)[] = block?.fields ?? [];
  let itemFields: readonly ItemFieldDef[] = [];

  for (const segment of path) {
    if (segment.kind === "item") {
      // The row's own words, when the canvas could see them; otherwise the
      // neutral word, never the opaque id.
      crumbs.push(text?.trim() ? truncate(text.trim()) : "Item");
      fields = itemFields;
      continue;
    }

    const declared = fields.find((field) => field.name === segment.name);
    crumbs.push(fieldLabel(declared, segment.name));

    if (declared && "itemFields" in declared && declared.itemFields) {
      itemFields = declared.itemFields;
    }
  }

  return { crumbs, label: crumbs[crumbs.length - 1]!, blockName };
}

const truncate = (value: string, max = 42): string =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/** The registry's name for a block, for Layers rows. */
export const blockNameOf = (blockType: string): string =>
  getBlock(blockType)?.name ?? humanise(blockType);

/**
 * The same description, for a path nothing on screen is showing.
 *
 * `describeAddress` names a repeatable row from the words the canvas could see
 * on it, which is the right source when there is something to look at. A node
 * hidden at Base is not on screen anywhere, and "Item" is not a name anybody
 * can act on — so the row's words are read out of the section's own values
 * instead, by the row's stable `_id` and never by its position.
 *
 * Which field supplies them is the registry's first declared one, the same
 * field `items()` treats as a row's primary text, so the name here is the name
 * the panel uses everywhere else.
 */
export function describeStoredPath(
  blockType: string,
  relativePath: string,
  values: Record<string, unknown>,
  locale: Locale,
): AddressDescription {
  return describeAddress(blockType, relativePath, rowText(blockType, relativePath, values, locale));
}

function rowText(
  blockType: string,
  relativePath: string,
  values: Record<string, unknown>,
  locale: Locale,
): string | undefined {
  const path = parseNodePath(relativePath);
  if (!path) return undefined;

  const block = getBlock(blockType);
  let fields: readonly (FieldDef | ItemFieldDef)[] = block?.fields ?? [];
  let list: unknown = undefined;
  let text: string | undefined;

  for (const segment of path) {
    if (segment.kind === "item") {
      const row = Array.isArray(list)
        ? (list as Record<string, unknown>[]).find((entry) => entry?.[ITEM_ID_KEY] === segment.name)
        : undefined;
      // The row's primary field, whatever the registry calls it here.
      const primary = fields[0]?.name;
      const raw = primary && row ? row[primary] : undefined;
      text =
        typeof raw === "string"
          ? raw
          : typeof raw === "object" && raw !== null
            ? pick(locale, String((raw as { en?: unknown }).en ?? ""), String((raw as { ar?: unknown }).ar ?? ""))
            : undefined;
      list = undefined;
      continue;
    }

    const declared = fields.find((field) => field.name === segment.name);
    if (declared && "itemFields" in declared && declared.itemFields) {
      fields = declared.itemFields;
      list = values?.[segment.name];
    } else {
      fields = [];
      list = undefined;
    }
  }

  return text?.trim() ? text.trim() : undefined;
}
