import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OfferDetailClient } from "./OfferDetailClient";

interface OfferDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function OfferDetailPage({ params }: OfferDetailPageProps) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  const isAdmin = data.user.app_metadata?.role === "admin";

  return (
    <OfferDetailClient
      offerId={id}
      email={data.user.email ?? ""}
      isAdmin={isAdmin}
    />
  );
}
