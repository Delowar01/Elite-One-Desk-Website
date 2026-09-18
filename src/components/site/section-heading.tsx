import type { ReactNode } from "react";

import { blockNode } from "@/lib/cms/node";
import type { StyleDocument } from "@/lib/cms/styles";
import type { EditorRender } from "@/lib/visual-editor/render";

import { Reveal } from "./reveal";

type Props = {
  eyebrow?: string;
  title?: string;
  intro?: string;
  align?: "start" | "center";
  className?: string;
  children?: ReactNode;
  /** Renders as h1 on a page's opening section. */
  level?: 1 | 2;
  /**
   * The block's node context, passed straight through.
   *
   * Eleven blocks open with this heading, so naming the three parts here names
   * them everywhere at once — and the field *names* differ between blocks
   * (`intro` here, `body` there), which is why the caller supplies them rather
   * than this component assuming.
   *
   * Both halves travel together for the reason the whole node model exists: the
   * element an editor selects and the element their style lands on have to be
   * the same one. Taking `editor` without `styles` made these three nodes
   * selectable and unstyleable — a saved override that the panel showed and the
   * page ignored. Off by default in both directions: with neither prop the
   * markup is byte-for-byte what it was.
   */
  editor?: EditorRender;
  styles?: StyleDocument;
  fields?: { eyebrow?: string; title?: string; intro?: string };
};

export function SectionHeading({
  eyebrow,
  title,
  intro,
  align = "start",
  className = "",
  children,
  level = 2,
  editor,
  styles,
  fields,
}: Props) {
  if (!eyebrow && !title && !intro && !children) return null;
  const Tag = level === 1 ? "h1" : "h2";
  const node = blockNode({ editor, styles });
  const at = (name: string | undefined) => (name ? node(`field:${name}`) : {});

  return (
    <Reveal
      className={`flex flex-col gap-4 ${align === "center" ? "items-center text-center" : ""} ${className}`}
    >
      {eyebrow ? (
        <p className="eyebrow" {...at(fields?.eyebrow)}>
          {eyebrow}
        </p>
      ) : null}
      {title ? (
        <Tag
          className={level === 1 ? "text-[length:var(--text-h1)]" : "text-[length:var(--text-h2)]"}
          {...at(fields?.title)}
        >
          {title}
        </Tag>
      ) : null}
      {intro ? (
        <p className={`lede ${align === "center" ? "max-w-2xl" : "max-w-xl"}`} {...at(fields?.intro)}>
          {intro}
        </p>
      ) : null}
      {children}
    </Reveal>
  );
}
