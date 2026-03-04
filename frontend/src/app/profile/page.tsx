import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProfileClient } from "./ProfileClient";

export default async function ProfilePage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  const isAdmin = data.user.app_metadata?.role === "admin";

  return (
    <ProfileClient
      email={data.user.email ?? ""}
      isAdmin={isAdmin}
    />
  );
}
