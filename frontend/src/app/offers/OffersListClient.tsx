"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { createClient } from "@/lib/supabase/client";
import { listOffers, createOffer, deleteOffer, type OfferSummary } from "@/lib/api";

interface OffersListClientProps {
  email: string;
  isAdmin?: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Rozpracovaná",
  parsing: "Zpracovává se",
  searching: "Vyhledávání",
  review: "Ke kontrole",
  completed: "Dokončená",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-kv-gray-100 text-kv-gray-600",
  parsing: "bg-yellow-50 text-yellow-700",
  searching: "bg-blue-50 text-blue-700",
  review: "bg-orange-50 text-orange-700",
  completed: "bg-green-50 text-green-700",
};

export function OffersListClient({ email, isAdmin }: OffersListClientProps) {
  const router = useRouter();
  const [offers, setOffers] = useState<OfferSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const supabase = useMemo(() => createClient(), []);

  const getToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }, [supabase]);

  const loadOffers = useCallback(async () => {
    try {
      setLoading(true);
      const token = await getToken();
      const data = await listOffers(token);
      setOffers(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    loadOffers();
  }, [loadOffers]);

  const handleCreate = useCallback(async () => {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      const token = await getToken();
      const offer = await createOffer(newTitle.trim(), token);
      setShowCreateModal(false);
      setNewTitle("");
      router.push(`/offers/${offer.id}`);
    } catch {
      // silent
    } finally {
      setCreating(false);
    }
  }, [newTitle, creating, getToken, router]);

  const handleDelete = useCallback(async () => {
    if (!deleteId || deleting) return;
    setDeleting(true);
    try {
      const token = await getToken();
      await deleteOffer(deleteId, token);
      setOffers((prev) => prev.filter((o) => o.id !== deleteId));
      setDeleteId(null);
    } catch {
      // silent
    } finally {
      setDeleting(false);
    }
  }, [deleteId, deleting, getToken]);

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("cs-CZ", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="flex h-screen flex-col bg-kv-gray-50">
      <Header email={email} isAdmin={isAdmin} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-8">
          {/* Page header */}
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-kv-dark">Nabídky</h2>
              <p className="mt-1 text-sm text-kv-gray-400">
                Spravujte své rozpracované i dokončené nabídky
              </p>
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 rounded-xl bg-kv-red px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-kv-red-dark active:scale-[0.98]"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Nová nabídka
            </button>
          </div>

          {/* Offers grid */}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="flex items-center gap-3 text-kv-gray-400">
                <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm">Načítám nabídky…</span>
              </div>
            </div>
          ) : offers.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-kv-gray-200 bg-white py-20">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-kv-red/10">
                <svg className="h-7 w-7 text-kv-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-kv-dark">Zatím žádné nabídky</h3>
              <p className="mt-1.5 text-sm text-kv-gray-400 max-w-sm text-center">
                Vytvořte svou první nabídku kliknutím na tlačítko výše.
                Každá nabídka uchovává historii chatu a rozpracované položky.
              </p>
              <button
                onClick={() => setShowCreateModal(true)}
                className="mt-6 flex items-center gap-2 rounded-xl bg-kv-red px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-kv-red-dark"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Vytvořit nabídku
              </button>
            </div>
          ) : (
            <div className="grid gap-3">
              {offers.map((offer) => (
                <div
                  key={offer.id}
                  className="group flex items-center justify-between rounded-xl border border-kv-gray-200 bg-white px-5 py-4 transition-all hover:border-kv-gray-300 hover:shadow-sm cursor-pointer"
                  onClick={() => router.push(`/offers/${offer.id}`)}
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kv-gray-50 text-kv-gray-400 group-hover:bg-kv-red/10 group-hover:text-kv-red transition-colors">
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-kv-dark truncate">
                        {offer.title}
                      </h3>
                      <p className="mt-0.5 text-xs text-kv-gray-400">
                        {formatDate(offer.updated_at)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${STATUS_COLORS[offer.status] ?? STATUS_COLORS.draft}`}>
                      {STATUS_LABELS[offer.status] ?? offer.status}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteId(offer.id);
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-kv-gray-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                      title="Smazat nabídku"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-kv-dark">Nová nabídka</h3>
            <p className="mt-1 text-sm text-kv-gray-400">
              Pojmenujte nabídku pro snadnou orientaci.
            </p>

            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
              placeholder="Např. Firma ABC – poptávka kabelů"
              autoFocus
              className="mt-4 w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-4 py-3 text-sm text-kv-dark outline-none transition-colors placeholder:text-kv-gray-400 focus:border-kv-red/30 focus:bg-white focus:ring-2 focus:ring-kv-red/10"
            />

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setNewTitle("");
                }}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-100"
              >
                Zrušit
              </button>
              <button
                onClick={handleCreate}
                disabled={!newTitle.trim() || creating}
                className="flex items-center gap-2 rounded-xl bg-kv-red px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-kv-red-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Vytvářím…
                  </>
                ) : (
                  "Vytvořit"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
              <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            </div>
            <h3 className="text-base font-bold text-kv-dark">Smazat nabídku?</h3>
            <p className="mt-1 text-sm text-kv-gray-400">
              Tato akce je nevratná. Budou smazány i všechny položky a historie chatu.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setDeleteId(null)}
                className="rounded-xl px-4 py-2.5 text-sm font-medium text-kv-gray-500 transition-colors hover:bg-kv-gray-100"
              >
                Zrušit
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-xl bg-red-500 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-red-600 disabled:opacity-50"
              >
                {deleting ? "Mažu…" : "Smazat"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
