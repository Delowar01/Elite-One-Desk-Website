import type { MediaRef } from "@/lib/media/url";
import type {
  CategoryRow,
  DestinationRow,
  FaqRow,
  PackageRow,
  ServiceRow,
  SubcategoryRow,
  TestimonialRow,
  VideoRow,
} from "@/lib/queries/catalog";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import type { SiteSettings } from "@/lib/settings";
import type { EditorRender } from "@/lib/visual-editor/render";

/**
 * Everything a section might need, fetched once per page render and handed
 * down. A block never opens its own connection: that is what turns a twelve
 * section homepage into forty queries.
 */
export type BlockContext = {
  locale: Locale;
  dict: Dictionary;
  settings: SiteSettings;
  media: Map<number, MediaRef>;
  catalog: {
    categories: CategoryRow[];
    services: ServiceRow[];
    subcategories: SubcategoryRow[];
    byCategory: Map<number, ServiceRow[]>;
  };
  packages: PackageRow[];
  destinations: DestinationRow[];
  videos: VideoRow[];
  testimonials: TestimonialRow[];
  faqs: FaqRow[];
  whatsappHref: string | null;
};

export type BlockProps = {
  values: Record<string, unknown>;
  ctx: BlockContext;
  /** Position on the page — used to give the first section hero treatment. */
  index: number;
  /**
   * Set only when the page is being rendered as an authorised Visual Editor
   * canvas; `undefined` on every ordinary request, including `?preview=1`.
   *
   * Deliberately the smallest thing that works: the section's id and its block
   * type, which is everything a block needs to name its own nodes. What is
   * selected, what the inspector shows, the bridge id, the session and the
   * permissions are the editor's business — a public block that knew any of
   * them would be a public block that could leak them.
   */
  editor?: EditorRender;
};
