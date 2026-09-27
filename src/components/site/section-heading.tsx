import type { ReactNode } from "react";

import type { MotionDocument } from "@/lib/cms/motion-doc";
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
  /** The block's motion, passed straight through beside its styles. */
  motion?: MotionDocument | null;
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
  motion,
  fields,
}: Props) {
  if (!eyebrow && !title && !intro && !children) return null;
  const Tag = level === 1 ? "h1" : "h2";
  const node = blockNode({ editor, styles, motion });
  /**
   * A heading part's attributes and its text, decided together — so a part
   * set to arrive word by word gets its words and its marker in one step
   * (Batch 15b). With no field name there is nothing to annotate, and the
   * text is simply the text.
   */
  const part = (name: string | undefined, value: string) =>
    name ? node.text(`field:${name}`, value) : { attrs: {}, content: value };
  const eyebrowPart = eyebrow ? part(fields?.eyebrow, eyebrow) : null;
  const titlePart = title ? part(fields?.title, title) : null;
  const introPart = intro ? part(fields?.intro, intro) : null;

  return (
    <Reveal
      className={`flex flex-col gap-4 ${align === "center" ? "items-center text-center" : ""} ${className}`}
    >
      {eyebrowPart ? (
        <p className="eyebrow" {...eyebrowPart.attrs}>
          {eyebrowPart.content}
        </p>
      ) : null}
      {titlePart ? (
        <Tag
          className={level === 1 ? "text-[length:var(--text-h1)]" : "text-[length:var(--text-h2)]"}
          {...titlePart.attrs}
        >
          {titlePart.content}
        </Tag>
      ) : null}
      {introPart ? (
        <p className={`lede ${align === "center" ? "max-w-2xl" : "max-w-xl"}`} {...introPart.attrs}>
          {introPart.content}
        </p>
      ) : null}
      {children}
    </Reveal>
  );
}
