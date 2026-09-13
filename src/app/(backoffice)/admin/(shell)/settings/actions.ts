"use server";

import { asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import {
  checkbox, fail, field, ok, optionalId, runAction, type ActionState,
} from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate, revalidateEverything } from "@/lib/cache";
import { db } from "@/lib/db";
import { socialLinks } from "@/lib/db/schema";
import { saveSettingsGroup, type SettingsKey } from "@/lib/settings";
import {
  allowsMultiple,
  isSocialPlatform,
  normalizeSocialPlatformKey,
  socialLabel,
} from "@/lib/social";

const refreshAll = () => {
  revalidate(TAGS.settings, TAGS.social);
  revalidatePath("/admin/settings");
  revalidatePath("/admin/analytics");
};

/** Only an https:// address on a known host is accepted for a map embed. */
function mapEmbed(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.replace(/^www\./, "");
    return host === "google.com" || host === "maps.google.com" || host.endsWith(".google.com")
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

const GROUP_LABEL: Record<string, string> = {
  brand: "brand details",
  contact: "contact details",
  whatsapp: "WhatsApp settings",
  disclaimers: "disclaimers",
  seo: "SEO defaults",
  features: "feature switches",
  analytics: "analytics",
};

async function persist(
  group: SettingsKey,
  values: Record<string, unknown>,
  form: FormData,
  permission: "settings.manage" | "analytics.manage" | "seo.manage",
): Promise<ActionState> {
  const session = await guardAction(permission, form);
  await saveSettingsGroup(group, values, session.user.id);
  await logActivity(session, {
    action: "settings.changed",
    entityType: "settings",
    entityId: group,
    summary: `Updated ${GROUP_LABEL[group] ?? group}`,
  });
  refreshAll();
  return ok("Saved.");
}

export async function saveBrand(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("settings-brand", async () =>
    persist(
      "brand",
      {
        siteNameEn: field(form, "siteNameEn", 120),
        siteNameAr: field(form, "siteNameAr", 120),
        taglineEn: field(form, "taglineEn", 190),
        taglineAr: field(form, "taglineAr", 190),
        legalNameEn: field(form, "legalNameEn", 190),
        legalNameAr: field(form, "legalNameAr", 190),
      },
      form,
      "settings.manage",
    ),
  );
}

export async function saveContact(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("settings-contact", async () => {
    const embed = field(form, "mapEmbedUrl", 600);
    const clean = mapEmbed(embed);
    if (embed && !clean) {
      return fail("That map address was not accepted.", {
        mapEmbedUrl: "Paste the https://www.google.com/maps/embed… address from Google Maps.",
      });
    }
    return persist(
      "contact",
      {
        phone: field(form, "phone", 40),
        phoneDisplay: field(form, "phoneDisplay", 40),
        email: field(form, "email", 190),
        addressEn: field(form, "addressEn", 255),
        addressAr: field(form, "addressAr", 255),
        cityEn: field(form, "cityEn", 120),
        cityAr: field(form, "cityAr", 120),
        countryEn: field(form, "countryEn", 120),
        countryAr: field(form, "countryAr", 120),
        hoursEn: field(form, "hoursEn", 255),
        hoursAr: field(form, "hoursAr", 255),
        mapEmbedUrl: clean,
      },
      form,
      "settings.manage",
    );
  });
}

export async function saveWhatsapp(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("settings-whatsapp", async () => {
    const digits = field(form, "number", 40).replace(/\D/g, "");
    const enabled = checkbox(form, "enabled");
    if (enabled && digits.length < 8) {
      return fail("Enter the number in international format before switching WhatsApp on.", {
        number: "Digits only, including the country code — for example 9665XXXXXXXX.",
      });
    }
    return persist(
      "whatsapp",
      {
        enabled,
        number: digits,
        defaultMessageEn: field(form, "defaultMessageEn", 400),
        defaultMessageAr: field(form, "defaultMessageAr", 400),
        floatingEnabled: checkbox(form, "floatingEnabled"),
      },
      form,
      "settings.manage",
    );
  });
}

export async function saveDisclaimers(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("settings-disclaimers", async () =>
    persist(
      "disclaimers",
      {
        governmentEn: field(form, "governmentEn", 2000),
        governmentAr: field(form, "governmentAr", 2000),
        visaEn: field(form, "visaEn", 2000),
        visaAr: field(form, "visaAr", 2000),
        showOnServicePages: checkbox(form, "showOnServicePages"),
      },
      form,
      "settings.manage",
    ),
  );
}

export async function saveFeatures(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("settings-features", async () =>
    persist(
      "features",
      {
        customCursor: checkbox(form, "customCursor"),
        showTestimonials: checkbox(form, "showTestimonials"),
        showVideos: checkbox(form, "showVideos"),
        showStats: checkbox(form, "showStats"),
        searchEnabled: checkbox(form, "searchEnabled"),
        arabicEnabled: checkbox(form, "arabicEnabled"),
      },
      form,
      "settings.manage",
    ),
  );
}

export async function saveSeoDefaults(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("settings-seo", async () =>
    persist(
      "seo",
      {
        defaultTitleEn: field(form, "defaultTitleEn", 190),
        defaultTitleAr: field(form, "defaultTitleAr", 190),
        titleTemplateEn: field(form, "titleTemplateEn", 120),
        titleTemplateAr: field(form, "titleTemplateAr", 120),
        defaultDescriptionEn: field(form, "defaultDescriptionEn", 320),
        defaultDescriptionAr: field(form, "defaultDescriptionAr", 320),
        ogImageId: optionalId(form, "ogImageId"),
        twitterHandle: field(form, "twitterHandle", 40),
      },
      form,
      "seo.manage",
    ),
  );
}

export async function saveAnalytics(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("settings-analytics", async () => {
    const ga4Id = field(form, "ga4Id", 40);
    const gtmId = field(form, "gtmId", 40);
    const metaPixelId = field(form, "metaPixelId", 40);

    if (ga4Id && !/^G-[A-Z0-9]{6,}$/i.test(ga4Id)) {
      return fail("That GA4 id does not look right.", { ga4Id: "It starts with G- — for example G-XXXXXXXXXX." });
    }
    if (gtmId && !/^GTM-[A-Z0-9]{4,}$/i.test(gtmId)) {
      return fail("That Tag Manager id does not look right.", { gtmId: "It starts with GTM-." });
    }
    if (metaPixelId && !/^\d{6,20}$/.test(metaPixelId)) {
      return fail("A Meta Pixel id is a number.", { metaPixelId: "Digits only." });
    }

    return persist("analytics", { ga4Id, gtmId, metaPixelId }, form, "analytics.manage");
  });
}

/* -------------------------------------------------------------------------- */
/* Maintenance                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Drop every cached loader at once.
 *
 * Ordinary editing does not need this: each admin action already revalidates
 * the tags it touched, so a saved package or a renamed category is live before
 * the editor has finished reading the confirmation. This exists for the one
 * case those actions cannot cover — a change made to the database from outside
 * the running application, which is to say a migration or the taxonomy cutover
 * (`npm run restructure`, DEPLOYMENT.md §9.1).
 *
 * A `tsx` script has no route handler, no request and no incremental cache, so
 * `revalidateTag` there would be a no-op at best; the refresh has to be asked
 * for from inside the server that holds the cache. That is what this is: an
 * ordinary admin action behind `settings.manage`, the session cookie and the
 * CSRF token, with no new permission and no unauthenticated purge address.
 *
 * `revalidateEverything` drops the tagged data cache — the loaders themselves.
 * `revalidatePath("/", "layout")` drops the rendered route cache underneath it,
 * because a page whose data is fresh is still stale if the render is not. Both,
 * so that "refreshed" means refreshed rather than probably refreshed.
 *
 * The site runs as a single Node process (`instances: 1` in
 * `deploy/ecosystem.config.js`, one `ExecStart` in the systemd unit), so the
 * cache this empties is the only cache there is. Behind more than one instance
 * it would have to be asked of each of them, which is why the deployment notes
 * say to keep it at one.
 */
export async function refreshCaches(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("cache-refresh", async () => {
    const session = await guardAction("settings.manage", form);
    revalidateEverything();
    revalidatePath("/", "layout");
    await logActivity(session, {
      action: "cache.refreshed",
      entityType: "settings",
      entityId: "cache",
      summary: "Refreshed every site cache",
    });
    return ok("Every cache was dropped. The next visit to a page reads the database again.");
  });
}

/* -------------------------------------------------------------------------- */
/* Social links                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The rows in the order the footer shows them.
 *
 * `sortOrder` then `id`, so the order is total even where two rows share a
 * number — which they can, because nothing ever guaranteed they would not.
 */
async function orderedSocial() {
  return db
    .select({
      id: socialLinks.id,
      platform: socialLinks.platform,
      url: socialLinks.url,
      isPublished: socialLinks.isPublished,
    })
    .from(socialLinks)
    .orderBy(asc(socialLinks.sortOrder), asc(socialLinks.id));
}

/**
 * Writes `0..n-1` down a list of ids, in one transaction.
 *
 * Renumbering the whole list rather than swapping two numbers is what makes
 * this safe on data that already holds duplicates or gaps: whatever the rows
 * came in as, they leave contiguous and in the order given.
 */
async function renumberSocial(ids: number[]) {
  await db.transaction(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx
        .update(socialLinks)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(eq(socialLinks.id, id));
    }
  });
}

