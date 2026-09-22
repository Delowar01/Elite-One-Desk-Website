"use server";

import { and, eq, gt, lt, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import {
  checkbox, fail, field, numberField, ok, optionalId, runAction, type ActionState,
} from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { sanitizeHref } from "@/lib/cms/sanitize";
import { db } from "@/lib/db";
import { navigationItems } from "@/lib/db/schema";

/**
 * Module-private on purpose: a `"use server"` file may export async functions
 * and nothing else, so a shared constant here is a build that fails at the
 * first import of it.
 */
const MENUS = ["header", "footer_services", "footer_company", "footer_legal"] as const;
type Menu = (typeof MENUS)[number];
const isMenu = (value: string): value is Menu => (MENUS as readonly string[]).includes(value);

const refresh = () => {
  revalidate(TAGS.navigation);
  revalidatePath("/admin/navigation");
};

export async function saveNavItem(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("nav-save", async () => {
    const session = await guardAction("navigation.manage", form);
    const id = Number(form.get("id")) || 0;
    const rawMenu = field(form, "menu", 32);
    /**
     * An unrecognised menu is refused, not quietly turned into the header.
     *
     * It used to fall back, which meant a request naming a menu this build does
     * not have moved the link into the main navigation — a mutation claiming to
     * edit one part of the site silently editing another, and the most visible
     * part at that.
     */
    if (!isMenu(rawMenu)) {
      return fail("That is not a menu on this site.", { menu: "Choose header or a footer column." });
    }
    const menu: Menu = rawMenu;
    const labelEn = field(form, "labelEn", 120);
    const href = sanitizeHref(field(form, "href", 255));

    if (!labelEn) return fail("Give the link a label.", { labelEn: "Required." });
    if (!href) {
      return fail("That link is not one we can use.", {
        href: "Use a site path like /services, or a full https:// address.",
      });
    }

    // The row as it stands, for the fields a form may legitimately not carry.
    const [current] = id
      ? await db.select().from(navigationItems).where(eq(navigationItems.id, id)).limit(1)
      : [];
    if (id && !current) return fail("That link no longer exists.");

    /**
     * An existing link keeps the menu it is in.
     *
     * Neither editing screen can move a link between menus — there is no
     * control for it — so a request that says otherwise is a request the panel
     * cannot have made. Accepting it was the same cross-menu tree the parent
     * checks below refuse to build, reached through a different field: move a
     * parent from the header into a footer column and its children stay behind
     * with `menu = header` and `parent_id` pointing into the footer. Refused
     * rather than cascaded, because carrying the children across is a feature
     * this release does not have and should not grow by accident.
     */
    if (current && rawMenu !== current.menu) {
      return fail(
        "Move links between menus through a dedicated control; this edit cannot change its menu.",
        { menu: "This link belongs to another menu." },
      );
    }

    const parentId = optionalId(form, "parentId");
    /**
     * Only the header nests.
     *
     * The footer columns are flat lists — the public footer has no concept of a
     * sub-link and would not render one — so a stored parent there is a row
     * that exists in the database and on no page. A server invariant rather
     * than a UI choice, because the UI's silence about a field is not a rule.
     */
    if (parentId && menu !== "header") {
      return fail("Only the header menu has sub-links.", {
        parentId: "Footer links sit on their own.",
      });
    }
    // A link cannot be its own parent, and sub-menus stop at one level: the
    // header has no room for a third, and the markup would not render it.
    if (parentId && parentId === id) return fail("A link cannot sit under itself.");
    if (parentId) {
      const [parent] = await db
        .select({ id: navigationItems.id, menu: navigationItems.menu, parentId: navigationItems.parentId })
        .from(navigationItems)
        .where(eq(navigationItems.id, parentId))
        .limit(1);
      /**
       * The parent has to be a link that exists, in the menu this one claims.
       *
       * Neither was checked. A `parentId` naming nothing read as "no parent
       * problem" — `parent?.parentId` on an absent row is `undefined`, which is
       * falsy — and stored a foreign key to a row that was not there, which the
       * public tree then treats as a top-level link. A parent in another menu
       * was accepted outright, which puts a footer link's children in the
       * header's tree the moment the parent is republished.
       */
      if (!parent) return fail("That parent link no longer exists.", { parentId: "Choose another." });
      if (parent.menu !== menu) {
        return fail("A link can only sit under one in the same menu.", {
          parentId: "Choose a parent from this menu.",
        });
      }
      if (parent.parentId) return fail("Sub-menus only go one level deep.");
    }

    /**
     * A link with children of its own cannot become a child.
     *
     * The one-level rule was enforced downwards only, so moving a parent under
     * somebody else produced the third level it refuses to create directly.
     */
    if (parentId && id) {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(navigationItems)
        .where(eq(navigationItems.parentId, id));
      if (n) return fail("Move the links underneath it out first.");
    }

    const values = {
      menu,
      parentId,
      labelEn,
      labelAr: field(form, "labelAr", 120),
      href,
      /**
       * Order is the arrows' business on every surface that has them, so a form
       * without an Order field keeps the row where it is. Reading a default of
       * zero out of a request that never mentioned it sent an edited link to the
       * top of its menu — the same way an edited social link used to jump to the
       * top of the footer.
       */
      sortOrder: form.has("sortOrder")
        ? numberField(form, "sortOrder", current?.sortOrder ?? 0)
        : (current?.sortOrder ?? 0),
      /**
       * The header's emphasised link. It has always been rendered
       * (`site-header.tsx` reads `isHighlighted`) and was the one navigation
       * column no admin screen could write, so it could only ever be whatever
       * the seed left.
       *
       * Decided by the menu rather than by whether the field arrived, because an
       * unchecked checkbox is absent from a request and "absent" would then mean
       * both "this form has no such control" and "the editor turned it off". The
       * two surfaces that edit a header link both carry the control; the footer
       * columns do not draw emphasis at all, so there the stored value stands.
       */
      isHighlighted:
        menu === "header" ? checkbox(form, "isHighlighted") : (current?.isHighlighted ?? false),
      isPublished: checkbox(form, "isPublished"),
    };

    if (id) {
      await db.update(navigationItems).set({ ...values, updatedAt: new Date() }).where(eq(navigationItems.id, id));
    } else {
      const [last] = await db
        .select({ n: sql<number>`coalesce(max(${navigationItems.sortOrder}), -1)::int` })
        .from(navigationItems)
        .where(eq(navigationItems.menu, menu));
      await db.insert(navigationItems).values({ ...values, sortOrder: (last?.n ?? -1) + 1 });
    }

    await logActivity(session, {
      action: id ? "navigation.updated" : "navigation.created",
      entityType: "navigation",
      entityId: id || 0,
      summary: `${id ? "Updated" : "Added"} the link “${labelEn}”`,
    });
    refresh();
    return ok(id ? "Link saved." : "Link added.");
  });
}

export async function deleteNavItem(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("nav-delete", async () => {
    const session = await guardAction("navigation.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(navigationItems).where(eq(navigationItems.id, id)).limit(1);
    if (!row) return fail("That link no longer exists.");

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(navigationItems)
      .where(eq(navigationItems.parentId, id));
    if (n) return fail(`Remove the ${n} link${n === 1 ? "" : "s"} underneath it first.`);

    await db.delete(navigationItems).where(eq(navigationItems.id, id));
    await logActivity(session, {
      action: "navigation.deleted",
      entityType: "navigation",
      entityId: id,
      summary: `Removed the link “${row.labelEn}”`,
    });
    refresh();
    return ok("Link removed.");
  });
}

export async function moveNavItem(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("nav-move", async () => {
    await guardAction("navigation.manage", form);
    const id = Number(form.get("id"));
    const up = field(form, "direction", 8) === "up";
    const [row] = await db.select().from(navigationItems).where(eq(navigationItems.id, id)).limit(1);
    if (!row) return fail("That link no longer exists.");

    // Reordering happens within a menu and within a parent, so a sub-menu item
    // never jumps out of its group.
    const sameGroup = and(
      eq(navigationItems.menu, row.menu),
      row.parentId
        ? eq(navigationItems.parentId, row.parentId)
        : sql`${navigationItems.parentId} is null`,
      up ? lt(navigationItems.sortOrder, row.sortOrder) : gt(navigationItems.sortOrder, row.sortOrder),
    );

    const [neighbour] = await db
      .select()
      .from(navigationItems)
      .where(sameGroup)
      .orderBy(up ? sql`sort_order desc` : sql`sort_order asc`)
      .limit(1);
    /**
     * Nothing to swap with: this link is already at the end of its own sibling
     * group. It says so rather than coming back as a bare success — a caller
     * that shows "Saved live." for an empty result would be reporting a move
     * that did not happen. Nothing is revalidated and nothing is logged,
     * because nothing changed.
     */
    if (!neighbour) {
      return ok(
        up ? "This link is already first in its group." : "This link is already last in its group.",
      );
    }

    await db.transaction(async (tx) => {
      await tx.update(navigationItems).set({ sortOrder: -1 }).where(eq(navigationItems.id, row.id));
      await tx
        .update(navigationItems)
        .set({ sortOrder: row.sortOrder })
        .where(eq(navigationItems.id, neighbour.id));
      await tx
        .update(navigationItems)
        .set({ sortOrder: neighbour.sortOrder })
        .where(eq(navigationItems.id, row.id));
    });
    refresh();
    return ok("Order saved.");
  });
}
