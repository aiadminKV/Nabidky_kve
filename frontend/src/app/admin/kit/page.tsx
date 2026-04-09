import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { KitAdminClient } from "./KitAdminClient";

export default async function KitAdminPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) redirect("/login");
  if (data.user.app_metadata?.role !== "admin") redirect("/offers");

  return <KitAdminClient email={data.user.email ?? ""} />;
}
