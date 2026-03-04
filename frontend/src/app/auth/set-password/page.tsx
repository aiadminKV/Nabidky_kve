"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Heslo musí mít alespoň 8 znaků.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Hesla se neshodují.");
      return;
    }

    setLoading(true);

    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({
      password,
    });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen">
      {/* Left: branding panel */}
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center bg-kv-dark relative overflow-hidden">
        <div className="absolute -top-32 -left-32 h-64 w-64 rounded-full bg-kv-red/10" />
        <div className="absolute -bottom-20 -right-20 h-80 w-80 rounded-full bg-kv-red/5" />
        <div className="absolute top-1/4 right-1/4 h-40 w-40 rounded-full bg-kv-navy/50" />

        <div className="relative z-10 px-16 text-center">
          <div className="mb-8 inline-flex h-20 w-20 items-center justify-center rounded-2xl bg-kv-red">
            <span className="text-3xl font-bold text-white">KV</span>
          </div>
          <h1 className="text-3xl font-bold text-white">K&V ELEKTRO</h1>
          <p className="mt-2 text-lg text-kv-gray-400">Správce nabídek</p>
          <p className="mt-6 max-w-sm text-sm leading-relaxed text-kv-gray-500">
            Vítejte v systému pro zpracování B2B poptávek.
            Nastavte si prosím heslo pro svůj účet.
          </p>
        </div>
      </div>

      {/* Right: set password form */}
      <div className="flex flex-1 items-center justify-center bg-white px-6">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kv-red">
              <span className="text-lg font-bold text-white">KV</span>
            </div>
            <div>
              <h1 className="text-lg font-bold text-kv-dark">K&V ELEKTRO</h1>
              <p className="text-xs text-kv-gray-400">Správce nabídek</p>
            </div>
          </div>

          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-status-match-bg">
            <svg className="h-5 w-5 text-status-match" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-kv-gray-900">Nastavení hesla</h2>
          <p className="mt-1 text-sm text-kv-gray-400">
            Zvolte si heslo pro přístup do aplikace
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-kv-gray-600">
                Nové heslo
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                placeholder="Minimálně 8 znaků"
                className="w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-4 py-3 text-sm text-kv-gray-800 outline-none transition-colors placeholder:text-kv-gray-400 focus:border-kv-red/30 focus:bg-white focus:ring-2 focus:ring-kv-red/10"
              />
            </div>

            <div>
              <label htmlFor="confirm-password" className="mb-1.5 block text-xs font-medium text-kv-gray-600">
                Potvrzení hesla
              </label>
              <input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                placeholder="Zadejte heslo znovu"
                className="w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-4 py-3 text-sm text-kv-gray-800 outline-none transition-colors placeholder:text-kv-gray-400 focus:border-kv-red/30 focus:bg-white focus:ring-2 focus:ring-kv-red/10"
              />
            </div>

            {error && (
              <div className="rounded-lg bg-kv-red-light px-4 py-2.5 text-xs text-kv-red">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-kv-red py-3 text-sm font-semibold text-white transition-all hover:bg-kv-red-dark active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Ukládám…
                </span>
              ) : (
                "Nastavit heslo a pokračovat"
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-kv-gray-400">
            Heslo můžete později změnit v nastavení účtu.
          </p>
        </div>
      </div>
    </div>
  );
}
