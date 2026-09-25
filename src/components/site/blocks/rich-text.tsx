import { Reveal } from "@/components/site/reveal";
import { text } from "@/lib/cms/values";
import { blockNode } from "@/lib/cms/node";
import type { BlockProps } from "./context";

export function RichTextBlock({ values, ctx, editor, styles, motion }: BlockProps) {
  const { locale } = ctx;
  const body = text(values, "body", locale);
  const title = text(values, "title", locale);
  const eyebrow = text(values, "eyebrow", locale);
  if (!body && !title) return null;
  const node = blockNode({ editor, styles, motion });

  return (
    <section className="section-tight">
      <div className="shell">
        <Reveal className="mx-auto max-w-3xl">
          {eyebrow ? (
            <p className="eyebrow mb-4" {...node("field:eyebrow")}>
              {eyebrow}
            </p>
          ) : null}
          {title ? (
            <h2 className="mb-6 text-[length:var(--text-h2)]" {...node("field:title")}>
              {title}
            </h2>
          ) : null}
          {/* Sanitised on save by lib/cms/sanitize.ts — the stored string can
              only contain the whitelisted tags. */}
          <div
            className="prose-eod"
            {...node("field:body")}
            dangerouslySetInnerHTML={{ __html: body }}
          />
        </Reveal>
      </div>
    </section>
  );
}
