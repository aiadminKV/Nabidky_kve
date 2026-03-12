"use client";

import { useState, useEffect, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const urlError = searchParams.get("error");
    if (urlError) setError(urlError);
  }, [searchParams]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="w-full max-w-sm">
      {/* Mobile logo */}
      <div className="mb-8 flex items-center gap-3 lg:hidden">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white overflow-hidden shadow-inner border border-kv-gray-200">
          <img src="/kv-logo.jpeg" alt="K&V Elektro" className="h-full w-full object-contain" />
        </div>
        <div className="flex h-10 flex-col justify-center gap-0.5">
          <h1 className="text-sm font-black tracking-tight leading-none text-kv-dark">
            DATA BRIDGE <span className="text-kv-red">PRO</span>
          </h1>
          <p className="text-[9px] font-medium tracking-[0.15em] text-kv-gray-400 leading-none">
            Offer Master
          </p>
        </div>
      </div>

      <h2 className="text-xl font-semibold text-kv-gray-900">Přihlášení</h2>
      <p className="mt-1 text-sm text-kv-gray-400">
        Zadejte své přihlašovací údaje
      </p>

      <form onSubmit={handleSubmit} className="mt-8 space-y-5">
        <div>
          <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-kv-gray-600">
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

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="password" className="block text-xs font-medium text-kv-gray-600">
              Heslo
            </label>
            <Link
              href="/auth/forgot-password"
              className="text-xs text-kv-red hover:text-kv-red-dark transition-colors"
            >
              Zapomenuté heslo?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="••••••••"
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
              Přihlašuji…
            </span>
          ) : (
            "Přihlásit se"
          )}
        </button>
      </form>
    </div>
  );
}
