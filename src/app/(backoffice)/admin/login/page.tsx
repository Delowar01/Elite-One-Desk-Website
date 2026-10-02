import { redirect } from "next/navigation";

import { Logo } from "@/components/ui/logo";
import { CHANGE_PASSWORD_PATH } from "@/lib/auth/guard";
import { readSession } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; changed?: string }>;
}) {
  // Already signed in? There is nothing to do on this page — unless the
  // account is on a temporary password, which has exactly one thing to do.
  const session = await readSession();
  if (session) redirect(session.mustChangePassword ? CHANGE_PASSWORD_PATH : "/admin");

  const { next, changed } = await searchParams;
  const target = next && next.startsWith("/admin") && !next.startsWith("//") ? next : "/admin";

  return (
    <div className="flex min-h-dvh items-center justify-center p-5">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo height={44} priority />
        </div>

        <div className="admin-card p-7">
          <h1 className="mb-1">Sign in</h1>
          <p className="mb-6 text-[0.82rem] text-muted">
            Elite One Desk administration.
          </p>
          {changed === "1" ? (
            // Says only what happened on this browser a moment ago; it reads no
            // account and is the same sentence for whoever opens the address.
            <p
              role="status"
              data-password-changed
              className="mb-4 rounded-[var(--radius-sm)] border p-3 text-[0.8rem]"
              style={{ borderColor: "#3ddc8466", background: "#3ddc840f", color: "#9ff0c4" }}
            >
              Password changed. Every session for the account was signed out — sign in with your new password.
            </p>
          ) : null}
          <LoginForm next={target} />
        </div>

        <p className="mt-6 text-center text-[0.75rem] text-muted">
          Access is limited to authorised staff. Sign-in attempts are recorded.
        </p>
      </div>
    </div>
  );
}
