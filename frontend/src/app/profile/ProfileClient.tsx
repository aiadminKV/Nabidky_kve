"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { createClient } from "@/lib/supabase/client";
import { getProfile, updateProfile, type UserProfile } from "@/lib/api";

interface ProfileClientProps {
  email: string;
  isAdmin: boolean;
}

export function ProfileClient({ email, isAdmin }: ProfileClientProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  const getToken = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const token = await getToken();
        const data = await getProfile(token);
        if (cancelled) return;
        setProfile(data);
        setFirstName(data.first_name ?? "");
        setLastName(data.last_name ?? "");
        setPhone(data.phone ?? "");
      } catch {
        if (!cancelled) setError("Nepodařilo se načíst profil.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [getToken]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const token = await getToken();
      const updated = await updateProfile(
        { first_name: firstName, last_name: lastName, phone },
        token,
      );
      setProfile(updated);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch {
      setError("Nepodařilo se uložit změny.");
    } finally {
      setSaving(false);
    }
  };

  const hasChanges =
    profile &&
    (firstName !== (profile.first_name ?? "") ||
      lastName !== (profile.last_name ?? "") ||
      phone !== (profile.phone ?? ""));

  return (
    <div className="flex h-screen flex-col bg-kv-gray-50">
      <Header email={email} isAdmin={isAdmin} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-10">
          <div className="mb-8">
            <h2 className="text-xl font-bold text-kv-dark">Můj profil</h2>
            <p className="mt-1 text-sm text-kv-gray-500">
              Upravte své kontaktní údaje
            </p>
          </div>

          {loading ? (
            <div className="space-y-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-kv-gray-100" />
              ))}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Role badge */}
              <div className="flex items-center gap-3 rounded-xl border border-kv-gray-200 bg-white px-5 py-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-kv-gray-100">
                  <svg className="h-5 w-5 text-kv-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-kv-dark">{email}</p>
                  <p className="text-xs text-kv-gray-400">
                    {profile?.role === "admin" ? "Administrátor" : "Uživatel"}
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    profile?.role === "admin"
                      ? "bg-kv-red-light text-kv-red"
                      : "bg-kv-gray-100 text-kv-gray-600"
                  }`}
                >
                  {profile?.role === "admin" ? "Admin" : "Uživatel"}
                </span>
              </div>

              {/* First name */}
              <div>
                <label htmlFor="firstName" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                  Jméno
                </label>
                <input
                  id="firstName"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Zadejte jméno"
                  className="w-full rounded-xl border border-kv-gray-200 bg-white px-4 py-3 text-sm text-kv-dark placeholder:text-kv-gray-400 outline-none transition-colors focus:border-kv-red focus:ring-2 focus:ring-kv-red/10"
                />
              </div>

              {/* Last name */}
              <div>
                <label htmlFor="lastName" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                  Příjmení
                </label>
                <input
                  id="lastName"
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Zadejte příjmení"
                  className="w-full rounded-xl border border-kv-gray-200 bg-white px-4 py-3 text-sm text-kv-dark placeholder:text-kv-gray-400 outline-none transition-colors focus:border-kv-red focus:ring-2 focus:ring-kv-red/10"
                />
              </div>

              {/* Email (read-only) */}
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  disabled
                  className="w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-4 py-3 text-sm text-kv-gray-500 cursor-not-allowed"
                />
                <p className="mt-1 text-xs text-kv-gray-400">
                  Email je spojen s vaším účtem a nelze ho změnit
                </p>
              </div>

              {/* Phone */}
              <div>
                <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                  Telefon
                </label>
                <input
                  id="phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+420 xxx xxx xxx"
                  className="w-full rounded-xl border border-kv-gray-200 bg-white px-4 py-3 text-sm text-kv-dark placeholder:text-kv-gray-400 outline-none transition-colors focus:border-kv-red focus:ring-2 focus:ring-kv-red/10"
                />
              </div>

              {/* Status messages */}
              {error && (
                <div className="rounded-xl border border-status-not-found/20 bg-status-not-found-bg px-4 py-3 text-sm text-status-not-found">
                  {error}
                </div>
              )}
              {success && (
                <div className="rounded-xl border border-status-match/20 bg-status-match-bg px-4 py-3 text-sm text-status-match">
                  Profil byl úspěšně uložen.
                </div>
              )}

              {/* Submit */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="submit"
                  disabled={saving || !hasChanges}
                  className="rounded-xl bg-kv-red px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-kv-red-dark disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? "Ukládám…" : "Uložit změny"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
