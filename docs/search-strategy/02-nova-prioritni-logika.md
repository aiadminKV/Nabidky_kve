# Nová prioritní logika vyhledávání

> Design dokument pro refaktoring pipeline. Datum: 1. 4. 2026.
> Implementuje se postupně v `backend/src/services/searchPipeline.ts`.

---

## Proč měníme logiku

Současný pipeline má jednu zásadní chybu: **MATCHER a SELECTOR míchají technickou správnost s obchodními kritérii (cena, sklad, výrobce) na stejné úrovni.** Výsledek je, že agent:

- Vybírá levnější produkt s jiným průřezem (bezpečnostní chyba)
- Substituuje výrobce bez varování ("preferovaný výrobce ABB – nenalezen, vybral Legrand")
- Vrací "match s 95% důvěrou" pro produkt jiné barvy nebo balení

Správná filozofie: **nejdřív najdi technicky správný produkt, teprve pak rozhoduj o variantě/výrobci/skladu.**

---

## Nová prioritní hierarchie

### Priority 1 — EAN (100% match, okamžitý return)

EAN je celosvětový jednoznačný identifikátor. Pokud EAN sedí, je to **definitivní** shoda.

```
EAN match nalezen → okamžitý return, přeskočit MATCHER i SELECTOR
  matchMethod: "ean"
  matchType: "match"
  confidence: 100
  reasoning: "Produkt nalezen přesnou shodou EAN."
```

**Žádná AI validace není potřeba.** EAN nemůže identifikovat jiný produkt.

**Odkud přichází EAN lookup:**
- `lookupProductsExact(normalizedName)` → match_type = "ean_exact"
- `lookupProductsExact(code)` pro kódy z `item.extraLookupCodes` → match_type = "ean_exact"

---

### Priorita 2 — Objednací kód / kód výrobce (98% match, AI validace typu)

Objednací kód (IDNLF) nebo SKU z **explicitního zdrojového sloupce** (Excel, obrázek s tabulkou) je velmi silný signál — ale ne neomylný (překlep, záměna sloupce).

```
Kód match nalezen → AI validace: "Je to vůbec tento typ produktu?"
  Pokud typ sedí:
    matchMethod: "order_code"
    matchType: "match"
    confidence: 98
  Pokud typ nesedí (extrémní případ — překlep kódu):
    matchMethod: "order_code"
    matchType: "uncertain"
    confidence: 60
    reasoning: "Kód nalezen, ale typ produktu neodpovídá zadání."
```

**Klíčové:** Kód musí přijít ze **správného sloupce** — z `item.extraLookupCodes` (explicitní kódový sloupec z Excelu/tabulky), NEBO z AI extraktoru kódů z textu (`aiExtractedCodes`).

**Neplatí pro:** Fulltext shodu kde název produktu obsahuje kód jako součást textu → to je stále sémantické hledání.

---

### Priorita 3 — Výrobce + řada (hard constraint, není prostor pro substituci)

Pokud uživatel (nebo skupinový kontext) specifikoval preferovaného výrobce, je to **závazná podmínka**, ne preference.

```
groupContext.preferredManufacturer je nastaven?
  → Hledej VÝHRADNĚ od tohoto výrobce
  → Nalezen produkt od preferovaného výrobce:
      matchMethod: "manufacturer"
      matchType: "match" nebo "multiple" nebo "uncertain"
  → Nenalezen produkt od preferovaného výrobce:
      matchType: "not_found"
      reasoning: "Výrobce [X] nebyl nalezen pro tento produkt v katalogu."
      → NEVOLÍME alternativu bez explicitní žádosti uživatele!
```

**Proč ne substituci:** Obchodník nastavil výrobce záměrně (rámcová smlouva, projektová specifikace, zákaznická preference). Automatická substituce může způsobit problém.

---

### Priorita 4 — Obecné technické vyhledávání

Bez specifikace výrobce/kódu hledáme technicky správný produkt.

