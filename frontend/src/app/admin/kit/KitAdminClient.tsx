"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Header } from "@/components/Header";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComponentRole = "mechanism" | "cover" | "frame" | "other";

const ROLE_LABELS: Record<ComponentRole, string> = {
  mechanism: "Strojek",
  cover: "Klapka / kryt",
  frame: "Rámeček",
  other: "Ostatní (nosič, keystone…)",
};
const ROLE_COLORS: Record<ComponentRole, string> = {
  mechanism: "bg-violet-100 text-violet-700 border-violet-200",
  cover: "bg-sky-100 text-sky-700 border-sky-200",
  frame: "bg-amber-100 text-amber-700 border-amber-200",
  other: "bg-rose-100 text-rose-700 border-rose-200",
};

interface KitSeries {
  id: string;
  brand: string;
  series: string;
  color_name: string;
  notes: string | null;
  updated_at: string;
}

interface KitSharedComponent {
  id: string;
  series_id: string;
  role: ComponentRole;
  name: string;
  manufacturer_code: string | null;
  ean: string | null;
  quantity: number;
  sort_order: number;
  notes: string | null;
}

interface KitFunctionType {
  id: string;
  series_id: string;
  name: string;
  sort_order: number;
  notes: string | null;
  examples?: KitFunctionExample[];
  components?: KitFunctionComponent[];
}

interface KitFunctionExample {
  id: string;
  function_type_id: string;
  example_query: string;
  sort_order: number;
}

interface KitFunctionComponent {
  id: string;
  function_type_id: string;
  role: ComponentRole;
  name: string;
  manufacturer_code: string | null;
  ean: string | null;
  quantity: number;
  sort_order: number;
  notes: string | null;
}

// ── KB cache invalidation ─────────────────────────────────────────────────────

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001";

