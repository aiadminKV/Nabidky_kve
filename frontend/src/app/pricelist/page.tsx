import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PricelistClient } from "./PricelistClient";

export default async function PricelistPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  const isAdmin = data.user.app_metadata?.role === "admin";
  if (!isAdmin) {
    redirect("/dashboard");
  }

  return <PricelistClient email={data.user.email ?? ""} isAdmin={isAdmin} />;
}
