"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email,
      {
        redirectTo: `${window.location.origin}/auth/confirm?type=recovery`,
      },
    );

    setLoading(false);

    if (resetError) {
      setError(resetError.message);
      return;
    }

    setSent(true);
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
            Zašleme vám e-mail s odkazem pro obnovení hesla.
          </p>
        </div>
      </div>

      {/* Right: form */}
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

          {sent ? (
            /* Success state */
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-status-match-bg">
                <svg
                  className="h-7 w-7 text-status-match"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-kv-gray-900">
                E-mail odeslán
              </h2>
              <p className="mt-2 text-sm text-kv-gray-400">
                Pokud účet s adresou{" "}
                <span className="font-medium text-kv-gray-700">{email}</span>{" "}
                existuje, obdržíte odkaz pro obnovení hesla.
              </p>
              <p className="mt-1 text-xs text-kv-gray-400">
                Zkontrolujte i složku spam.
              </p>
              <Link
                href="/login"
                className="mt-6 inline-block text-sm font-medium text-kv-red hover:text-kv-red-dark"
              >
                ← Zpět na přihlášení
              </Link>
            </div>
          ) : (
            /* Request form */
            <>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-kv-gray-100">
                <svg
                  className="h-5 w-5 text-kv-gray-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-kv-gray-900">
                Zapomenuté heslo
              </h2>
              <p className="mt-1 text-sm text-kv-gray-400">
                Zadejte váš e-mail a zašleme vám odkaz pro obnovení hesla
              </p>

              <form onSubmit={handleSubmit} className="mt-8 space-y-5">
                <div>
                  <label
                    htmlFor="email"
                    className="mb-1.5 block text-xs font-medium text-kv-gray-600"
                  >
                    E-mail
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="vas@email.cz"
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
                      <svg
                        className="h-4 w-4 animate-spin"
                        viewBox="0 0 24 24"
                        fill="none"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      Odesílám…
                    </span>
                  ) : (
                    "Odeslat odkaz"
                  )}
                </button>
              </form>

              <Link
                href="/login"
                className="mt-6 block text-center text-sm text-kv-gray-400 hover:text-kv-gray-700 transition-colors"
              >
                ← Zpět na přihlášení
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
