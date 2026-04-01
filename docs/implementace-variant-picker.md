# Implementace: Výběr varianty uživatelem

## Kontext a ověřená hypotéza

### Problém (empiricky ověřeno)
Evaluace 142 položek ukázala: **14 položek** dostalo `matchType: "multiple"`, z toho **13/14 = 93 % bylo špatně vybraných** s průměrnou důvěrou **95 %**.

Agent má v promptu explicitní instrukci:
> _"Více kandidátů se stejným skóre → 'multiple' (ale stále vyber jednoho)"_

Výsledek: agent vybírá arbitrárně (první vhodný kandidát), ale vrátí `confidence: 95–100 %`, protože si je jistý typem produktu — ne konkrétní variantou. Uživatel vidí "vybrán produkt" s vysokou důvěrou, i když výběr byl náhodný.

### Identifikované kategorie chybějícího atributu

| Atribut | Příklady |
|---|---|
| **Barva (color code)** | ZZ = žluto-zelená (PE), C = červená, S = šedá, B = bílá |
| **Typ žíly** | J = plné jádro (solid), O = lanko (flexible) |
| **Typ bubnu** | BUBEN vs BUBEN NEVRATNÝ |

### Co ring/reel logika — netřeba měnit
Samostatný test potvrdil, že **volba KRUH vs BUBEN funguje správně**:
- 100m → KRUH 100M ✅ (ne 4×KRUH 25M)
- 690m → BUBEN ✅ (690/100 = 6.9, nedělitelné)
- 75m → KRUH 25M ✅ (75/25 = 3, celé číslo)

Problémy s kabely v evaluaci jsou výlučně **varianta balení nebo typ žíly**, ne ring logika.

---

## Navrhované řešení

### Princip
Místo arbitrárního výběru → agent **signalizuje, že atribut chybí**, a předá všechny varianty uživateli k výběru.

**Tok:**
```
Poptávka → Pipeline → SELECTOR detekuje stejně hodnotné varianty
  → matchType: "multiple", selectedSku: null, candidates: [všechny varianty]
  → Frontend zobrazí inline picker
  → Uživatel vybere
  → matchType: "match", confirmed: true
```

---

## Změny — Backend

### 1. `SELECTOR_PROMPT` — změna jednoho pravidla

**Soubor:** `backend/src/services/searchPipeline.ts`, řádek 705

**Aktuálně:**
```
- Více kandidátů se stejným skóre → "multiple" (ale stále vyber jednoho)
```

**Nově:**
```
- Více kandidátů se stejným skóre, lišící se v atributu NESPECIFIKOVANÉM v poptávce
  (barva, typ žíly J/O, typ balení BUBEN/BUBEN NEVRATNY apod.) →
  matchType: "multiple", selectedSku: null, confidence: 0
  V reasoning uveď: "Uživatel musí upřesnit: [název chybějícího atributu]"

- Více kandidátů se stejným skóre, ALE poptávka obsahuje dostatek info k výběru
  (např. zmíněna barva, typ) → vyber normálně, matchType: "match"
```

**Logika pro SELECTOR:** Porovnej kandidáty v shortlistu — pokud se liší v jednom atributu (barva v názvu, přípona -J/-O, slovo NEVRATNY) a tento atribut v `demand.name` chybí → vrať null.

### 2. Pipeline — počet candidates pro "multiple"

**Soubor:** `backend/src/services/searchPipeline.ts`, řádky 1046–1072

**Problém:** Candidates jsou oříznuty na 5 (`topCands.slice(0, 5)`). Pokud je 6+ barevných variant, uživatel část nevidí.

**Úprava:** Pro `matchType === "multiple"` vrátit **všechny shortlist položky** bez ořezu (shortlist má max. 8 dle MATCHER promptu, v praxi 4–6 variant).

```typescript
// Aktuálně:
candidates: topCands.slice(0, 5).map(slimCandidate),

// Nově:
candidates: (selectorResult.matchType === "multiple"
  ? topCands  // všechny shortlist varianty
  : topCands.slice(0, 5)
).map(slimCandidate),
```

---

## Změny — Frontend

### 3. `ResultsTable.tsx` — inline variant picker

**Kde:** V buňce "Produkt" (řádky ~610–660), podmínka `item.matchType === "multiple"`.

**Namísto** zobrazení `—` nebo vybraného produktu zobrazit kompaktní seznam variant:

```tsx
{item.matchType === "multiple" && item.candidates.length > 0 ? (
  <VariantPicker
    candidates={item.candidates}
    missingAttr={item.reasoning}  // reasoning obsahuje "Uživatel musí upřesnit: barva"
    onSelect={(product) => onSelectProduct(item.itemId, product)}
  />
) : (
  // stávající zobrazení produktu
)}
```

**Komponenta `VariantPicker`** (nová, ~60 řádků):
- Zobrazí nadpis: _"Vyberte variantu"_ + z reasoning vyextrahuje atribut
- Pro každý kandidát: název, SKU, cena, skladovost (badge)
- Klik → zavolá `onSelectProduct`, nastaví `matchType: "match"`, `confirmed: true`

### 4. `ResultsTable.tsx` — summary counter

**Aktuálně** (řádek 326):
```tsx
const uncertainCount = items.filter(
  (i) => (i.matchType === "uncertain" || i.matchType === "alternative") && !i.parentItemId
).length;
```

**Nově** — přidat `"multiple"`:
```tsx
const uncertainCount = items.filter(
  (i) => (i.matchType === "uncertain" || i.matchType === "alternative" || i.matchType === "multiple") && !i.parentItemId
).length;
```

Tím se `multiple` položky zobrazí v summary baru jako "N nejistých" a uživatel ví, že musí doplnit výběr.

---

## Rizika a edge cases

| Riziko | Mitigace |
|---|---|
| SELECTOR vrátí null i když poptávka info obsahuje | Prompt explicitně říká: pokud info JE → vyber normálně. Lze ladit dalším testováním. |
| Méně než 2 kandidáti v "multiple" (edge case) | Fallback: pokud `candidates.length < 2` → vyber první, `matchType: "uncertain"` |
| Uživatel picker ignoruje, exportuje bez výběru | Položky bez produktu (product: null) by měly být blokovány při exportu |
| BUBEN NEVRATNÝ vs BUBEN — uživatel nerozumí rozdílu | V pickeru zobrazit celý název + tooltip/info |

---

## Pořadí implementace

1. **SELECTOR prompt** — změna jednoho řádku, okamžitý efekt
2. **Pipeline candidates count** — 3 řádky kódu
3. **Summary counter** — 1 řádek
4. **VariantPicker komponenta** — nová komponenta, ~60 řádků
5. **ResultsTable integrace** — podmínka v buňce produktu

**Doporučený postup:** Implementovat 1–3 společně (backend), otestovat že SELECTOR vrací null + správné candidates, pak 4–5 (frontend).

---

## Dopad na evaluaci (odhad)

Aktuálně: **93 % z "multiple" = špatně** (13/14).  
Po implementaci: Tyto položky přejdou do stavu `matchType: "multiple"` → uživatel vybere → **0 špatných výběrů** v této kategorii.

Z celkového skóre: 13 položek přestane být "špatně" a stane se "čeká na uživatele".  
13/74 špatných = **-18 % špatných výsledků** oproti aktuálnímu stavu.
