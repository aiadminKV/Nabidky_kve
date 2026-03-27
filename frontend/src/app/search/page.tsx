import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SearchClient } from "./SearchClient";

export default async function SearchPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  return (
    <SearchClient
      email={data.user.email ?? ""}
      isAdmin={data.user.app_metadata?.role === "admin"}
    />
  );
}
