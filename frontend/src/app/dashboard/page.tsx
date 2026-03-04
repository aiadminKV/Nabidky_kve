import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardClient } from "./DashboardClient";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  const isAdmin = data.user.app_metadata?.role === "admin";

  return <DashboardClient email={data.user.email ?? ""} isAdmin={isAdmin} />;
}
