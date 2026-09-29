import {
  requirementKeys,
  satisfies,
  type PermissionKey,
  type PermissionRequirement,
} from "./permissions";

/**
 * What each page, editor and reusable-component operation needs — decided here
 * and nowhere else (Batch 18).
 *
 * Every server action asks for a capability by name (`guardAction(AUTHORITY.x,
 * …)`, or `allOf(…)` for an operation with several effects), the editor's
 * controls are drawn from `capabilitiesOf(session.permissions)`, and both read
 * this one table through the same `satisfies()` evaluator the route guards and
 * the sidebar use. So a control cannot be offered to somebody the action will
 * refuse, and no call site can quietly accept a key the table does not name.
 *
 * Two rules shape the table:
 *
 *   · **Every page capability includes `content.view`.** Nobody edits,
 *     restyles, rearranges or publishes a page they are not allowed to see,
 *     and a publisher may publish a prepared page only because they can see
 *     what it is.
 *   · **Every component write includes `components.view`.** Each one answers
 *     with the component whole — its draft, its usage and its history.
 *
 * `content.manage` appears nowhere. It is the previous release's key, kept for
 * a rollback (`lib/auth/permissions.ts`), and treating it as a fallback here
 * would hand every half of the split back to whoever held the whole.
 */
export const AUTHORITY = {
  /** Read pages, sections, drafts, history, the page summary and Version Compare. */
  viewPages: "content.view",
  /** Open the Visual Editor. */
  openEditor: { all: ["content.view", "visual_editor.view"] },
  /** Words, links, icons, media choices, repeatable items, EN and AR, direct edits on the canvas. */
  editContent: { all: ["content.view", "content.edit"] },
  /** The standard StyleDocument tokens. */
  editStyle: { all: ["content.view", "content.style"] },
  /**
   * The advanced tokens (`ADVANCED_STYLE_TOKENS`) — always together with the
   * standard ones, never on their own: `content.advanced_style` without
   * `content.style` is no styling authority at all.
   */
  editAdvancedStyle: { all: ["content.view", "content.style", "content.advanced_style"] },
  /** The MotionDocument, the legacy entrance and its responsive overrides. */
  editMotion: { all: ["content.view", "content.motion"] },
  /** Add, duplicate, reorder, hide, show, remove and restore sections; the layout draft. */
  editStructure: { all: ["content.view", "content.structure"] },
  /** Publish, and the other page-wide acts: discard, restore a version to draft. */
  publish: { all: ["content.view", "content.publish"] },
  /** The reusable-component list, a component's detail, its usage and its history. */
  viewComponents: "components.view",
  /** Create, rename, save or discard a draft, restore a version to the draft. */
  editComponents: { all: ["components.view", "components.edit"] },
  /** Publish a component — what every linked page then shows. */
  publishComponents: { all: ["components.view", "components.publish"] },
  /** Archive, unarchive and delete. */
  componentLifecycle: { all: ["components.view", "components.lifecycle"] },
} as const satisfies Record<string, PermissionRequirement>;

export type Capability = keyof typeof AUTHORITY;

export const CAPABILITIES = Object.keys(AUTHORITY) as Capability[];

/** The keys one capability needs. */
const keysOf = (capability: Capability): readonly PermissionKey[] => requirementKeys(AUTHORITY[capability]);

/**
 * An operation with several effects needs every capability behind them — the
 * union of their keys, all of them. Creating a component from a section and
 * linking it, for instance, is page content *and* a component draft *and* a
 * publication; one permission must never be enough for all three.
 */
export function allOf(...capabilities: Capability[]): PermissionRequirement {
  const keys = new Set<PermissionKey>();
  for (const capability of capabilities) for (const key of keysOf(capability)) keys.add(key);
  return { all: [...keys] };
}

/** Whether a set of granted keys allows one capability. */
export const may = (held: ReadonlySet<string> | null | undefined, capability: Capability): boolean =>
  Boolean(held && satisfies(held, AUTHORITY[capability]));

/**
 * The operations that are more than one capability, named once so a server
 * action and the control that calls it ask the same question.
 */
