import type { ReactNode } from "react";

import { editorNode, type EditorRender } from "@/lib/visual-editor/render";

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
   * Editor annotation, passed straight through from the block.
   *
   * Eleven blocks open with this heading, so marking the three parts here
   * marks them everywhere at once — and the field *names* differ between
   * blocks (`intro` here, `body` there), which is why the caller supplies them
   * rather than this component assuming. Off by default: with no `editor` the
   * markup is byte-for-byte what it was.
   */
  editor?: EditorRender;
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
  fields,
}: Props) {
  if (!eyebrow && !title && !intro && !children) return null;
  const Tag = level === 1 ? "h1" : "h2";
  const node = editorNode(editor);
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
