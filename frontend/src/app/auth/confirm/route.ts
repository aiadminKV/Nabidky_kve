import { type NextRequest, NextResponse } from "next/server";
import { buildAppUrl, buildSafeAppRedirectUrl } from "@/lib/request-url";
import { createClient } from "@/lib/supabase/server";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Handles the email confirmation callback from Supabase.
 * Covers: invite, recovery (password reset), email change, signup.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/dashboard";

  if (!tokenHash || !type) {
    return NextResponse.redirect(
      buildAppUrl(request, "/login?error=invalid_link"),
    );
  }

  const supabase = await createClient();

  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type,
  });

  if (error) {
    console.error("OTP verification failed:", error.message);
    return NextResponse.redirect(
      buildAppUrl(request, `/login?error=${encodeURIComponent(error.message)}`),
    );
  }

  if (type === "invite" || type === "recovery") {
    return NextResponse.redirect(
      buildAppUrl(request, "/auth/set-password"),
    );
  }

  return NextResponse.redirect(buildSafeAppRedirectUrl(request, next));
}