export const COMPOUND = {
  /**
   * A change to a section's reusable-component references — a link made or
   * removed, an override switched on or off, a detach. Page content, plus
   * being allowed to see the shared definition it names.
   */
  reuseInstance: allOf("editContent", "viewComponents"),
  /** A new section that arrives linked to a reusable block. */
  addReusableSection: allOf("editStructure", "editContent", "viewComponents"),
  /** Save as reusable, as a draft: read the section, write a component draft. */
  saveAsReusableDraft: allOf("viewPages", "editComponents"),
  /** Save as reusable, "Create, publish and link": all four effects. */
  saveAsReusablePublished: allOf("viewPages", "editContent", "editComponents", "publishComponents"),
  /** A component made on its own screen and published in the same step. */
  createPublishedComponent: allOf("editComponents", "publishComponents"),
  /** The classic form's "Save and publish": new words, live at once. */
  saveAndPublish: allOf("editContent", "publish"),
  /** A page's title is live the moment it is saved — an edit and a publication. */
  renamePage: allOf("editContent", "publish"),
  /** A new page: its titles are content, its first section is layout. */
  createPage: allOf("editStructure", "editContent"),
  /** Deleting a page removes it, and everything on it, from the live site. */
  deletePage: allOf("editStructure", "publish"),
  /** A component's draft previewed on a page: page drafts and a component draft. */
  previewComponent: allOf("viewPages", "viewComponents"),
} as const satisfies Record<string, PermissionRequirement>;

/**
 * What a refusal says — the capability, in words, so an editor learns which
 * part of their role is missing rather than that "something" was not allowed.
 */
export const DENIED: Record<Capability | keyof typeof COMPOUND, string> = {
  viewPages: "Your role does not allow viewing pages.",
  openEditor: "Your role does not allow using the Visual Editor.",
  editContent: "Your role does not allow editing page content. Nothing was saved.",
  editStyle: "Your role does not allow styling. Nothing was saved.",
  editAdvancedStyle:
    "Your role does not allow advanced styling — width, height, layout, direction, wrapping, " +
    "alignment, columns, overflow and glow. Nothing was saved.",
  editMotion: "Your role does not allow editing motion. Nothing was saved.",
  editStructure: "Your role does not allow changing the page layout. Nothing was changed.",
  publish: "Your role does not allow publishing, discarding or restoring pages. Nothing was changed.",
  viewComponents: "Your role does not allow viewing reusable components.",
  editComponents: "Your role does not allow editing reusable components. Nothing was changed.",
  publishComponents: "Your role does not allow publishing reusable components. Nothing was published.",
  componentLifecycle: "Your role does not allow archiving or deleting reusable components. Nothing was changed.",
  reuseInstance:
    "Linking, detaching or overriding a reusable component needs permission to edit page content " +
    "and to view reusable components. Nothing was saved.",
  addReusableSection:
    "Adding a reusable section needs permission to change the layout, to edit page content and " +
    "to view reusable components. Nothing was added.",
  saveAsReusableDraft:
    "Saving this as a reusable component needs permission to edit reusable components. Nothing was created.",
  saveAsReusablePublished:
    "Create, publish and link needs permission to edit page content and to edit and publish " +
    "reusable components. Nothing was created.",
  createPublishedComponent:
    "Publishing a new component needs permission to publish reusable components. Nothing was created.",
  saveAndPublish: "Saving and publishing needs permission to edit page content and to publish. Nothing was saved.",
  renamePage: "A page title is live as soon as it is saved, so changing it needs permission to edit page content and to publish.",
  createPage: "Creating a page needs permission to change the layout and to edit page content.",
  deletePage: "Deleting a page needs permission to change the layout and to publish.",
  previewComponent: "Your role does not allow previewing reusable components.",
};

/**
 * Which capability a refusal was about, read back from its sentence — so an
 * editor that has just been refused can stop offering that one control for the
 * rest of the session, and say why. `null` for a sentence that names several
 * capabilities, or none: those are shown and nothing is assumed from them.
 */
export function deniedCapability(message: string | null | undefined): Capability | null {
  if (!message) return null;
  return CAPABILITIES.find((capability) => DENIED[capability] === message) ?? null;
}

/** What each capability is called in a sentence: "your role does not allow …". */
export const CAPABILITY_WORDS: Record<Capability, string> = {
  viewPages: "viewing pages",
  openEditor: "using the Visual Editor",
  editContent: "editing page content",
  editStyle: "styling",
  editAdvancedStyle: "advanced styling",
  editMotion: "editing motion",
  editStructure: "changing the page layout",
  publish: "publishing",
  viewComponents: "viewing reusable components",
  editComponents: "editing reusable components",
  publishComponents: "publishing reusable components",
  componentLifecycle: "archiving or deleting reusable components",
};

/** What a session may do, one answer per capability — for drawing controls, never for deciding a write. */
export type Capabilities = Record<Capability, boolean>;

export function capabilitiesOf(held: ReadonlySet<string> | null | undefined): Capabilities {
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, may(held, capability)])) as Capabilities;
}

/** Nothing at all — for a screen that has not been told. */
export const NO_CAPABILITIES: Capabilities = capabilitiesOf(null);
