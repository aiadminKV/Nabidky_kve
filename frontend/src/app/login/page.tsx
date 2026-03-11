import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen">
      {/* Left: branding panel */}
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center header-pattern relative overflow-hidden">
        <div className="absolute -top-32 -left-32 h-64 w-64 rounded-full bg-kv-red/10" />
        <div className="absolute -bottom-20 -right-20 h-80 w-80 rounded-full bg-kv-red/5" />
        <div className="absolute top-1/4 right-1/4 h-40 w-40 rounded-full bg-white/5" />

        <div className="relative z-10 px-16 text-center">
          <div className="mb-8 inline-flex h-20 w-20 items-center justify-center rounded-2xl bg-white shadow-inner">
            <span className="text-3xl font-black text-kv-red">KV</span>
          </div>
          <h1 className="text-2xl font-black text-white uppercase tracking-tight">
            Data Bridge <span className="text-kv-red">PRO</span>
          </h1>
          <p className="mt-2 text-xs font-medium uppercase tracking-[0.2em] text-blue-200/70">K&V Elektro – Správce nabídek</p>
          <p className="mt-6 max-w-sm text-sm leading-relaxed text-blue-100/50">
            Automatické zpracování B2B poptávek pomocí AI.
            Vložte poptávku, systém identifikuje produkty a vygeneruje podklad pro SAP.
          </p>
        </div>
      </div>

      {/* Right: login form */}
      <div className="flex flex-1 items-center justify-center bg-white px-6">
        <Suspense fallback={<div className="w-full max-w-sm h-80 animate-pulse bg-kv-gray-100 rounded-2xl" />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
