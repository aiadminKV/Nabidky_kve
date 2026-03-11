"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { createClient } from "@/lib/supabase/client";
import { getProfile, updateProfile, changePassword, type UserProfile } from "@/lib/api";

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

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

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

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(false);

    if (!currentPw || !newPw || !confirmPw) {
      setPwError("Vyplňte všechna pole.");
      return;
    }
    if (newPw.length < 6) {
      setPwError("Nové heslo musí mít alespoň 6 znaků.");
      return;
    }
    if (newPw !== confirmPw) {
      setPwError("Nové heslo a potvrzení se neshodují.");
      return;
    }

    setPwSaving(true);

    try {
      const token = await getToken();
      await changePassword(currentPw, newPw, token);
      setPwSuccess(true);
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setTimeout(() => setPwSuccess(false), 4000);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Nepodařilo se změnit heslo.");
    } finally {
      setPwSaving(false);
    }
  };

  const hasChanges =
    profile &&
    (firstName !== (profile.first_name ?? "") ||
      lastName !== (profile.last_name ?? "") ||
      phone !== (profile.phone ?? ""));

  const inputClass =
    "w-full rounded-xl border border-kv-gray-200 bg-white px-4 py-3 text-sm text-kv-dark placeholder:text-kv-gray-400 outline-none transition-colors focus:border-kv-navy focus:ring-2 focus:ring-kv-navy/10";

  return (
    <div className="flex h-screen flex-col">
      <Header email={email} isAdmin={isAdmin} />

      <div className="flex-1 overflow-y-auto bg-kv-gray-50">
        <div className="mx-auto max-w-2xl px-6 py-10">
          <div className="mb-8">
            <h2 className="text-xl font-bold text-kv-navy">Můj profil</h2>
            <p className="mt-1 text-sm text-kv-gray-500">
              Upravte své kontaktní údaje a heslo
            </p>
          </div>

          {loading ? (
            <div className="space-y-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-kv-gray-100" />
              ))}
            </div>
          ) : (
            <div className="space-y-8">
              {/* ── Profile info ── */}
              <form onSubmit={handleSubmit} className="rounded-xl border border-kv-gray-200 bg-white overflow-hidden">
                <div className="border-b border-kv-gray-100 px-6 py-4">
                  <h3 className="text-sm font-bold text-kv-navy">Kontaktní údaje</h3>
                </div>

                <div className="p-6 space-y-5">
                  {/* Role badge */}
                  <div className="flex items-center gap-3 rounded-xl border border-kv-gray-100 bg-kv-gray-50 px-4 py-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-kv-gray-200">
                      <svg className="h-4 w-4 text-kv-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-kv-dark truncate">{email}</p>
                      <p className="text-xs text-kv-gray-400">
                        {profile?.role === "admin" ? "Administrátor" : "Uživatel"}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="firstName" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                        Jméno
                      </label>
                      <input
                        id="firstName" type="text" value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        placeholder="Zadejte jméno" className={inputClass}
                      />
                    </div>
                    <div>
                      <label htmlFor="lastName" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                        Příjmení
                      </label>
                      <input
                        id="lastName" type="text" value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        placeholder="Zadejte příjmení" className={inputClass}
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                      Telefon
                    </label>
                    <input
                      id="phone" type="tel" value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+420 xxx xxx xxx" className={inputClass}
                    />
                  </div>

                  {error && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                      {error}
                    </div>
                  )}
                  {success && (
                    <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-600">
                      Profil byl úspěšně uložen.
                    </div>
                  )}
                </div>

                <div className="border-t border-kv-gray-100 px-6 py-4 flex justify-end">
                  <button
                    type="submit"
                    disabled={saving || !hasChanges}
                    className="rounded-lg bg-kv-red px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-kv-red-dark disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? "Ukládám…" : "Uložit změny"}
                  </button>
                </div>
              </form>

              {/* ── Change password ── */}
              <form onSubmit={handleChangePassword} className="rounded-xl border border-kv-gray-200 bg-white overflow-hidden">
                <div className="border-b border-kv-gray-100 px-6 py-4">
                  <h3 className="text-sm font-bold text-kv-navy">Změna hesla</h3>
                </div>

                <div className="p-6 space-y-5">
                  <div>
                    <label htmlFor="currentPw" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                      Stávající heslo
                    </label>
                    <input
                      id="currentPw" type="password" value={currentPw}
                      onChange={(e) => setCurrentPw(e.target.value)}
                      placeholder="Zadejte aktuální heslo"
                      autoComplete="current-password"
                      className={inputClass}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="newPw" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                        Nové heslo
                      </label>
                      <input
                        id="newPw" type="password" value={newPw}
                        onChange={(e) => setNewPw(e.target.value)}
                        placeholder="Min. 6 znaků"
                        autoComplete="new-password"
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label htmlFor="confirmPw" className="mb-1.5 block text-sm font-medium text-kv-gray-700">
                        Potvrzení hesla
                      </label>
                      <input
                        id="confirmPw" type="password" value={confirmPw}
                        onChange={(e) => setConfirmPw(e.target.value)}
                        placeholder="Zadejte znovu"
                        autoComplete="new-password"
                        className={inputClass}
                      />
                    </div>
                  </div>

                  {pwError && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                      {pwError}
                    </div>
                  )}
                  {pwSuccess && (
                    <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-600">
                      Heslo bylo úspěšně změněno.
                    </div>
                  )}
                </div>

                <div className="border-t border-kv-gray-100 px-6 py-4 flex justify-end">
                  <button
                    type="submit"
                    disabled={pwSaving || !currentPw || !newPw || !confirmPw}
                    className="rounded-lg bg-kv-navy px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-kv-dark disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pwSaving ? "Měním heslo…" : "Změnit heslo"}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
