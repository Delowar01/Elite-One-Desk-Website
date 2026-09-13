"use client";

import { useState } from "react";

import { AdminForm, ConfirmSubmit, Field, InlineAction, SubmitButton } from "@/components/admin/form";
import { Icon } from "@/components/ui/icon";
import { SocialIcon } from "@/components/ui/social-icon";
import type { SiteSettings } from "@/lib/settings-defaults";
import {
  SOCIAL_PLATFORMS,
  normalizeSocialPlatformKey,
  socialLabel,
  socialPlatform,
} from "@/lib/social";
import {
  deleteSocialLink,
  moveSocialLink,
  refreshCaches,
  saveBrand,
  saveContact,
  saveDisclaimers,
  saveFeatures,
  saveSocialLink,
  saveWhatsapp,
  toggleSocialLink,
} from "./actions";
import { SETTINGS_TABS, type SettingsTab } from "./tabs";

export type SocialRow = {
  id: number;
  platform: string;
  url: string;
  sortOrder: number;
  isPublished: boolean;
};

const TABS = SETTINGS_TABS;

const text = (
  id: string,
  name: string,
  label: string,
  value: string,
  opts: { rtl?: boolean; hint?: string; rows?: number; type?: string } = {},
) => (
  <Field key={id} label={label} name={id} hint={opts.hint}>
    {opts.rows ? (
      <textarea
        id={id}
        name={name}
        rows={opts.rows}
        defaultValue={value}
        dir={opts.rtl ? "rtl" : undefined}
        className="admin-textarea"
      />
    ) : (
      <input
        id={id}
        name={name}
        type={opts.type ?? "text"}
        defaultValue={value}
        dir={opts.rtl ? "rtl" : undefined}
        className="admin-input"
      />
    )}
  </Field>
);

