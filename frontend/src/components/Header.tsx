"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

interface HeaderProps {
  email: string;
  isAdmin?: boolean;
  offerTitle?: string;
}

export function Header({ email, isAdmin, offerTitle }: HeaderProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const navItems = [
    { href: "/offers", label: "Nabídky" },
    ...(isAdmin ? [{ href: "/pricelist", label: "Ceník" }] : []),
  ];

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setMenuOpen(false);
    }
  }, []);

  useEffect(() => {
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen, handleClickOutside]);

  const initials = email.charAt(0).toUpperCase();

  return (
    <header className="bg-kv-navy text-white shadow-lg shrink-0">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-5 min-w-0">
          {/* Logo + Brand */}
          <Link href="/offers" className="flex items-center gap-3 shrink-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white overflow-hidden shadow-inner">
              <img src="/kv-logo.jpeg" alt="K&V Elektro" className="h-full w-full object-contain" />
            </div>
            <div className="hidden h-10 flex-col justify-center gap-0.5 sm:flex">
              <h1 className="text-sm font-black tracking-tight leading-none">
                DATA BRIDGE <span className="text-kv-red">PRO</span>
              </h1>
              <span className="text-[9px] font-medium tracking-[0.15em] text-blue-200/60 leading-none">
                Offer Master
              </span>
            </div>
          </Link>

          <div className="h-6 w-px bg-white/20 shrink-0" />

          {/* Navigation */}
          <nav className="flex items-center gap-1 shrink-0">
            {navItems.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`
                    rounded-lg px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-colors
                    ${isActive
                      ? "bg-white/15 text-white"
                      : "text-blue-200/60 hover:bg-white/10 hover:text-white"
                    }
                  `}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Offer title (when viewing a specific offer) */}
          {offerTitle && (
            <>
              <div className="h-6 w-px bg-white/20 shrink-0" />
              <span className="text-sm text-white/80 font-medium truncate min-w-0">
                {offerTitle}
              </span>
            </>
          )}
        </div>

        {/* User menu */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/10"
          >
            <span className="text-xs text-blue-200/60 hidden md:inline">{email}</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-xs font-bold text-white border border-white/20">
              {initials}
            </div>
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-kv-gray-200 bg-white shadow-xl">
              <div className="border-b border-kv-gray-100 px-4 py-3">
                <p className="text-sm font-medium text-kv-dark truncate">{email}</p>
                <span
                  className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                    isAdmin
                      ? "bg-kv-red-light text-kv-red"
                      : "bg-kv-gray-100 text-kv-gray-500"
                  }`}
                >
                  {isAdmin ? "Admin" : "Uživatel"}
                </span>
              </div>

              <div className="py-1">
                <Link
                  href="/profile"
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-kv-gray-700 transition-colors hover:bg-kv-gray-50"
                >
                  <svg className="h-4 w-4 text-kv-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                  </svg>
                  Můj profil
                </Link>
              </div>

              <div className="border-t border-kv-gray-100 py-1">
                <form action="/auth/signout" method="post">
                  <button
                    type="submit"
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-kv-gray-700 transition-colors hover:bg-kv-gray-50"
                  >
                    <svg className="h-4 w-4 text-kv-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
                    </svg>
                    Odhlásit se
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