```
matchMethod: "semantic"
→ MATCHER rozhoduje čistě technicky (typ + parametry)
→ SELECTOR vybírá z technicky správných kandidátů
→ Více technicky shodných → "multiple", user vybírá
→ Nic technicky nesedí → "not_found" (agent MŮŽE přiznat prohru!)
```

---

### Priorita 5 — Sklad (pouze tiebreaker)

Sklad je relevantní **pouze** ve specifickém případě: dva nebo více technicky **identických** produktů se liší pouze skladovostí (nebo větví).

```
Technicky identické produkty v shortlistu?
  → Preferuj skladem (has_stock = true)
  → Při rovnosti: preferuj is_stock_item = true
  → Cena: tiebreaker pouze pro VÝBĚRKO
```

**Sklad nikdy nenahrazuje technickou správnost.** Neskladový technicky správný > skladový technicky špatný.

---

## Architektura po změně

```
Poptávka
│
├─ Reformulace + Code Extractor (paralelně)
│
├─ Fan-out search (fulltext + semantic + exact)
│
├─ ─ ─ PRIORITY GATE ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
│   │
│   ├─ Gate 1: EAN exact? → return okamžitě (bez MATCHER/SELECTOR)
│   │
│   ├─ Gate 2: Order code exact (idnlf/sku)? → AI type check → return (bez SELECTOR)
│   │
│   └─ Gate 3: Pokračuj do MATCHER/SELECTOR
│
├─ MATCHER (čistě technický filtr)
│   Input: kandidáti BEZ ceny, skladu, výrobce jako rozhodovacích faktorů
│   Output: technicky odpovídající shortlist
│         → prázdný shortlist = "not_found" (poctivé)
│
└─ SELECTOR (business + variant rozhodnutí)
    Input: shortlist + cena + sklad + výrobce + offerType
    Priority:
      1. preferovaný výrobce (hard constraint, nebo not_found)
      2. varianta bez specifikace → "multiple"
      3. kabely: KRUH vs BUBEN logika
      4. sklad (tiebreaker)
      5. cena (jen pro VÝBĚRKO)
```

---

## Změny v kódu

### 1. Nové pole `matchMethod` v `PipelineResult`

```typescript
export interface PipelineResult {
  // ... stávající pole ...
  matchMethod: "ean" | "order_code" | "manufacturer" | "semantic" | "not_found";
}
```

### 2. Priority Gate v `searchPipelineForItem`

```typescript
// Po merge všech výsledků, PŘED MATCHER:

// Gate 1: EAN
const eanExact = [...exactResults, ...extraExactResults]
  .filter(r => r.match_type === "ean_exact");
if (eanExact.length > 0) {
  return buildEanResult(eanExact[0], item, position, t0);
}

// Gate 2: Order code (idnlf/sku z explicitních kódů)
const orderCodeExact = [
  ...exactResults.filter(r => r.match_type !== "ean_exact"),
  ...extraExactResults.filter(r => r.match_type !== "ean_exact"),
];
if (orderCodeExact.length > 0) {
  const typeCheck = await validateProductType(item.name, orderCodeExact[0]);
  return buildOrderCodeResult(typeCheck, orderCodeExact[0], item, position, t0);
}

// Gate 3: Pokračuj do MATCHER/SELECTOR
```

### 3. MATCHER — odebrat cenu/sklad z payloadu

```typescript
// PŘED (matchCandidates):
const top60 = candidates.slice(0, 60).map(c => ({
  sku: c.sku, name: c.name, unit: c.unit,
  current_price: c.current_price,     // ← ODEBRAT
  is_stock_item: c.is_stock_item,     // ← ODEBRAT
  has_stock: c.has_stock,             // ← ODEBRAT
  ...
}));

// PO:
const top60 = candidates.slice(0, 60).map(c => ({
  sku: c.sku, name: c.name, unit: c.unit,
  category_sub: c.category_sub, category_line: c.category_line,
  similarity: ..., source: c.source,
  foundByExactCode: c.source === "exact",
}));
```

