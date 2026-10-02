/**
 * Which category page carries the Tour Packages panel.
 *
 * This is the public route's own rendering rule, unchanged since the package
 * catalogue was added — it lived as a constant at the top of the category page
 * and was moved here verbatim in Batch 21 so that the page and the Visual
 * Editor's category adapter ask the same question. The editor has no slug of
 * its own: it offers the panel wherever the route draws it.
 */
const PACKAGE_HUB_CATEGORY = "travel-tourism";

export const hasPackageHub = (category: { slug: string }): boolean => category.slug === PACKAGE_HUB_CATEGORY;
