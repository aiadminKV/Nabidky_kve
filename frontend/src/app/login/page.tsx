import { Suspense } from "react";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen">
      {/* Left: branding panel */}
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center overflow-hidden bg-kv-navy">
        <div className="px-16">
          <div className="flex items-center gap-4">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-white overflow-hidden shadow-inner">
              <img src="/kv-logo.jpeg" alt="K&V Elektro" className="h-full w-full object-contain" />
            </div>
            <div className="flex h-20 flex-col justify-center gap-1">
              <h1 className="text-3xl font-black tracking-tight leading-none text-white">
                DATA BRIDGE <span className="text-kv-red">PRO</span>
              </h1>
              <span className="text-xs font-medium tracking-[0.18em] text-blue-200/70 leading-none">
                Offer Master
              </span>
            </div>
          </div>
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
