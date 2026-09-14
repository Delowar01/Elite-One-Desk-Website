import type { IconName } from "@/lib/icons";

/**
 * The canvas viewports, as one typed source of truth.
 *
 * These are **logical layout widths**, not maximum widths. The failure this
 * exists to prevent: an editor selects Desktop, the centre workspace happens to
 * be 1100px wide, the iframe is given `max-width: 1440px` — and the page inside
 * lays itself out at 1100px, which is the tablet design. The editor then shows
 * a layout no visitor at that device would see, and the person editing it makes
 * decisions about a page that does not exist.
 *
 * So the iframe is always given the exact width below and scaled visually to
 * fit the stage. A scaled 1440px page is still a 1440px page: the same media
 * queries match, the same grid tracks resolve, `window.innerWidth` still reads
 * 1440. A 1100px iframe labelled "Desktop" is not.
 *
 * 1440 / 834 / 390 are the common design widths and sit either side of the
 * site's breakpoints (640/768/1024/1280/1536), so each one picks a genuinely
 * different layout rather than landing on a boundary.
 */
export const EDITOR_DEVICES = [
  { key: "desktop", label: "Desktop", width: 1440, icon: "desk" },
  { key: "tablet", label: "Tablet", width: 834, icon: "fileText" },
  { key: "mobile", label: "Mobile", width: 390, icon: "idCard" },
] as const satisfies readonly { key: string; label: string; width: number; icon: IconName }[];

export type EditorDevice = (typeof EDITOR_DEVICES)[number];
export type DeviceKey = EditorDevice["key"];

export const DEFAULT_DEVICE: DeviceKey = "desktop";

const BY_KEY = new Map<string, EditorDevice>(EDITOR_DEVICES.map((device) => [device.key, device]));

export const isDeviceKey = (value: unknown): value is DeviceKey =>
  typeof value === "string" && BY_KEY.has(value);

/** A device from stored or URL state, falling back rather than throwing. */
export const deviceOrDefault = (value: unknown): DeviceKey =>
  isDeviceKey(value) ? value : DEFAULT_DEVICE;

export const deviceWidth = (key: DeviceKey): number => BY_KEY.get(key)!.width;