export async function saveSocialLink(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("social-save", async () => {
    const session = await guardAction("settings.manage", form);
    const id = Number(form.get("id")) || 0;
    const submitted = field(form, "platform", 32);
    // Canonical from the first line: `twitter` and ` X ` are the same platform,
    // and every check below — the allowlist, the duplicate test, the label in
    // the audit line — has to be asking about the same thing.
    const platform = normalizeSocialPlatformKey(submitted);
    const url = field(form, "url", 255);
    const isPublished = checkbox(form, "isPublished");

    if (!platform) return fail("Which network is this?", { platform: "Required." });

    const [existing] = id
      ? await db.select().from(socialLinks).where(eq(socialLinks.id, id)).limit(1)
      : [];
    if (id && !existing) return fail("That link no longer exists.");

    /**
     * The network has to be one the site can draw. The panel offers a menu
     * built from the same registry, so the only way to arrive here with
     * anything else is a hand-made request — or a row stored under a key the
     * registry has never known, which keeps its own key until somebody
     * deliberately changes it.
     */
    if (!isSocialPlatform(platform)) {
      if (normalizeSocialPlatformKey(existing?.platform) !== platform) {
        return fail("That network is not one we have a mark for.", {
          platform: "Choose one from the list.",
        });
      }
    }

    /**
     * One row per network. The comparison is canonical, so a `twitter` row and
     * an `x` row are the same platform and the second one is refused — but
     * refused, never rewritten: a pair that already exists stays until an admin
     * decides which to keep. `Other / Website` is exempt, because a business
     * can legitimately have several addresses that are not social accounts.
     */
    if (!allowsMultiple(platform)) {
      const clash = (await orderedSocial()).find(
        (row) => row.id !== id && normalizeSocialPlatformKey(row.platform) === platform,
      );
      if (clash) {
        return fail(`There is already a link for ${socialLabel(platform)}.`, {
          platform: "Edit or remove the existing one instead.",
        });
      }
    }

    // https only — a social profile has no reason to be anything else, and it
    // is the one field most likely to be pasted from an untrusted place.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return fail("That address is not valid.", { url: "Include https:// at the start." });
    }
    if (parsed.protocol !== "https:") {
      return fail("Social links must be https.", { url: "Use the https:// address." });
    }

    if (existing) {
      /**
       * `sortOrder` is deliberately absent. The edit form does not carry one —
       * it never did — so reading a number out of the request meant an ordinary
       * URL correction silently sent the row to the top of the footer. Order is
       * changed by the arrows, and by nothing else.
       */
      await db
        .update(socialLinks)
        .set({ platform, url: parsed.toString(), isPublished, updatedAt: new Date() })
        .where(eq(socialLinks.id, id));
    } else {
      const [last] = await db
        .select({ n: sql<number>`coalesce(max(${socialLinks.sortOrder}), -1)::int` })
        .from(socialLinks);
      await db
        .insert(socialLinks)
        .values({ platform, url: parsed.toString(), isPublished, sortOrder: (last?.n ?? -1) + 1 });
    }

    await logActivity(session, {
      action: existing ? "social.updated" : "social.created",
      entityType: "social",
      entityId: id || 0,
      summary: describeSave(existing, { platform, url: parsed.toString(), isPublished }),
    });
    refreshAll();
    return ok(existing ? "Link saved." : "Link added.");
  });
}

