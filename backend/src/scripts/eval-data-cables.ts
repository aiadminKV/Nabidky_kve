/**
 * eval-data-cables.ts
 *
 * Ground truth pro kabelový eval.
 *
 * checkMode:
 *   "selected"  — expectedSkus musí obsahovat selectedSku (přesná shoda)
 *   "any"       — stačí, když se expectedSkus překrývá s selectedSku ∪ alternativeSkus
 *
 * expectMultiple:
 *   true  — agent by měl vrátit matchType: "multiple" (barevné/délkové varianty bez specifikace)
 *           a expectedSkus se hledají v alternativeSkus
 *
 * stockFilter:
 *   "stock_items_only" | "any" — přepisuje globální nastavení pro konkrétní položku
 */

export interface CableEvalItem {
  id: number;
  demand: string;
  unit: string;
  quantity: number;
  expectedSkus: string[];       // správné SKU(s) — buben, kruh nebo konkrétní varianta
  expectMultiple: boolean;      // true = agent má vrátit multiple (nevybírat barvu)
  stockFilter: "stock_items_only" | "any";
  note: string;
}

export const CABLE_EVAL_ITEMS: CableEvalItem[] = [
  // ── CXKH-R-J běžné průřezy (skladovky, agent má najít) ─────────────────
  {
    id: 1,
    demand: "CXKH-R-J 5×1,5",
    unit: "m", quantity: 3310,
    expectedSkus: ["1257674"],         // KABEL 1-CXKH-R-J B2CAS1D0 5X1,5 BUBEN
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "Buben — skladovka existuje",
  },
  {
    id: 2,
    demand: "CXKH-R-J 5×2,5",
    unit: "m", quantity: 246,
    expectedSkus: ["1257673"],         // KABEL 1-CXKH-R-J B2CAS1D0 5X2,5 BUBEN
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "Buben — skladovka existuje",
  },
  {
    id: 3,
    demand: "CXKH-R-J 5×4",
    unit: "m", quantity: 269,
    expectedSkus: ["1257672"],         // KABEL 1-CXKH-R-J B2CAS1D0 5X4 BUBEN
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "Buben — skladovka existuje",
  },
  {
    id: 4,
    demand: "CXKH-R-J 5×6",
    unit: "m", quantity: 78,
    expectedSkus: ["1257671"],         // KABEL 1-CXKH-R-J B2CAS1D0 5X6 BUBEN
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "Buben — skladovka existuje",
  },
  {
    id: 5,
    demand: "CXKH-R-J 3×1,5",
    unit: "m", quantity: 15019,
    expectedSkus: ["1314262"],         // KABEL 1-CXKH-R-J B2CAS1D0 3X1,5 BUBEN
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "Buben — skladovka existuje",
  },
  {
    id: 6,
    demand: "CXKH-R-J 3×2,5",
    unit: "m", quantity: 18962,
    expectedSkus: ["1257675"],         // KABEL 1-CXKH-R-J B2CAS1D0 3X2,5 BUBEN
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "Buben — skladovka existuje",
  },

  // ── CXKH-R-J velké průřezy (NEJSOU skladovky) ──────────────────────────
  {
    id: 7,
    demand: "CXKH-R-J 5×10",
    unit: "m", quantity: 78,
    expectedSkus: ["1203901", "1418579"],
    expectMultiple: false,
    stockFilter: "any",
    note: "Není skladovka — agent musí hledat bez stock filtru",
  },
  {
    id: 8,
    demand: "CXKH-R-J 5×16",
    unit: "m", quantity: 470,
    expectedSkus: ["1203900", "1452752"],
    expectMultiple: false,
    stockFilter: "any",
    note: "Není skladovka",
  },
  {
    id: 9,
    demand: "CXKH-R-J 5×50",
    unit: "m", quantity: 118,
    expectedSkus: ["1228216", "1690842"],
    expectMultiple: false,
    stockFilter: "any",
    note: "Není skladovka",
  },
  {
    id: 10,
    demand: "CXKH-R-J 5×95",
    unit: "m", quantity: 62,
    expectedSkus: ["1149824", "1352637", "1733661"],
    expectMultiple: false,
    stockFilter: "any",
    note: "Není skladovka",
  },

  // ── CXKH-V-J varianta ───────────────────────────────────────────────────
  {
    id: 11,
    demand: "CXKH-V-J 5×1,5",
    unit: "m", quantity: 45,
    expectedSkus: ["1257666"],         // KABEL 1-CXKH-V-J P60-R B2CAS1D0 5X1,5 BU
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "V-J varianta (plochý) — nesmí splést s R-J (kulatý)",
  },
  {
    id: 12,
    demand: "CXKH-R-O 3×1,5",
    unit: "m", quantity: 10086,
    expectedSkus: ["1257676"],
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "R-O (bez ochranného vodiče) — nesmí splést s R-J",
  },

  // ── Vodiče CYA bez barvy → agent musí vrátit multiple ───────────────────
  {
    id: 13,
    demand: "Vodič CYA35",
    unit: "m", quantity: 174,
    expectedSkus: ["1257514", "1257463004", "1257462004", "1257473004"],
    expectMultiple: true,
    stockFilter: "stock_items_only",
    note: "Barva nespecifikována — agent NESMÍ vybrat jednu barvu, musí vrátit multiple",
  },
  {
    id: 14,
    demand: "Vodič CYA50",
    unit: "m", quantity: 162,
    expectedSkus: ["1257467004"],      // ZZ varianta jako příklad — hledáme aspoň v candidates
    expectMultiple: true,
    stockFilter: "stock_items_only",
    note: "Barva nespecifikována → multiple",
  },
  {
    id: 15,
    demand: "Vodič CYA 6",
    unit: "m", quantity: 500,
    expectedSkus: [],                  // jen kontrola, že vrátí multiple
    expectMultiple: true,
    stockFilter: "stock_items_only",
    note: "Barva nespecifikována → multiple",
  },

  // ── CYKY-J ──────────────────────────────────────────────────────────────
  {
    id: 16,
    demand: "CYKY-J 5×6",
    unit: "m", quantity: 202,
    expectedSkus: ["1257429004"],
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "BUBEN — 202m, nevychází na kruh",
  },
  {
    id: 17,
    demand: "CYKY-J 3×1,5",
    unit: "m", quantity: 386,
    expectedSkus: ["1257383007"],
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "BUBEN nebo KRUH 100M × 3+KRUH 50M × 1+... — agent si má vybrat",
  },
  {
    id: 18,
    demand: "CYKY-J 5×1,5",
    unit: "m", quantity: 123,
    expectedSkus: ["1257397007"],
    expectMultiple: false,
    stockFilter: "stock_items_only",
    note: "123m — nevychází na standardní kruhy → BUBEN",
  },
];
