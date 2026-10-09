"use client";

import {
  createContext,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";

import { Icon } from "@/components/ui/icon";
import type { ActionState } from "@/lib/admin/actions";

const EMPTY: ActionState = { ok: false };

export type FormAction = (prev: ActionState, form: FormData) => Promise<ActionState>;

/** How often, and for how long, an answer that is not on screen is helped onto it. */
const NUDGE_EVERY_MS = 300;
const NUDGE_FOR_MS = 15_000;

/**
 * `useActionState` that makes sure its answer reaches the screen (19C).
 *
 * The admin saves through Server Actions that revalidate the page, so an
 * action's response carries the re-rendered screen as well as its answer, and
 * React renders both in one transition. With the React that Next 15.5 bundles
 * (19.2.0-canary-0bdb9206-20250818) that transition can stall for good: the
 * server has saved, the button still says "Saving…", and the screen shows
 * nothing new. On cold servers it happened to 8 of 36 account creations and
 * 15 of 36 question saves (and to 8 of 36 question saves on the 19B release
 * candidate, so it is not new). Read off the root while stalled, every time:
 * one transition lane pending, suspended and entangled, no ping, no callback
 * — the state 19B traced to a ping React drops when a stream chunk resolves
 * while it is rendering (`pingSuspendedRoot`, defect 6). Nothing is left to
 * wake it until the next update of any kind — a keystroke, a click — which
 * clears the suspended lanes and lets the render finish.
 *
 * So once the server has answered, this makes that update itself: a no-op
 * state change of its own every `NUDGE_EVERY_MS` until the answer is on
 * screen. One update is all React needs — scheduling it clears the suspended
 * lanes (`markRootUpdated`) and the transition, whose data arrived long
 * before, renders and commits. An answer that commits normally is on screen
 * before the first check and is never nudged. Held by
 * `tests/stress/admin-form-settle.stress.mts`.
 *
 * An action that sends the browser elsewhere — `redirect()` after a create or
 * a delete — does not answer: it throws, and the screen it sends the browser
 * to is rendered in a transition that stalls in exactly the same way (Batch
 * 26: a package created, its row stored, and the screen left on "Saving…" at
 * /admin/packages/new — on a warm server 4 creates in 26 and 1 delete in 25,
 * and 2 creates in 25 on Batch 25, so not new; the root in the state above
 * every time, and each create a keystroke was tried on landed at once). So a
 * throw is nudged too, until the form has gone — which is the next screen
 * arriving — and is then handed on to Next.js exactly as it came.
 *
 * Until the form has hydrated, the hook hands React the Server Action itself,
 * not the wrapper: React writes a server reference into the server-rendered
 * form as hidden fields, so a form submitted before hydration — or without
 * JavaScript — still posts straight to the action. A client function there
 * would leave the form unable to submit at all until the page had hydrated.
 */
export function useSettledActionState(
  action: FormAction,
  initial: ActionState,
): [ActionState, (payload: FormData) => void, boolean] {
  const [, nudge] = useReducer((count: number) => count + 1, 0);
  /** The answer the server gave that the screen does not show yet. */
  const unseen = useRef<ActionState | null>(null);
  const mounted = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    mounted.current = true;
    setHydrated(true);
    return () => {
      mounted.current = false;
    };
  }, []);

  /** A no-op update every `NUDGE_EVERY_MS` until `done()`, the form has gone, or `NUDGE_FOR_MS` has passed. */
  const nudgeUntil = useCallback((done: () => boolean) => {
    const deadline = Date.now() + NUDGE_FOR_MS;
    const check = () => {
      if (!mounted.current || done() || Date.now() > deadline) return;
      nudge();
      window.setTimeout(check, NUDGE_EVERY_MS);
    };
    window.setTimeout(check, NUDGE_EVERY_MS);
  }, []);

  const settled = useCallback(
    async (previous: ActionState, payload: FormData): Promise<ActionState> => {
      let answer: ActionState;
      try {
        answer = await action(previous, payload);
      } catch (error) {
        // A redirect, or a failure: what renders next replaces this form.
        nudgeUntil(() => false);
        throw error;
      }
      unseen.current = answer;
      nudgeUntil(() => unseen.current !== answer);
      return answer;
    },
    [action, nudgeUntil],
  );

  // React reads the action a dispatch calls from its latest render, so the
  // switch to `settled` after hydration needs no new dispatch.
  const [state, dispatch, pending] = useActionState<ActionState, FormData>(hydrated ? settled : action, initial);
  useEffect(() => {
    if (unseen.current === state) unseen.current = null;
  }, [state]);
  return [state, dispatch, pending];
}

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
  const [primary, formAction] = useSettledActionState(action, EMPTY);
  // Called unconditionally — hooks cannot be conditional — and harmlessly bound
  // to the primary action on the screens that declare no second one, where
  // nothing ever dispatches it.
  const [secondary, alternateAction] = useSettledActionState(alternate ?? action, EMPTY);
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
  const [state, formAction] = useSettledActionState(action, EMPTY);
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