/**
 * What actually changed, in a sentence.
 *
 * An audit line that says "Updated link" for a URL correction, for taking a
 * network off the site and for migrating a legacy key is three different events
 * wearing one label — and the two that matter most are the two it hides.
 */
function describeSave(
  before: { platform: string; url: string; isPublished: boolean } | undefined,
  after: { platform: string; url: string; isPublished: boolean },
): string {
  const name = socialLabel(after.platform);
  if (!before) return `Added the ${name} social link`;
  if (before.platform !== after.platform) {
    return `Changed the ${socialLabel(before.platform)} row (${before.platform}) to ${name}`;
  }
  if (before.isPublished !== after.isPublished) {
    return `${after.isPublished ? "Enabled" : "Disabled"} the ${name} social link`;
  }
  if (before.url !== after.url) return `Updated the ${name} URL`;
  return `Saved the ${name} social link`;
}

/** Show or hide one row, without opening its form. */
export async function toggleSocialLink(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("social-toggle", async () => {
    const session = await guardAction("settings.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(socialLinks).where(eq(socialLinks.id, id)).limit(1);
    if (!row) return fail("That link no longer exists.");

    const next = !row.isPublished;
    await db
      .update(socialLinks)
      .set({ isPublished: next, updatedAt: new Date() })
      .where(eq(socialLinks.id, id));

    const name = socialLabel(row.platform);
    await logActivity(session, {
      action: next ? "social.enabled" : "social.disabled",
      entityType: "social",
      entityId: id,
      summary: `${next ? "Enabled" : "Disabled"} the ${name} social link`,
    });
    refreshAll();
    return ok(next ? `${name} is shown in the footer.` : `${name} is hidden.`);
  });
}

/**
 * Moves one row up or down.
 *
 * Published and hidden rows sit in one list, because the admin is ordering the
 * footer and a hidden row is one that will be in it again. The move is done on
 * the read order and written back as a contiguous run, so it behaves the same
 * whether the stored numbers were tidy or not.
 */
export async function moveSocialLink(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("social-move", async () => {
    const session = await guardAction("settings.manage", form);
    const id = Number(form.get("id"));
    const direction = field(form, "direction", 8) === "up" ? -1 : 1;

    const rows = await orderedSocial();
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return fail("That link no longer exists.");

    const target = index + direction;
    if (target < 0 || target >= rows.length) {
      // A stale page can ask to move the first row up. Nothing to do, and
      // nothing wrong either.
      return ok();
    }

    const ids = rows.map((row) => row.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    await renumberSocial(ids);

    await logActivity(session, {
      action: "social.reordered",
      entityType: "social",
      entityId: id,
      summary: `Moved the ${socialLabel(rows[index]!.platform)} social link ${direction < 0 ? "up" : "down"}`,
      metadata: { order: ids },
    });
    refreshAll();
    return ok("Order saved.");
  });
}

export async function deleteSocialLink(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("social-delete", async () => {
    const session = await guardAction("settings.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(socialLinks).where(eq(socialLinks.id, id)).limit(1);
    if (!row) return fail("That link no longer exists.");
    await db.delete(socialLinks).where(eq(socialLinks.id, id));
    await logActivity(session, {
      action: "social.deleted",
      entityType: "social",
      entityId: id,
      summary: `Removed the ${socialLabel(row.platform)} link`,
    });
    refreshAll();
    return ok("Link removed.");
  });
}
