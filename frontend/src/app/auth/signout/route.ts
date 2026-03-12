import { NextResponse, type NextRequest } from "next/server";
import { buildAppUrl } from "@/lib/request-url";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const redirectUrl = buildAppUrl(request, "/login");
  return NextResponse.redirect(redirectUrl, { status: 302 });
}
