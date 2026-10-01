"use client";

import { useRouter } from "next/navigation";

import type { MediaOption } from "@/components/admin/media-picker";
import { ReuseEditor, type ReuseEditorCan } from "@/components/admin/reuse/reuse-editor";

/** The full-page home of a component's editor — the same editor the Visual Editor's drawer shows. */
export function ComponentDetail({
  id,
  csrf,
  can,
  media,
}: {
  id: number;
  csrf: string;
  can: ReuseEditorCan;
  media: MediaOption[];
}) {
  const router = useRouter();
  return (
    <ReuseEditor
      componentId={id}
      csrf={csrf}
      can={can}
      media={media}
      locale="en"
      onChanged={(_view, event) => {
        // The browser goes back to the list, for the reason the list opens a
        // new component that way (see `components-client.tsx`, 19B): a push
        // right after the delete action could be left uncommitted.
        if (event === "deleted") window.location.assign("/admin/components");
        else router.refresh();
      }}
    />
  );
}
