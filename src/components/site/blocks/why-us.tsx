import { Reveal } from "@/components/site/reveal";
import { SectionHeading } from "@/components/site/section-heading";
import { Icon } from "@/components/ui/icon";
import { getBlock } from "@/lib/cms/blocks";
import { items, text } from "@/lib/cms/values";
import { blockNode } from "@/lib/cms/node";
import { itemFieldPath, itemPath } from "@/lib/visual-editor/render";
import type { BlockProps } from "./context";

const ICONS = ["users", "layers", "route", "landmark", "briefcase", "shield", "globe", "desk"];

export function WhyUsBlock({ values, ctx, editor, styles, motion }: BlockProps) {
  const { locale } = ctx;
  const def = getBlock("why-us")!;
  const fields = def.fields.find((f) => f.name === "points")!.itemFields ?? [];
  const points = items(values, "points", locale, fields);
  const node = blockNode({ editor, styles, motion });
  if (!points.length) return null;

  return (
    <section className="section-tight">
      <div className="shell shell-wide">
        <SectionHeading
          editor={editor}
          styles={styles}
          motion={motion}
          fields={{ eyebrow: "eyebrow", title: "title", intro: "intro" }}
          eyebrow={text(values, "eyebrow", locale)}
          title={text(values, "title", locale)}
          intro={text(values, "intro", locale)}
        />

        <ul
          className="mt-11 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3"
          {...node("field:points")}
        >
          {points.map((point, index) => (
            <Reveal
              as="li"
              key={point.label}
              delay={index * 55}
              nodeAttrs={node(itemPath("points", point), "item")}
            >
              <span
                className="mb-4 flex size-11 items-center justify-center rounded-[var(--radius-sm)] border border-line"
                style={{ color: "var(--color-peach)" }}
              >
                <Icon name={ICONS[index % ICONS.length]!} size={19} />
              </span>
              <h3 className="text-[1.02rem]" {...node(itemFieldPath("points", point, "label"))}>
                {point.label}
              </h3>
              {point.text ? (
                <p className="mt-2 text-small text-muted" {...node(itemFieldPath("points", point, "text"))}>
                  {point.text}
                </p>
              ) : null}
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
