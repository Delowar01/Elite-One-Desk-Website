/**
 * The settings panels.
 *
 * Shared rather than declared in the client component, because the server page
 * reads `?tab=` and has to validate it — and a `"use client"` module's
 * functions cannot be called from the server at all.
 */
export const SETTINGS_TABS = [
  { key: "brand", label: "Brand" },
  { key: "contact", label: "Contact" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "social", label: "Social Media" },
  { key: "disclaimers", label: "Disclaimers" },
  { key: "features", label: "Features" },
  { key: "maintenance", label: "Maintenance" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];

export const isSettingsTab = (value: string | undefined): value is SettingsTab =>
  SETTINGS_TABS.some((tab) => tab.key === value);