async function invalidateBackendKBCache(supabase: ReturnType<typeof createClient>) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    await fetch(`${BACKEND_URL}/admin/kit/cache/invalidate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    // non-critical — cache expires automatically
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function SectionInfo({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-kv-blue-100 bg-kv-blue-50 px-4 py-3">
      <svg className="mt-0.5 h-4 w-4 shrink-0 text-kv-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
      </svg>
      <p className="text-xs text-kv-blue-700">{children}</p>
    </div>
  );
}

// ── ComponentRow ──────────────────────────────────────────────────────────────

function ComponentRow({
  comp, onUpdate, onDelete,
}: {
  comp: KitSharedComponent | KitFunctionComponent;
  onUpdate: (patch: Partial<KitSharedComponent | KitFunctionComponent>) => void;
  onDelete: () => void;
}) {
  return (
    <div className="group grid grid-cols-[140px_1fr_120px_80px_48px_32px] items-center gap-2 rounded-xl border border-kv-gray-100 bg-white px-3 py-2.5 hover:border-kv-gray-200 hover:shadow-sm">
      {/* Role */}
      <select
        value={comp.role}
        onChange={(e) => onUpdate({ role: e.target.value as ComponentRole })}
        className={`rounded-lg border px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-kv-blue-300 ${ROLE_COLORS[comp.role]}`}
      >
        {(Object.keys(ROLE_LABELS) as ComponentRole[]).map((r) => (
          <option key={r} value={r}>{ROLE_LABELS[r]}</option>
        ))}
      </select>
      {/* Name */}
      <input
        value={comp.name}
        onChange={(e) => onUpdate({ name: e.target.value })}
        placeholder="Název komponenty (např. Strojek vypínač č.1)"
        className="rounded-lg border border-transparent px-2 py-1 text-sm text-kv-gray-800 transition-colors hover:border-kv-gray-200 focus:border-kv-blue-300 focus:outline-none"
      />
      {/* Manufacturer code */}
      <input
        value={comp.manufacturer_code ?? ""}
        onChange={(e) => onUpdate({ manufacturer_code: e.target.value || null })}
        placeholder="Kód výrobce"
        className="rounded-lg border border-transparent px-2 py-1 font-mono text-xs text-kv-gray-600 transition-colors hover:border-kv-gray-200 focus:border-kv-blue-300 focus:outline-none"
      />
      {/* Quantity */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-kv-gray-400">ks</span>
        <input
          type="number"
          min={1}
          value={comp.quantity}
          onChange={(e) => onUpdate({ quantity: Number(e.target.value) })}
          className="w-10 rounded-lg border border-kv-gray-200 px-1 py-1 text-center text-xs focus:border-kv-blue-300 focus:outline-none"
        />
      </div>
      {/* EAN */}
      <input
        value={comp.ean ?? ""}
        onChange={(e) => onUpdate({ ean: e.target.value || null })}
        placeholder="EAN"
        className="col-span-1 rounded-lg border border-transparent px-2 py-1 font-mono text-[10px] text-kv-gray-400 transition-colors hover:border-kv-gray-200 focus:border-kv-blue-300 focus:outline-none"
      />
      {/* Delete */}
      <button
        onClick={onDelete}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-kv-gray-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-400 group-hover:opacity-100"
        title="Odstranit"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// Column header for ComponentRow table
function ComponentTableHeader() {
  return (
    <div className="grid grid-cols-[140px_1fr_120px_80px_48px_32px] items-center gap-2 px-3 pb-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-kv-gray-400">Typ</span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-kv-gray-400">Název komponenty</span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-kv-gray-400">Kód výrobce</span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-kv-gray-400">Počet</span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-kv-gray-400">EAN</span>
      <span />
    </div>
  );
}

// ── FunctionTypeCard ──────────────────────────────────────────────────────────

function FunctionTypeCard({
  ft, index,
  onUpdate, onDelete,
  onAddComponent, onUpdateComponent, onDeleteComponent,
  onAddExample, onUpdateExample, onDeleteExample,
}: {
  ft: KitFunctionType;
  index: number;
  onUpdate: (patch: Partial<KitFunctionType>) => void;
  onDelete: () => void;
  onAddComponent: () => void;
  onUpdateComponent: (compId: string, patch: Partial<KitFunctionComponent>) => void;
  onDeleteComponent: (compId: string) => void;
  onAddExample: () => void;
  onUpdateExample: (exId: string, q: string) => void;
  onDeleteExample: (exId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const compCount = ft.components?.length ?? 0;
  const exCount = ft.examples?.length ?? 0;
  const hasWarning = compCount === 0 || exCount === 0;

  return (
    <div className={`overflow-hidden rounded-xl border transition-all ${open ? "border-kv-navy/20 shadow-md" : "border-kv-gray-200"}`}>
      {/* Header row */}
      <div className={`flex items-center gap-3 px-4 py-3 ${open ? "bg-kv-navy text-white" : "bg-white hover:bg-kv-gray-50"}`}>
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${open ? "bg-white/20 text-white" : "bg-kv-gray-100 text-kv-gray-500"}`}>
          {index + 1}
        </span>
        <input
          value={ft.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          placeholder="Název funkce (např. Vypínač č.1 jednopólový)"
          className={`flex-1 bg-transparent text-sm font-semibold focus:outline-none ${open ? "text-white placeholder:text-white/40" : "text-kv-gray-800 placeholder:text-kv-gray-400"}`}
        />
        {hasWarning && !open && (
          <span title="Chybí komponenty nebo příklady poptávek" className="flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-600">
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            Neúplné
          </span>
        )}
        {!hasWarning && !open && (
          <span className={`text-xs ${open ? "text-white/60" : "text-kv-gray-400"}`}>
            {compCount} komp. · {exCount} příkladů
          </span>
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
            open ? "bg-white/20 text-white hover:bg-white/30" : "bg-kv-gray-100 text-kv-gray-600 hover:bg-kv-gray-200"
          }`}
        >
          {open ? "Sbalit" : "Upravit"}
          <svg className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
          </svg>
        </button>
        <button
          onClick={onDelete}
          className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${open ? "text-white/50 hover:bg-white/20 hover:text-white" : "text-kv-gray-300 hover:bg-red-50 hover:text-red-400"}`}
          title="Smazat typ funkce"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="space-y-5 border-t border-kv-gray-100 bg-white px-4 pb-4 pt-4">

          {/* Examples */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-kv-gray-700">
                  Příklady zákaznických poptávek
                  <span className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${exCount === 0 ? "bg-red-100 text-red-600" : "bg-green-100 text-green-700"}`}>
                    {exCount}
                  </span>
                </p>
                <p className="text-[11px] text-kv-gray-400">Jak zákazník OPRAVDU píše — bez výrobce a řady (to volí uživatel app)</p>
              </div>
              <button
                onClick={onAddExample}
                className="flex items-center gap-1.5 rounded-lg border border-kv-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-kv-gray-700 shadow-sm hover:bg-kv-gray-50"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Přidat příklad
              </button>
            </div>
            {exCount === 0 && (
              <div className="rounded-lg border border-dashed border-red-200 bg-red-50 px-3 py-2 text-xs text-red-500">
                Žádné příklady! Přidej alespoň 2–3 varianty jak zákazník píše poptávku. Agent bez nich nerozpozná tento typ funkce.
              </div>
            )}
            <div className="mt-1.5 space-y-1">
              {ft.examples?.map((ex, i) => (
                <div key={ex.id} className="group flex items-center gap-2">
                  <span className="w-4 shrink-0 text-center text-xs text-kv-gray-300">{i + 1}.</span>
                  <input
                    value={ex.example_query}
                    onChange={(e) => onUpdateExample(ex.id, e.target.value)}
                    placeholder="Příklad: vypínač č.1, jednoduchý vypínač, spínač…"
                    className="flex-1 rounded-lg border border-kv-gray-100 bg-kv-gray-50 px-2.5 py-1.5 text-xs italic text-kv-gray-700 transition-colors focus:border-kv-blue-300 focus:bg-white focus:outline-none"
                  />
                  <button
                    onClick={() => onDeleteExample(ex.id)}
                    className="rounded-lg p-1 text-kv-gray-300 opacity-0 hover:text-red-400 group-hover:opacity-100"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Components */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-kv-gray-700">
                  Specifické komponenty pro tento typ
                  <span className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${compCount === 0 ? "bg-red-100 text-red-600" : "bg-green-100 text-green-700"}`}>
                    {compCount}
                  </span>
                </p>
                <p className="text-[11px] text-kv-gray-400">Komponenty měnící se pro každý typ (strojek, klapka) — rámeček je ve sdílených</p>
              </div>
              <button
                onClick={onAddComponent}
                className="flex items-center gap-1.5 rounded-lg border border-kv-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-kv-gray-700 shadow-sm hover:bg-kv-gray-50"
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Přidat komponentu
              </button>
            </div>
            {compCount === 0 && (
              <div className="rounded-lg border border-dashed border-red-200 bg-red-50 px-3 py-2 text-xs text-red-500">
                Žádné komponenty! Přidej alespoň strojek a klapku pro tento typ funkce.
              </div>
            )}
            {compCount > 0 && (
              <div className="space-y-1.5">
                <ComponentTableHeader />
                {ft.components?.map((comp) => (
                  <ComponentRow
                    key={comp.id}
                    comp={comp}
                    onUpdate={(p) => onUpdateComponent(comp.id, p as Partial<KitFunctionComponent>)}
                    onDelete={() => onDeleteComponent(comp.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <p className="mb-1 text-xs font-semibold text-kv-gray-700">Poznámky pro agenta <span className="font-normal text-kv-gray-400">(volitelné)</span></p>
            <textarea
              value={ft.notes ?? ""}
              onChange={(e) => onUpdate({ notes: e.target.value || null })}
              placeholder="Speciální instrukce, výjimky, varianty… (agent toto dostane jako kontext)"
              rows={2}
              className="w-full rounded-xl border border-kv-gray-200 bg-kv-gray-50 px-3 py-2 text-xs text-kv-gray-600 focus:border-kv-blue-300 focus:bg-white focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── SeriesEditor ──────────────────────────────────────────────────────────────

function SeriesEditor({ series, onClose }: { series: KitSeries; onClose: () => void }) {
  const supabase = createClient();

  const [notes, setNotes] = useState(series.notes ?? "");
  const [sharedComps, setSharedComps] = useState<KitSharedComponent[]>([]);
  const [functionTypes, setFunctionTypes] = useState<KitFunctionType[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const [scRes, ftRes, exRes, fcRes] = await Promise.all([
        supabase.from("kit_shared_components").select("*").eq("series_id", series.id).order("sort_order"),
        supabase.from("kit_function_types").select("*").eq("series_id", series.id).order("sort_order"),
        supabase.from("kit_function_examples").select("*").order("sort_order"),
        supabase.from("kit_function_components").select("*").order("sort_order"),
      ]);
      setSharedComps((scRes.data as KitSharedComponent[]) ?? []);
      const fts = ((ftRes.data as KitFunctionType[]) ?? []).map((ft) => ({
        ...ft,
        examples: (exRes.data as KitFunctionExample[])?.filter((e) => e.function_type_id === ft.id) ?? [],
        components: (fcRes.data as KitFunctionComponent[])?.filter((c) => c.function_type_id === ft.id) ?? [],
      }));
      setFunctionTypes(fts);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.id]);

  const newId = () => crypto.randomUUID();

  const addSharedComp = () =>
    setSharedComps((prev) => [...prev, {
      id: newId(), series_id: series.id, role: "frame", name: "",
      manufacturer_code: null, ean: null, quantity: 1, sort_order: prev.length, notes: null,
    }]);

  const updateSharedComp = (id: string, patch: Partial<KitSharedComponent>) =>
    setSharedComps((prev) => prev.map((c) => c.id === id ? { ...c, ...patch } : c));

  const deleteSharedComp = (id: string) =>
    setSharedComps((prev) => prev.filter((c) => c.id !== id));

  const addFunctionType = () =>
    setFunctionTypes((prev) => [...prev, {
      id: newId(), series_id: series.id, name: "", sort_order: prev.length, notes: null,
      examples: [], components: [],
    }]);

  const updateFunctionType = (ftId: string, patch: Partial<KitFunctionType>) =>
    setFunctionTypes((prev) => prev.map((ft) => ft.id === ftId ? { ...ft, ...patch } : ft));

  const deleteFunctionType = (ftId: string) =>
    setFunctionTypes((prev) => prev.filter((ft) => ft.id !== ftId));

  const addExample = (ftId: string) =>
    setFunctionTypes((prev) => prev.map((ft) => ft.id !== ftId ? ft : {
      ...ft,
      examples: [...(ft.examples ?? []), {
        id: newId(), function_type_id: ftId, example_query: "", sort_order: ft.examples?.length ?? 0,
      }],
    }));

  const updateExample = (ftId: string, exId: string, q: string) =>
    setFunctionTypes((prev) => prev.map((ft) => ft.id !== ftId ? ft : {
      ...ft, examples: ft.examples?.map((e) => e.id === exId ? { ...e, example_query: q } : e),
    }));

  const deleteExample = (ftId: string, exId: string) =>
    setFunctionTypes((prev) => prev.map((ft) => ft.id !== ftId ? ft : {
      ...ft, examples: ft.examples?.filter((e) => e.id !== exId),
    }));

  const addFunctionComp = (ftId: string) =>
    setFunctionTypes((prev) => prev.map((ft) => ft.id !== ftId ? ft : {
      ...ft,
      components: [...(ft.components ?? []), {
        id: newId(), function_type_id: ftId, role: "mechanism" as ComponentRole, name: "",
        manufacturer_code: null, ean: null, quantity: 1, sort_order: ft.components?.length ?? 0, notes: null,
      }],
    }));

  const updateFunctionComp = (ftId: string, compId: string, patch: Partial<KitFunctionComponent>) =>
    setFunctionTypes((prev) => prev.map((ft) => ft.id !== ftId ? ft : {
      ...ft, components: ft.components?.map((c) => c.id === compId ? { ...c, ...patch } : c),
    }));

  const deleteFunctionComp = (ftId: string, compId: string) =>
    setFunctionTypes((prev) => prev.map((ft) => ft.id !== ftId ? ft : {
      ...ft, components: ft.components?.filter((c) => c.id !== compId),
    }));

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await supabase.from("kit_series").update({ notes: notes || null }).eq("id", series.id);

      const scIds = sharedComps.map((c) => c.id);
      const { data: existingSC } = await supabase.from("kit_shared_components").select("id").eq("series_id", series.id);
      const toDeleteSC = (existingSC ?? []).filter((e) => !scIds.includes(e.id)).map((e) => e.id);
      if (toDeleteSC.length > 0) await supabase.from("kit_shared_components").delete().in("id", toDeleteSC);
      if (sharedComps.length > 0) await supabase.from("kit_shared_components").upsert(sharedComps.map((c, i) => ({ ...c, sort_order: i })));

      const ftIds = functionTypes.map((ft) => ft.id);
      const { data: existingFT } = await supabase.from("kit_function_types").select("id").eq("series_id", series.id);
      const toDeleteFT = (existingFT ?? []).filter((e) => !ftIds.includes(e.id)).map((e) => e.id);
      if (toDeleteFT.length > 0) await supabase.from("kit_function_types").delete().in("id", toDeleteFT);
      if (functionTypes.length > 0) await supabase.from("kit_function_types").upsert(functionTypes.map(({ examples: _e, components: _c, ...ft }, i) => ({ ...ft, sort_order: i })));

      const allExamples = functionTypes.flatMap((ft) => ft.examples ?? []);
      const exIds = allExamples.map((e) => e.id);
      const { data: existingEx } = await supabase.from("kit_function_examples").select("id").in("function_type_id", functionTypes.map((ft) => ft.id));
      const toDeleteEx = (existingEx ?? []).filter((e) => !exIds.includes(e.id)).map((e) => e.id);
      if (toDeleteEx.length > 0) await supabase.from("kit_function_examples").delete().in("id", toDeleteEx);
      if (allExamples.length > 0) await supabase.from("kit_function_examples").upsert(allExamples.filter((e) => e.example_query.trim()).map((e, i) => ({ ...e, sort_order: i })));

      const allFComps = functionTypes.flatMap((ft) => (ft.components ?? []).map((c) => ({ ...c, function_type_id: ft.id })));
      const fcIds = allFComps.map((c) => c.id);
      const { data: existingFC } = await supabase.from("kit_function_components").select("id").in("function_type_id", functionTypes.map((ft) => ft.id));
      const toDeleteFC = (existingFC ?? []).filter((e) => !fcIds.includes(e.id)).map((e) => e.id);
      if (toDeleteFC.length > 0) await supabase.from("kit_function_components").delete().in("id", toDeleteFC);
      if (allFComps.length > 0) await supabase.from("kit_function_components").upsert(allFComps.map((c, i) => ({ ...c, sort_order: i })));

      await invalidateBackendKBCache(supabase);
      setSaveMsg("Uloženo ✓");
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setSaveMsg(`Chyba: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const incompleteFTs = functionTypes.filter((ft) => (ft.components?.length ?? 0) === 0 || (ft.examples?.length ?? 0) === 0).length;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-kv-gray-200 bg-white px-6 py-3">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-kv-gray-600 hover:bg-kv-gray-100"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
          Zpět na seznam
        </button>
        <div className="h-5 w-px bg-kv-gray-200" />
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-kv-gray-800">{series.brand} {series.series}</span>
          <span className="rounded-full bg-kv-gray-100 px-2.5 py-0.5 text-xs font-medium text-kv-gray-600">{series.color_name}</span>
        </div>
        <div className="flex-1" />
        {incompleteFTs > 0 && (
          <span className="flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-600">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            {incompleteFTs} neúplné typy
          </span>
        )}
        {saveMsg && (
          <span className={`text-sm font-medium ${saveMsg.startsWith("Chyba") ? "text-red-500" : "text-green-600"}`}>{saveMsg}</span>
        )}
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 rounded-xl bg-kv-navy px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-kv-navy/90 disabled:opacity-60"
        >
          {saving ? (
            <>
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Ukládám…
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
              Uložit změny
            </>
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">

        {/* SECTION 1 — Notes */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-kv-navy text-xs font-bold text-white">1</span>
            <h3 className="text-sm font-semibold text-kv-gray-800">Obecné poznámky pro agenta</h3>
            <span className="rounded-full bg-kv-gray-100 px-2 py-0.5 text-[10px] font-medium text-kv-gray-500">volitelné</span>
          </div>
          <SectionInfo>
            Sem napiš cokoliv specifického pro celou řadu/barvu — zvláštnosti sestavení, výjimky, rozdíly od standardu. Agent to dostane jako kontext při zpracování poptávky.
          </SectionInfo>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Př.: Tango bílá — rámeček je plastový, vždy kombinovat s matičkou. Pozor: 3-násobné rámečky se neprodávají samostatně."
            rows={3}
            className="mt-3 w-full rounded-xl border border-kv-gray-200 bg-white px-4 py-3 text-sm text-kv-gray-700 shadow-sm focus:border-kv-blue-300 focus:outline-none"
          />
        </section>

        {/* SECTION 2 — Shared components */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-kv-navy text-xs font-bold text-white">2</span>
              <h3 className="text-sm font-semibold text-kv-gray-800">Sdílené komponenty</h3>
              <span className="rounded-full bg-kv-gray-100 px-2 py-0.5 text-[10px] font-medium text-kv-gray-500">{sharedComps.length} položek</span>
            </div>
            <button
              onClick={addSharedComp}
              className="flex items-center gap-1.5 rounded-xl border border-kv-gray-200 bg-white px-3 py-2 text-xs font-semibold text-kv-gray-700 shadow-sm hover:bg-kv-gray-50"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Přidat komponentu
            </button>
          </div>
          <SectionInfo>
            Komponenty společné pro VŠECHNY typy funkcí v této řadě — typicky rámeček a nosič. Strojek a klapka patří do konkrétního typu funkce níže.
          </SectionInfo>
          {sharedComps.length === 0 ? (
            <button
              onClick={addSharedComp}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-kv-gray-200 py-5 text-sm text-kv-gray-400 transition-colors hover:border-kv-gray-300 hover:text-kv-gray-600"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Přidat první sdílenou komponentu (rámeček, nosič…)
            </button>
          ) : (
            <div className="mt-3 space-y-2">
              <ComponentTableHeader />
              {sharedComps.map((comp) => (
                <ComponentRow
                  key={comp.id}
                  comp={comp}
                  onUpdate={(p) => updateSharedComp(comp.id, p as Partial<KitSharedComponent>)}
                  onDelete={() => deleteSharedComp(comp.id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* SECTION 3 — Function types */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-kv-navy text-xs font-bold text-white">3</span>
              <h3 className="text-sm font-semibold text-kv-gray-800">Typy funkcí</h3>
              <span className="rounded-full bg-kv-gray-100 px-2 py-0.5 text-[10px] font-medium text-kv-gray-500">{functionTypes.length} typů</span>
            </div>
            <button
              onClick={addFunctionType}
              className="flex items-center gap-1.5 rounded-xl border border-kv-gray-200 bg-white px-3 py-2 text-xs font-semibold text-kv-gray-700 shadow-sm hover:bg-kv-gray-50"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Přidat typ funkce
            </button>
          </div>
          <SectionInfo>
            Každý typ funkce = jeden druh produktu (vypínač č.1, zásuvka 230V, stmívač…). Každý má vlastní strojek, klapku a příklady, jak zákazník tuto funkci poptává.
          </SectionInfo>
          {functionTypes.length === 0 ? (
            <button
              onClick={addFunctionType}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-kv-gray-200 py-8 text-sm text-kv-gray-400 transition-colors hover:border-kv-gray-300 hover:text-kv-gray-600"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Přidat první typ funkce (Vypínač č.1, Zásuvka 230V…)
            </button>
          ) : (
            <div className="mt-3 space-y-2">
              {functionTypes.map((ft, i) => (
                <FunctionTypeCard
                  key={ft.id}
                  ft={ft}
                  index={i}
                  onUpdate={(p) => updateFunctionType(ft.id, p)}
                  onDelete={() => deleteFunctionType(ft.id)}
                  onAddComponent={() => addFunctionComp(ft.id)}
                  onUpdateComponent={(cId, p) => updateFunctionComp(ft.id, cId, p)}
                  onDeleteComponent={(cId) => deleteFunctionComp(ft.id, cId)}
                  onAddExample={() => addExample(ft.id)}
                  onUpdateExample={(eId, q) => updateExample(ft.id, eId, q)}
                  onDeleteExample={(eId) => deleteExample(ft.id, eId)}
                />
              ))}
              <button
                onClick={addFunctionType}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-kv-gray-200 py-3 text-xs font-medium text-kv-gray-400 transition-colors hover:border-kv-gray-300 hover:text-kv-gray-600"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Přidat další typ funkce
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── CreateSeriesModal ─────────────────────────────────────────────────────────

function CreateSeriesModal({ onClose, onCreate }: { onClose: () => void; onCreate: (s: KitSeries) => void }) {
  const supabase = createClient();
  const [brand, setBrand] = useState("");
  const [series, setSeries] = useState("");
  const [color, setColor] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!brand.trim() || !series.trim() || !color.trim()) { setError("Vyplň všechna pole"); return; }
    setSaving(true);
    const { data, error: err } = await supabase
      .from("kit_series").insert({ brand: brand.trim(), series: series.trim(), color_name: color.trim() })
      .select().single();
    setSaving(false);
    if (err) { setError(err.message); return; }
    await invalidateBackendKBCache(supabase);
    onCreate(data as KitSeries);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-kv-gray-100 px-6 py-5">
          <h2 className="text-base font-bold text-kv-gray-800">Nová řada produktů</h2>
          <p className="mt-1 text-xs text-kv-gray-400">Např. ABB · Tango · bílá nebo Schneider · Unica · antracit</p>
        </div>
        <div className="space-y-4 px-6 py-5">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-kv-gray-700">Výrobce</label>
            <input
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="ABB, Schneider, Legrand…"
              className="w-full rounded-xl border border-kv-gray-200 px-3 py-2.5 text-sm focus:border-kv-blue-300 focus:outline-none"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-kv-gray-700">Řada</label>
            <input
              value={series}
              onChange={(e) => setSeries(e.target.value)}
              placeholder="Tango, Unica, Valena…"
              className="w-full rounded-xl border border-kv-gray-200 px-3 py-2.5 text-sm focus:border-kv-blue-300 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-kv-gray-700">Barva / varianta</label>
            <input
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="bílá, černá, antracit…"
              className="w-full rounded-xl border border-kv-gray-200 px-3 py-2.5 text-sm focus:border-kv-blue-300 focus:outline-none"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          {error && (
            <p className="flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-500">
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-kv-gray-100 px-6 py-4">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-kv-gray-600 hover:bg-kv-gray-100">Zrušit</button>
          <button
            onClick={submit}
            disabled={saving}
            className="flex items-center gap-2 rounded-xl bg-kv-navy px-5 py-2 text-sm font-semibold text-white hover:bg-kv-navy/90 disabled:opacity-60"
          >
            {saving ? "Vytvářím…" : "Vytvořit řadu"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function KitAdminClient({ email }: { email: string }) {
  const supabase = createClient();
  const [seriesList, setSeriesList] = useState<KitSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSeries, setSelectedSeries] = useState<KitSeries | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from("kit_series").select("*").order("brand").order("series").order("color_name");
      setSeriesList((data as KitSeries[]) ?? []);
      setLoading(false);
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deleteSeries = async (id: string) => {
    await supabase.from("kit_series").delete().eq("id", id);
    setSeriesList((prev) => prev.filter((s) => s.id !== id));
    setDeleteConfirm(null);
    await invalidateBackendKBCache(supabase);
  };

  const grouped: Record<string, KitSeries[]> = {};
  for (const s of seriesList) (grouped[s.brand] ??= []).push(s);

  if (selectedSeries) {
    return (
      <div className="flex h-screen flex-col bg-kv-gray-50">
        <Header email={email} isAdmin />
        <div className="flex-1 overflow-hidden">
          <SeriesEditor series={selectedSeries} onClose={() => setSelectedSeries(null)} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-kv-gray-50">
      <Header email={email} isAdmin />

      <div className="mx-auto max-w-4xl px-4 py-8">

        {/* Page header */}
        <div className="mb-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-kv-gray-900">Znalostní báze sad</h1>
              <p className="mt-1 text-sm text-kv-gray-500">
                Definice komponent pro každou řadu a barvu produktů · agent čte tuto databázi při zpracování poptávky na sadu
              </p>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="flex shrink-0 items-center gap-2 rounded-xl bg-kv-navy px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-kv-navy/90"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Přidat řadu
            </button>
          </div>

          {/* How it works */}
          <div className="mt-4 grid gap-3 rounded-2xl border border-kv-blue-100 bg-kv-blue-50 p-4 sm:grid-cols-3">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-kv-navy text-[10px] font-bold text-white">1</span>
              <div>
                <p className="text-xs font-semibold text-kv-gray-800">Řada + barva</p>
                <p className="text-[11px] text-kv-gray-500">Každá kombinace výrobce–řada–barva je samostatný záznam (Tango bílá ≠ Tango černá)</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-kv-navy text-[10px] font-bold text-white">2</span>
              <div>
                <p className="text-xs font-semibold text-kv-gray-800">Sdílené komponenty</p>
                <p className="text-[11px] text-kv-gray-500">Rámeček, nosič — platí pro celou řadu bez ohledu na funkci</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-kv-navy text-[10px] font-bold text-white">3</span>
              <div>
                <p className="text-xs font-semibold text-kv-gray-800">Typy funkcí</p>
                <p className="text-[11px] text-kv-gray-500">Pro každou funkci (vypínač, zásuvka…) definuješ strojek + klapku + příklady poptávek</p>
              </div>
            </div>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center rounded-2xl bg-white py-16 shadow-sm">
            <div className="flex items-center gap-3 text-sm text-kv-gray-400">
              <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Načítám…
            </div>
          </div>
        )}

        {!loading && seriesList.length === 0 && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-kv-gray-200 bg-white py-16 text-center transition-colors hover:border-kv-navy/30 hover:bg-kv-blue-50"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-kv-navy text-white">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-kv-gray-700">Přidat první řadu produktů</p>
              <p className="mt-0.5 text-xs text-kv-gray-400">Klikni sem a přidej první řadu (např. ABB Tango bílá)</p>
            </div>
          </button>
        )}

        {/* Series grouped by brand */}
        <div className="space-y-6">
          {Object.entries(grouped).map(([brand, items]) => (
            <div key={brand}>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-xs font-bold uppercase tracking-widest text-kv-gray-400">{brand}</h2>
                <span className="text-xs text-kv-gray-300">{items.length} řad</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((s) => (
                  <div
                    key={s.id}
                    className="group relative flex flex-col rounded-2xl bg-white p-4 shadow-sm ring-1 ring-kv-gray-100 transition-all hover:shadow-md hover:ring-kv-gray-200"
                  >
                    <div className="mb-3 flex items-start justify-between">
                      <div>
                        <p className="font-bold text-kv-gray-800">{s.series}</p>
                        <span className="mt-0.5 inline-block rounded-full bg-kv-gray-100 px-2 py-0.5 text-xs font-medium text-kv-gray-500">{s.color_name}</span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirm(s.id); }}
                        className="rounded-lg p-1.5 text-kv-gray-300 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-400 group-hover:opacity-100"
                        title="Smazat"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                        </svg>
                      </button>
                    </div>
                    {s.notes && <p className="mb-3 line-clamp-2 text-xs text-kv-gray-500">{s.notes}</p>}
                    <button
                      onClick={() => setSelectedSeries(s)}
                      className="mt-auto flex items-center justify-center gap-1.5 rounded-xl bg-kv-navy px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-kv-navy/90"
                    >
                      Upravit obsah
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m9 18 6-6-6-6" />
                      </svg>
                    </button>
                  </div>
                ))}

                {/* Inline add button in grid */}
                <button
                  onClick={() => setShowCreate(true)}
                  className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-kv-gray-200 py-8 text-kv-gray-400 transition-colors hover:border-kv-gray-300 hover:text-kv-gray-600"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                  <span className="text-xs font-medium">Přidat řadu</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showCreate && (
        <CreateSeriesModal
          onClose={() => setShowCreate(false)}
          onCreate={(s) => {
            setSeriesList((prev) => [...prev, s]);
            setShowCreate(false);
            setSelectedSeries(s);
          }}
        />
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-kv-navy/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
            <div className="border-b border-kv-gray-100 px-6 py-5">
              <h2 className="text-base font-bold text-kv-gray-800">Smazat řadu?</h2>
              <p className="mt-1 text-sm text-kv-gray-500">Smažou se i všechny sdílené komponenty, typy funkcí a příklady. Tato akce je nevratná.</p>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4">
              <button onClick={() => setDeleteConfirm(null)} className="rounded-xl px-4 py-2 text-sm text-kv-gray-600 hover:bg-kv-gray-100">Zrušit</button>
              <button onClick={() => deleteSeries(deleteConfirm)} className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600">Smazat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
