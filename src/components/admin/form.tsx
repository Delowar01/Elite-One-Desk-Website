"use client";

import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";

import { Icon } from "@/components/ui/icon";
import type { ActionState } from "@/lib/admin/actions";

const EMPTY: ActionState = { ok: false };

export type FormAction = (prev: ActionState, form: FormData) => Promise<ActionState>;

/**
 * The dispatch for an `AdminForm`'s second action, for `AlternateSubmit`.
 *
 * Passed through context rather than as a render prop so `children` stays an
 * ordinary `ReactNode` for the twenty screens that only ever need one action.
 */
const AlternateDispatch = createContext<((payload: FormData) => void) | null>(null);

export function SubmitButton({
  children = "Save changes",
  pendingLabel = "Saving…",
  variant = "primary",
  className = "",
}: {
  children?: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "ghost" | "danger";
  className?: string;
}) {
  const { pending } = useFormStatus();
  const variantClass =
    variant === "primary" ? "admin-btn-primary" : variant === "danger" ? "admin-btn-danger" : "";
  return (
    <button type="submit" disabled={pending} className={`admin-btn ${variantClass} ${className}`}>
      {pending ? pendingLabel : children}
    </button>
  );
}

/**
 * The shared wrapper for every admin form.
 *
 * It owns three things that would otherwise be re-implemented on each screen:
 * the result banner, the "you have unsaved changes" guard, and resetting the
 * dirty flag once a save comes back clean. `onSaved` lets a screen refresh a
 * list without the form knowing anything about it.
 *
 * `alternate` is a second action the same fields can be submitted to, reached
 * with `AlternateSubmit`. One form, two intents — "Save draft" and "Save and
 * publish" send byte-identical values and differ only in what the server should
 * do with them. Both come back through the same banner and clear the same
 * unsaved-changes state, because from the editor's point of view the work is
 * saved either way. Exactly one of the two runs per submission, which is why
 * "whichever answered last" is a complete rule rather than a race.
 */
export function AdminForm({
  action,
  alternate,
  children,
  footer,
  className = "",
  guardUnsaved = true,
  onSaved,
  successMessage = "Saved.",
}: {
  action: FormAction;
  alternate?: FormAction;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  guardUnsaved?: boolean;
  onSaved?: (state: ActionState) => void;
  successMessage?: string;
}) {
  const [primary, formAction] = useActionState<ActionState, FormData>(action, EMPTY);
  // Called unconditionally — hooks cannot be conditional — and harmlessly bound
  // to the primary action on the screens that declare no second one, where
  // nothing ever dispatches it.
  const [secondary, alternateAction] = useActionState<ActionState, FormData>(
    alternate ?? action,
    EMPTY,
  );
  const [state, setState] = useState<ActionState>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const lastHandled = useRef<ActionState | null>(null);

  useEffect(() => {
    if (primary !== EMPTY) setState(primary);
  }, [primary]);
  useEffect(() => {
    if (secondary !== EMPTY) setState(secondary);
  }, [secondary]);

  useEffect(() => {
    if (state === EMPTY || lastHandled.current === state) return;
    lastHandled.current = state;
    if (state.ok) {
      setDirty(false);
      onSaved?.(state);
    }
  }, [state, onSaved]);

  // §45: leaving a half-edited form should cost a confirmation, not the work.
  useEffect(() => {
    if (!guardUnsaved || !dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, guardUnsaved]);

  return (
    <AlternateDispatch.Provider value={alternate ? alternateAction : null}>
    <form
      ref={formRef}
      action={formAction}
      onChange={() => setDirty(true)}
      className={className}
      noValidate
    >
      {state !== EMPTY && (state.message || state.ok) ? (
        <p
          role="status"
          className="mb-4 flex items-start gap-2 rounded-[var(--radius-sm)] border p-3 text-[0.8rem]"
          style={
            state.ok
              ? { borderColor: "#3ddc8466", background: "#3ddc840f", color: "#9ff0c4" }
              : { borderColor: "#ef535066", background: "#ef53500f", color: "#ffb4ad" }
          }
        >
          <Icon name={state.ok ? "check" : "close"} size={14} className="mt-0.5 shrink-0" />
          {state.message ?? successMessage}
        </p>
      ) : null}

      {children}

      {footer ? (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {footer}
          {dirty ? <span className="text-[0.74rem] text-muted">Unsaved changes</span> : null}
        </div>
      ) : null}
    </form>
    </AlternateDispatch.Provider>
  );
}

/**
 * Submits the form's fields to its `alternate` action instead of its own.
 *
 * The intent is **which action the browser invoked**, never a value inside the
 * request. That is not a stylistic preference: a `<button name="…" value="…">`
 * relies on React re-inserting the submitter as a temporary input before
 * building the FormData, and that shim re-parents itself using `form.id` —
 * which, on a form containing a control named `id`, is the input element rather
 * than the form's identifier, so the temporary input is associated with a form
 * that does not exist and the value silently vanishes. A hidden field set on
 * click has a different failure: the value it was last set to outlives the
 * submission, so a later Enter can carry an intent nobody chose. A second
 * action has neither problem, and the Enter key keeps the form's own action,
 * which is always the safe one.
 */
export function AlternateSubmit({
  children,
  pendingLabel = "Saving…",
  variant = "primary",
  className = "",
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "ghost" | "danger";
  className?: string;
}) {
  const dispatch = useContext(AlternateDispatch);
  const { pending } = useFormStatus();
  const variantClass =
    variant === "primary" ? "admin-btn-primary" : variant === "danger" ? "admin-btn-danger" : "";
  if (!dispatch) return null;
  return (
    <button
      type="submit"
      formAction={dispatch}
      disabled={pending}
      className={`admin-btn ${variantClass} ${className}`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

/** A labelled field with optional hint and inline error. */
export function Field({
  label,
  name,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  name?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="admin-label" htmlFor={name}>
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="mt-1 text-[0.74rem]" style={{ color: "#ff9a95" }}>
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-[0.73rem] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Confirmation for anything destructive. A native dialog rather than a custom
 * modal: it cannot be missed, it cannot be styled into looking harmless, and it
 * works before hydration finishes.
 */
export function ConfirmSubmit({
  children,
  message,
  variant = "danger",
  className = "",
}: {
  children: ReactNode;
  message: string;
  variant?: "primary" | "ghost" | "danger";
  className?: string;
}) {
  const { pending } = useFormStatus();
  const variantClass =
    variant === "primary" ? "admin-btn-primary" : variant === "danger" ? "admin-btn-danger" : "";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`admin-btn ${variantClass} ${className}`}
      onClick={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

/**
 * A one-control form for a single action — reorder, hide, publish, delete.
 *
 * Server Actions return an `ActionState`, which a bare `<form action={…}>` will
 * not accept, so the state hook is what makes these usable inline. The result is
 * surfaced through `onResult` where a screen wants to show it; most of these
 * actions revalidate the page and need no banner of their own.
 */
export function InlineAction({
  action,
  hidden,
  children,
  className = "inline",
  onResult,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  hidden: Record<string, string | number>;
  children: ReactNode;
  className?: string;
  onResult?: (state: ActionState) => void;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, EMPTY);
  const seen = useRef<ActionState | null>(null);

  useEffect(() => {
    if (state === EMPTY || seen.current === state) return;
    seen.current = state;
    onResult?.(state);
  }, [state, onResult]);

  return (
    <form action={formAction} className={className}>
      {Object.entries(hidden).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      {children}
    </form>
  );
}
