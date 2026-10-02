"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Field } from "@/components/admin/form";
import type { ActionState } from "@/lib/admin/actions";
import { changeOwnPassword } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="admin-btn admin-btn-primary w-full">
      {pending ? "Changing your password…" : "Change password"}
    </button>
  );
}

/**
 * The three fields, and nothing that names an account: the action changes the
 * password of the session that sends it. The token is that session's.
 */
export function ChangePasswordForm({ csrf }: { csrf: string }) {
  const [state, action] = useActionState<ActionState, FormData>(changeOwnPassword, { ok: false });
  const errors = state.errors ?? {};

  return (
    <form action={action} className="flex flex-col gap-4" aria-label="Choose a new password">
      <input type="hidden" name="_csrf" value={csrf} />

      {state.message ? (
        <p
          role="alert"
          className="rounded-[var(--radius-sm)] border p-3 text-[0.8rem]"
          style={{ borderColor: "#ef535066", background: "#ef53500f", color: "#ffb4ad" }}
        >
          {state.message}
        </p>
      ) : null}

      <Field label="Current (temporary) password" name="currentPassword" error={errors.currentPassword}>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          className="admin-input"
        />
      </Field>

      <Field
        label="New password"
        name="password"
        error={errors.password}
        hint="At least 12 characters with upper case, lower case and a digit — and not the temporary one."
      >
        <input id="password" name="password" type="password" autoComplete="new-password" required className="admin-input" />
      </Field>

      <Field label="Confirm the new password" name="confirmPassword" error={errors.confirmPassword}>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          className="admin-input"
        />
      </Field>

      <SubmitButton />
    </form>
  );
}
