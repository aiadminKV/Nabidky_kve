import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OffersListClient } from "./OffersListClient";

export default async function OffersPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  const isAdmin = data.user.app_metadata?.role === "admin";

  return (
    <OffersListClient
      email={data.user.email ?? ""}
      isAdmin={isAdmin}
    />
  );
}
