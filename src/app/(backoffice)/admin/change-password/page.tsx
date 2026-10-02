import { redirect } from "next/navigation";

import { Logo } from "@/components/ui/logo";
import { readSession } from "@/lib/auth/session";
import { signOut } from "../login/actions";
import { ChangePasswordForm } from "./change-password-form";

export const metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

/**
 * Where an account on a temporary password is sent, from wherever it was
 * going (19C), and the only admin page it can open until it has chosen its
 * own password.
 *
 * Outside `(shell)` on purpose: that layout refuses this session and sends it
 * here, so the page has to be somewhere the refusal does not apply. What it
 * offers is the whole of what such a session may do — change the password, or
 * sign out. No navigation, no other screen, nothing of the role it holds: that
 * role applies again after the new password has been used to sign in.
 */
export default async function ChangePasswordPage() {
  const session = await readSession();
  if (!session) redirect("/admin/login");
  // Nothing to change: an ordinary session has no business here.
  if (!session.mustChangePassword) redirect("/admin");

  return (
    <div className="flex min-h-dvh items-center justify-center p-5">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo height={44} priority />
        </div>

        <div className="admin-card p-7" data-password-change>
          <h1 className="mb-1">Choose a new password</h1>
          <p className="mb-2 text-[0.82rem] text-muted">
            You signed in with a temporary password. Choose your own to continue — until you do, nothing
            else in the panel is available.
          </p>
          <p className="mb-6 text-[0.78rem] text-muted">
            Signed in as <span className="text-strong">{session.user.email}</span>. Once it is changed,
            every session for this account is signed out and you sign in again with the new password.
          </p>
          <ChangePasswordForm csrf={session.csrfToken} />
        </div>

        <form action={signOut} className="mt-5 flex justify-center">
          <button type="submit" className="admin-btn admin-btn-sm">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
