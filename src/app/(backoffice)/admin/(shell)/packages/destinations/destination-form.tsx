"use client";

import { useState } from "react";

import { AdminForm, ConfirmSubmit, Field, SubmitButton } from "@/components/admin/form";
import { MediaPicker, type MediaOption } from "@/components/admin/media-picker";
import { createDestination, deleteDestination, updateDestination } from "./actions";

export type DestinationValues = {
  id?: number;
  slug: string;
  titleEn: string;
  titleAr: string;
  summaryEn: string;
  summaryAr: string;
  imageId: number | null;
  isPublished: boolean;
  sortOrder: number;
};

/** English and Arabic side by side, the same pairing the package form uses. */
function Pair({
  label,
  name,
  values,
  kind = "input",
  rows = 3,
  hint,
}: {
  label: string;
  name: string;
  values: Record<string, string>;
  kind?: "input" | "textarea";
  rows?: number;
  hint?: string;
}) {
  const en = `${name}En`;
  const ar = `${name}Ar`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={`${label} (English)`} name={en} hint={hint}>
        {kind === "textarea" ? (
          <textarea id={en} name={en} rows={rows} defaultValue={values[en] ?? ""} className="admin-textarea" />
        ) : (
          <input id={en} name={en} defaultValue={values[en] ?? ""} className="admin-input" />
        )}
      </Field>
      <Field label={`${label} (العربية)`} name={ar}>
        {kind === "textarea" ? (
          <textarea
            id={ar}
            name={ar}
            rows={rows}
            dir="rtl"
            defaultValue={values[ar] ?? ""}
            className="admin-textarea"
          />
        ) : (
          <input id={ar} name={ar} dir="rtl" defaultValue={values[ar] ?? ""} className="admin-input" />
        )}
      </Field>
    </div>
  );
}

export function DestinationForm({
  csrf,
  destination,
  media,
}: {
  csrf: string;
  destination: DestinationValues;
  media: MediaOption[];
}) {
  const isNew = !destination.id;
  const [imageId, setImageId] = useState<number | null>(destination.imageId);
  const values = destination as unknown as Record<string, string>;

  return (
    <AdminForm
      action={isNew ? createDestination : updateDestination}
      className="admin-card p-5"
      successMessage={isNew ? "Destination created." : "Destination saved."}
    >
      <input type="hidden" name="_csrf" value={csrf} />
      {destination.id ? <input type="hidden" name="id" value={destination.id} /> : null}
      <input type="hidden" name="imageId" value={imageId ?? ""} />

      <div className="space-y-5">
        <Pair label="Name" name="title" values={values} />
        <Pair
          label="Summary"
          name="summary"
          values={values}
          kind="textarea"
          rows={4}
          hint="Shown on the destination page under its name, and used as the page description."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Address"
            name="slug"
            hint="The page becomes /packages/<address>. It must not match a package address."
          >
            <input
              id="slug"
              name="slug"
              defaultValue={destination.slug}
              required
              dir="ltr"
              className="admin-input"
            />
          </Field>
          <Field label="Order" name="sortOrder">
            <input
              id="sortOrder"
              name="sortOrder"
              type="number"
              min={0}
              defaultValue={destination.sortOrder}
              className="admin-input"
            />
          </Field>
        </div>

        <div>
          <span className="admin-label">Image</span>
          <MediaPicker
            value={imageId}
            onChange={setImageId}
            options={media}
            label="Destination image"
          />
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-[0.82rem]">
          <input
            type="checkbox"
            name="isPublished"
            defaultChecked={destination.isPublished}
            className="size-4 accent-[var(--color-orange)]"
          />
          Published
        </label>
      </div>

      <div className="mt-6 border-t border-[var(--admin-line)] pt-5">
        <SubmitButton>{isNew ? "Create destination" : "Save changes"}</SubmitButton>
      </div>
    </AdminForm>
  );
}

export function DeleteDestination({
  csrf,
  id,
  title,
  packageCount,
}: {
  csrf: string;
  id: number;
  title: string;
  packageCount: number;
}) {
  return (
    <AdminForm action={deleteDestination} guardUnsaved={false} className="admin-card p-5">
      <input type="hidden" name="_csrf" value={csrf} />
      <input type="hidden" name="id" value={id} />
      <h2 className="text-strong">Delete this destination</h2>
      <p className="mt-2 text-[0.84rem] text-muted">
        {packageCount === 0
          ? "No packages are assigned to it."
          : `${packageCount} package${packageCount === 1 ? "" : "s"} will stay, without a destination, until you file them somewhere else.`}
      </p>
      <div className="mt-4">
        <ConfirmSubmit
          className="admin-btn admin-btn-danger"
          message={`Delete “${title}”? The packages inside it are not deleted.`}
        >
          Delete destination
        </ConfirmSubmit>
      </div>
    </AdminForm>
  );
}