### 4. SELECTOR — výrobce jako hard constraint

```typescript
// V selectProduct, před sestavením payloadu:
if (groupContext?.preferredManufacturer) {
  const mfrInShortlist = enrichedShortlist.some(
    s => (candidateMap.get(s.sku)?.supplier_name ?? "")
      .toLowerCase()
      .includes(groupContext.preferredManufacturer!.toLowerCase())
  );
  if (!mfrInShortlist) {
    return {
      selectedSku: null,
      matchType: "not_found",
      confidence: 0,
      reasoning: `Preferovaný výrobce "${groupContext.preferredManufacturer}" nenalezen. Produkt nebyl přiřazen.`,
      priceNote: null,
    };
  }
}
```

### 5. `matchMethod` tracking

```typescript
// V searchPipelineForItem, při sestavování výsledku:
let matchMethod: PipelineResult["matchMethod"] = "semantic";
if (exactLookupFound) {
  const hasEan = [...exactResults, ...extraExactResults].some(r => r.match_type === "ean_exact");
  const hasCode = [...exactResults, ...extraExactResults].some(r => r.match_type !== "ean_exact");
  if (hasEan) matchMethod = "ean";
  else if (hasCode) matchMethod = "order_code";
}
if (selectorResult.matchType === "not_found") matchMethod = "not_found";
if (groupContext?.preferredManufacturer && selectorResult.selectedSku) matchMethod = "manufacturer";
```

---

## Nový MATCHER prompt (klíčové změny)

**Co MATCHER hodnotí:**
- Typ produktu (jistič ≠ pojistka, CY ≠ CYA)
- Technické parametry (průřez, póly, proud, IP, wattáž)
- Měrná jednotka pro kabely (KRUH/BUBEN/metráž)

**Co MATCHER NEVIDÍ ani NEHODNOTÍ:**
- Cena
- Sklad (has_stock, is_stock_item)
- Výrobce (to není technický parametr)
- Dostupnost

**Když nic nesedí → prázdný shortlist (poctivé "nenašel jsem")**

---

## Nový SELECTOR prompt (klíčové změny)

**Priority (v pořadí):**
1. `foundByExactCode = true` → vyber, confidence 98, typ ověřen upstream
2. `groupContext.preferredManufacturer` → **POUZE kandidáti od tohoto výrobce**
   - Pokud nikdo v shortlistu → `not_found` (bez substituci!)
3. Více technicky shodných variant bez specifikace → `matchType: "multiple"`, `selectedSku: null`
4. Kabely: KRUH vs BUBEN logika
5. Sklad: **tiebreaker** — pouze pokud jsou kandidáti technicky identičtí
6. Cena: **pouze pro VÝBĚRKO**, sekundárně po splnění výše

---

## Frontend — ikony matchMethod

| matchMethod | Ikona | Barva | Tooltip |
|---|---|---|---|
| `ean` | barcode scan | zelená | "Nalezeno přesnou shodou EAN" |
| `order_code` | hash # | modrá | "Nalezeno přes objednací kód" |
| `manufacturer` | factory | fialová | "Nalezeno dle výrobce/řady" |
| `semantic` | brain / search | šedá | "Nalezeno sémantickým vyhledáváním" |
| `not_found` | x-circle | červená | — |

Ikona se zobrazí v ResultsTable u každé řádky vedle match confidence.

---

## Co se tímto NEŘEŠÍ

- Katalogové mezery (produkt fyzicky chybí v DB)
- Synonymie v fulltextu (JEDNORAMECEK = rámeček jednonásobný)
- LLM non-determinismus v edge casech

Tyto problémy jsou v `01-architektura-pipeline.md` označeny jako strukturální limity vyžadující datové nebo infrastrukturní změny.