export function SettingsClient({
  csrf,
  settings,
  social,
  initialTab = "brand",
}: {
  csrf: string;
  settings: SiteSettings;
  social: SocialRow[];
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  return (
    <>
      <nav aria-label="Settings sections" className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            aria-current={tab === item.key ? "page" : undefined}
            className="admin-btn admin-btn-sm"
            style={tab === item.key ? { borderColor: "var(--color-orange)" } : undefined}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab === "brand" ? (
        <AdminForm action={saveBrand} className="admin-card max-w-3xl p-5">
          <input type="hidden" name="_csrf" value={csrf} />
          <h2 className="mb-4">Brand</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {text("siteNameEn", "siteNameEn", "Site name (English)", settings.brand.siteNameEn)}
            {text("siteNameAr", "siteNameAr", "Site name (العربية)", settings.brand.siteNameAr, { rtl: true })}
            {text("taglineEn", "taglineEn", "Tagline (English)", settings.brand.taglineEn)}
            {text("taglineAr", "taglineAr", "Tagline (العربية)", settings.brand.taglineAr, { rtl: true })}
            {text("legalNameEn", "legalNameEn", "Legal name (English)", settings.brand.legalNameEn, {
              hint: "Used in the copyright line and the Organization structured data.",
            })}
            {text("legalNameAr", "legalNameAr", "Legal name (العربية)", settings.brand.legalNameAr, { rtl: true })}
          </div>
          <div className="mt-5">
            <SubmitButton />
          </div>
        </AdminForm>
      ) : null}

      {tab === "contact" ? (
        <AdminForm action={saveContact} className="admin-card max-w-3xl p-5">
          <input type="hidden" name="_csrf" value={csrf} />
          <h2 className="mb-1">Contact details</h2>
          <p className="mb-4 text-[0.8rem] text-muted">
            These appear in the footer, on the contact page and in the structured data. A field left
            empty is not shown at all — nothing is invented to fill a gap.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {text("phone", "phone", "Phone (for the tel: link)", settings.contact.phone, {
              hint: "International format, e.g. +9665XXXXXXXX.",
            })}
            {text("phoneDisplay", "phoneDisplay", "Phone (as shown)", settings.contact.phoneDisplay, {
              hint: "Optional. Leave empty to show the number above.",
            })}
            {text("email", "email", "Email", settings.contact.email, { type: "email" })}
            {text("hoursEn", "hoursEn", "Opening hours (English)", settings.contact.hoursEn)}
            {text("hoursAr", "hoursAr", "Opening hours (العربية)", settings.contact.hoursAr, { rtl: true })}
            {text("addressEn", "addressEn", "Street address (English)", settings.contact.addressEn)}
            {text("addressAr", "addressAr", "Street address (العربية)", settings.contact.addressAr, { rtl: true })}
            {text("cityEn", "cityEn", "City (English)", settings.contact.cityEn)}
            {text("cityAr", "cityAr", "City (العربية)", settings.contact.cityAr, { rtl: true })}
            {text("countryEn", "countryEn", "Country (English)", settings.contact.countryEn)}
            {text("countryAr", "countryAr", "Country (العربية)", settings.contact.countryAr, { rtl: true })}
          </div>
          <div className="mt-4">
            {text("mapEmbedUrl", "mapEmbedUrl", "Google Maps embed address", settings.contact.mapEmbedUrl, {
              hint: "In Google Maps: Share → Embed a map → copy the src address. Leave empty to hide the map.",
            })}
          </div>
          <div className="mt-5">
            <SubmitButton />
          </div>
        </AdminForm>
      ) : null}

      {tab === "whatsapp" ? (
        <AdminForm action={saveWhatsapp} className="admin-card max-w-3xl p-5">
          <input type="hidden" name="_csrf" value={csrf} />
          <h2 className="mb-1">WhatsApp</h2>
          <p className="mb-4 text-[0.8rem] text-muted">
            The floating button and every WhatsApp link on the site. On a service page the message is
            filled in with that service&rsquo;s name.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {text("number", "number", "WhatsApp number", settings.whatsapp.number, {
              hint: "Digits only, with the country code — for example 9665XXXXXXXX.",
            })}
          </div>
          <div className="mt-4 grid gap-4">
            {text(
              "defaultMessageEn",
              "defaultMessageEn",
              "Default message (English)",
              settings.whatsapp.defaultMessageEn,
              { rows: 2 },
            )}
            {text(
              "defaultMessageAr",
              "defaultMessageAr",
              "Default message (العربية)",
              settings.whatsapp.defaultMessageAr,
              { rows: 2, rtl: true },
            )}
          </div>
          <div className="mt-4 space-y-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-[0.85rem]">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={settings.whatsapp.enabled}
                className="size-4 accent-[var(--color-orange)]"
              />
              WhatsApp is switched on
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[0.85rem]">
              <input
                type="checkbox"
                name="floatingEnabled"
                defaultChecked={settings.whatsapp.floatingEnabled}
                className="size-4 accent-[var(--color-orange)]"
              />
              Show the floating button on every page
            </label>
          </div>
          <div className="mt-5">
            <SubmitButton />
          </div>
        </AdminForm>
      ) : null}

      {tab === "social" ? <SocialPanel csrf={csrf} rows={social} /> : null}

      {tab === "disclaimers" ? (
        <AdminForm action={saveDisclaimers} className="admin-card max-w-3xl p-5">
          <input type="hidden" name="_csrf" value={csrf} />
          <h2 className="mb-1">Disclaimers</h2>
          <p className="mb-4 text-[0.8rem] text-muted">
            The government notice appears in the footer and, when switched on below, at the bottom of
            every service page. The visa notice is added on visa services automatically.
          </p>
          <div className="grid gap-4">
            {text("governmentEn", "governmentEn", "Government services notice (English)", settings.disclaimers.governmentEn, { rows: 4 })}
            {text("governmentAr", "governmentAr", "Government services notice (العربية)", settings.disclaimers.governmentAr, { rows: 4, rtl: true })}
            {text("visaEn", "visaEn", "Visa notice (English)", settings.disclaimers.visaEn, { rows: 3 })}
            {text("visaAr", "visaAr", "Visa notice (العربية)", settings.disclaimers.visaAr, { rows: 3, rtl: true })}
          </div>
          <label className="mt-4 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              name="showOnServicePages"
              defaultChecked={settings.disclaimers.showOnServicePages}
              className="mt-0.5 size-4 accent-[var(--color-orange)]"
            />
            <span>
              <span className="block text-[0.85rem] text-strong">Show on every service page</span>
              <span className="block text-[0.73rem] text-muted">
                Recommended. It is what keeps the site from reading as an official channel.
              </span>
            </span>
          </label>
          <div className="mt-5">
            <SubmitButton />
          </div>
        </AdminForm>
      ) : null}

      {tab === "features" ? (
        <AdminForm action={saveFeatures} className="admin-card max-w-3xl p-5">
          <input type="hidden" name="_csrf" value={csrf} />
          <h2 className="mb-4">Features</h2>
          <div className="space-y-3">
            {[
              {
                name: "arabicEnabled",
                label: "Arabic edition",
                hint: "Publishes /ar and shows the language switch. Turning it off hides both.",
                value: settings.features.arabicEnabled,
              },
              {
                name: "searchEnabled",
                label: "Site search",
                hint: "The search control in the header and the /search page.",
                value: settings.features.searchEnabled,
              },
              {
                name: "showVideos",
                label: "Video showcase",
                hint: "Video sections render only when this is on.",
                value: settings.features.showVideos,
              },
              {
                name: "showTestimonials",
                label: "Testimonials",
                hint: "Testimonial sections render only when this is on.",
                value: settings.features.showTestimonials,
              },
              {
                name: "showStats",
                label: "Statistics",
                hint: "Off until you have figures you can evidence. An empty statistics section never renders.",
                value: settings.features.showStats,
              },
              {
                name: "customCursor",
                label: "Pointer companion",
                hint: "A small ring that follows the pointer on desktop. Never shown on touch devices or with reduced motion.",
                value: settings.features.customCursor,
              },
            ].map((item) => (
              <label key={item.name} className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  name={item.name}
                  defaultChecked={item.value}
                  className="mt-0.5 size-4 accent-[var(--color-orange)]"
                />
                <span>
                  <span className="block text-[0.85rem] text-strong">{item.label}</span>
                  <span className="block text-[0.73rem] text-muted">{item.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-5">
            <SubmitButton />
          </div>
        </AdminForm>
      ) : null}

      {tab === "maintenance" ? <MaintenancePanel csrf={csrf} /> : null}
    </>
  );
}

/**
 * The one control here is deliberately not a Save button: nothing is stored.
 * It empties the caches the public pages read through, for the case editing
 * cannot reach — a change made to the database from outside the application,
 * such as `npm run restructure`.
 */
function MaintenancePanel({ csrf }: { csrf: string }) {
  return (
    <AdminForm
      action={refreshCaches}
      guardUnsaved={false}
      className="admin-card max-w-3xl p-5"
      successMessage="Caches refreshed."
    >
      <input type="hidden" name="_csrf" value={csrf} />
      <h2 className="mb-1">Refresh the site caches</h2>
      <p className="mb-4 text-[0.8rem] text-muted">
        Editing in this panel already refreshes what it changes, so you should not normally need
        this. Use it after something has changed the database from outside the website — a
        migration, a restored backup, or the service restructure (<code>npm run restructure</code>).
        It stores nothing and nothing is lost: the next visit to each page reads the database again.
      </p>
      <SubmitButton pendingLabel="Refreshing…">Refresh caches</SubmitButton>
    </AdminForm>
  );
}

/**
 * Social Media.
 *
 * Everything here is rendered by the server and every control is a real form,
 * so the panel works before hydration and after JavaScript fails — which is the
 * rule the rest of this page already follows. The add form is always present
 * rather than behind a toggle, and a row's fields sit in a `<details>`: a
 * disclosure the browser owns, with no state to get out of step.
 */
function SocialPanel({ csrf, rows }: { csrf: string; rows: SocialRow[] }) {
  return (
    <div className="max-w-3xl space-y-4">
      <div className="admin-card p-5">
        <h2>Add a network</h2>
        <p className="mb-4 mt-0.5 text-[0.78rem] text-muted">
          Each network is shown in the footer with its own mark, and its address is listed in the
          site’s Organization structured data as one of the accounts that belong to this business.
          https addresses only.
        </p>
        <SocialForm csrf={csrf} row={null} />
      </div>

      {rows.length === 0 ? null : (
        <ul className="space-y-2">
          {rows.map((row, index) => {
            const label = socialLabel(row.platform);
            return (
              <li key={row.id} className="admin-card p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--admin-line)]"
                    style={{ color: "var(--color-peach)" }}
                  >
                    <SocialIcon platform={row.platform} size={14} />
                  </span>
                  <span className="font-semibold text-strong">{label}</span>
                  <span className="truncate text-[0.76rem] text-muted" dir="ltr">
                    {row.url}
                  </span>
                  {!row.isPublished ? (
                    <span className="admin-badge" style={{ color: "#9aa2b5" }}>
                      Hidden
                    </span>
                  ) : null}

                  <div className="ms-auto flex gap-1.5">
                    <InlineAction action={moveSocialLink} hidden={{ _csrf: csrf, id: row.id, direction: "up" }}>
                      <button
                        type="submit"
                        disabled={index === 0}
                        aria-label={`Move ${label} up`}
                        className="admin-btn admin-btn-sm"
                      >
                        <Icon name="chevronDown" size={11} className="rotate-180" />
                      </button>
                    </InlineAction>
                    <InlineAction action={moveSocialLink} hidden={{ _csrf: csrf, id: row.id, direction: "down" }}>
                      <button
                        type="submit"
                        disabled={index === rows.length - 1}
                        aria-label={`Move ${label} down`}
                        className="admin-btn admin-btn-sm"
                      >
                        <Icon name="chevronDown" size={11} />
                      </button>
                    </InlineAction>
                    <InlineAction action={toggleSocialLink} hidden={{ _csrf: csrf, id: row.id }}>
                      <button
                        type="submit"
                        aria-label={`${row.isPublished ? "Hide" : "Show"} ${label}`}
                        className="admin-btn admin-btn-sm"
                      >
                        <Icon name={row.isPublished ? "eyeOff" : "eye"} size={11} />
                        {row.isPublished ? "Hide" : "Show"}
                      </button>
                    </InlineAction>
                    <InlineAction action={deleteSocialLink} hidden={{ _csrf: csrf, id: row.id }}>
                      <ConfirmSubmit className="admin-btn-sm" message={`Remove the ${label} link?`}>
                        <Icon name="trash" size={11} />
                        <span className="sr-only">{`Remove ${label}`}</span>
                      </ConfirmSubmit>
                    </InlineAction>
                  </div>
                </div>

                <details className="mt-3">
                  <summary className="cursor-pointer text-[0.78rem] text-muted">
                    {`Edit ${label}`}
                  </summary>
                  <div className="mt-3 border-t border-[var(--admin-line)] pt-3">
                    <SocialForm csrf={csrf} row={row} />
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SocialForm({ csrf, row }: { csrf: string; row: SocialRow | null }) {
  const key = row?.id ?? "new";
  // The network is picked, not typed: the same registry drives this menu, the
  // footer's mark and the check the action runs on save, so an admin cannot
  // reach a state where a link is stored under a key nothing can draw.
  const [platform, setPlatform] = useState(
    row ? normalizeSocialPlatformKey(row.platform) : SOCIAL_PLATFORMS[0]!.key,
  );
  const known = socialPlatform(platform);

  return (
    <AdminForm action={saveSocialLink} successMessage={row ? "Link saved." : "Link added."}>
      <input type="hidden" name="_csrf" value={csrf} />
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Network" name={`platform-${key}`}>
          <div className="flex items-center gap-2">
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--admin-line)]"
              style={{ color: "var(--color-peach)" }}
            >
              <SocialIcon platform={platform} size={17} />
            </span>
            <select
              id={`platform-${key}`}
              name="platform"
              value={platform}
              onChange={(event) => setPlatform(event.target.value)}
              className="admin-select"
            >
              {SOCIAL_PLATFORMS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
              {/* A row saved before this network was on the list keeps its own
                  key until somebody deliberately changes it. */}
              {known ? null : <option value={platform}>{socialLabel(platform)} (not on the list)</option>}
            </select>
          </div>
        </Field>
        <Field label="Address" name={`url-${key}`} className="sm:col-span-2">
          <input
            id={`url-${key}`}
            name="url"
            type="url"
            defaultValue={row?.url ?? ""}
            required
            dir="ltr"
            placeholder={known?.urlHint ?? "https://"}
            className="admin-input"
          />
        </Field>
      </div>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-[0.82rem]">
        <input
          type="checkbox"
          name="isPublished"
          defaultChecked={row?.isPublished ?? true}
          className="size-4 accent-[var(--color-orange)]"
        />
        Shown in the footer
      </label>
      <div className="mt-4">
        <SubmitButton className="admin-btn-sm">{row ? "Save link" : "Add link"}</SubmitButton>
      </div>
    </AdminForm>
  );
}
