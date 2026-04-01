# Implementace: Opravy pipeline — komplexní přehled

> Tento dokument navazuje na [`implementace-variant-picker.md`](./implementace-variant-picker.md),
> který řeší výběr varianty uživatelem (matchType: "multiple" + frontend picker).
> Zde jsou řešeny všechny ostatní identifikované problémy z evaluace 142 položek.

---

## Přehled všech problémů a jejich řešení

| # | Problém | Počet affected | Kde opravit | Složitost |
|---|---|---|---|---|
| **P0** | **EAN/kód nalezen exact lookup, ale MATCHER ho vyřadí** | neznámý | MATCHER + SELECTOR prompt + payload | Střední |
| P1 | Barva/varianta vrácena jako "match" (ne "multiple") | ~17 | SELECTOR prompt | Nízká |
| P2 | Brand substitution — cena > groupContext | 5 | Search reformulation | Střední |
| P3 | MATCHER přidá špatný průřez/póly/páry | 5+ | MATCHER prompt | Nízká |
| P4 | Packaging délka datových kabelů | 1–2 | SELECTOR prompt | Nízká |
| P5 | Katalogové mezery | ~25 | Data (není tech fix) | — |

---

## P0: EAN/kód — přesný nález ztrácen v MATCHER bariéře

### Problém (architekturální)

Exact lookup funguje správně — najde produkt přes EAN nebo objednací kód s cosine `0.97–1.0`.
Ale tuto informaci **nepředá MATCHERu ani SELECTORu**. Výsledek:

```
Poptávka: "ABB zasuvka 5518-2929S"
    ↓ exact lookup → ZASUVKA IP54 3558N-C01510 B (správný produkt, source="exact")
    ↓ MATCHER vidí: demand "ABB zasuvka 5518-2929S" vs kandidát "ZASUVKA IP54..."
    ↓ jména se nepodobají → matchScore: 35 → vyřazen ze shortlistu
    ↓ SELECTOR nikdy správný produkt nevidí
```

Klíčový insight: **poptávka má kontext kódu, extrahovaný produkt z ceníku má kontext kódu** — ale pipeline je nespojí. MATCHER porovnává jméno s jménem a "nevidí", že oba sdílí stejný kód.

### Příčina

`MergedCandidate` má `source: "raw" | "reformulated" | "fulltext" | "exact" | "both"` — informace existuje, ale **není předána do MATCHER payloadu**. MATCHER AI ji nevidí.

### Řešení — předání `foundByExactCode` do payloadu

**Soubor:** `backend/src/services/searchPipeline.ts` — funkce `matchCandidates` a `selectProduct`

**Krok 1 — MATCHER payload:** přidat příznak `foundByExactCode` ke každému kandidátovi:

```typescript
// V matchCandidates, při sestavení payloadu pro AI:
candidates: top60.map(c => ({
  sku: c.sku,
  name: c.name,
  current_price: c.current_price,
  // ... ostatní pole ...
  foundByExactCode: c.source === "exact",  // nový flag
}))
```

**Krok 2 — MATCHER prompt:** přidat pravidlo:

```
## Exact code match — ABSOLUTNÍ PRIORITA

Pokud kandidát.foundByExactCode = true:
→ Automaticky zařaď do shortlistu s matchScore: 97
→ Název nemusí vizuálně odpovídat poptávce — byl nalezen přesnou shodou kódu/EAN
→ Toto pravidlo má přednost před všemi ostatními
```

**Krok 3 — SELECTOR payload:** předat příznak dál:

```typescript
// V selectProduct, enrichedShortlist:
return {
  sku: s.sku,
  name: c?.name ?? "?",
  // ... ostatní ...
  foundByExactCode: candidateMap.get(s.sku)?.source === "exact",
};
```

**Krok 4 — SELECTOR prompt:** přidat pravidlo:

```
## Exact code match — VÝBĚR

Pokud vybraný kandidát má foundByExactCode = true:
→ VŽDY ho vyber, confidence: 99, matchType: "match"
→ Ostatní pravidla (cena, výrobce, varianta) se NEAPLIKUJÍ
→ reasoning: "Produkt nalezen přesnou shodou kódu/EAN."
```

### Rizika a mitigace

| Riziko | Mitigace |
|---|---|
| Kód v poptávce je překlep → exact lookup najde špatný produkt | MATCHER stále může vetovat pokud typ absolutně nesedí (matchScore < 20) |
| Více produktů nalezeno přes kód (edge case) | Seřadit dle `cosine_similarity`, vybrat první |
| foundByExactCode = true ale produkt není skladem | SELECTOR může přidat `priceNote` varování, ale produkt stále vybere |

### Dopad

Pokrývá všechny situace kde uživatel zadá EAN, SKU nebo objednací kód výrobce (IDNLF) — i když je kód v textu poptávky "schovaný" v delším popisu.

---

## P1: Barva/varianta vrácena jako "match" — rozšíření

### Problém
Předchozí dok řeší 13 případů kde SELECTOR vrátil `matchType: "multiple"`. Analýza ukázala dalších **17 případů kde vrátil `matchType: "match"` s 89–99 % důvěrou** — přitom šlo o stejnou situaci (arbitrární výběr barvy).

Příklady:
- `VODIC CYA H07V-K 70 ZZ` vs `VODIC CYA H07V-K 70 C` → vráceno jako `match 99 %`
- `TRUBKA TUHA 1532 KA SVETLE SEDA /3M/` vs `TRUBKA TUHA 32MM SV. SEDA 2M` → `match 98 %`
- `ZLAB LINEAR+ L1B-N 50/50 ZZ` vs `ZLAB LINEAR+ L1B-N 50/50 SZ` → `match 98 %`
- `JEDNORAMECEK 3901A-B10 B` vs `UNICA RAMECEK JEDNONASOBNY BILA` → `match 99 %`

### Příčina
SELECTOR prompt říká "Více kandidátů se stejným skóre → 'multiple' (ale stále vyber jednoho)" — tato instrukce je vágní. Agent interpretuje "multiple" jako volitelné a místo toho vrátí "match" s falešnou důvěrou.

### Řešení — SELECTOR prompt (rozšíření P1 z předchozího dok.)

Instrukce pro detekci variantní situace musí být **explicitnější a závazná**. Nahradit stávající řádek 705 tímto blokem:

```
## Detekce varianty bez specifikace — KRITICKÉ PRAVIDLO

Před výběrem porovnej VŠECHNY kandidáty v shortlistu. Pokud platí VŠECHNY tyto podmínky:
  a) Kandidáti se liší pouze v JEDNOM atributu
  b) Tento atribut NENÍ uveden v demand.name
  c) Tento atribut NEMÁ jednoznačnou obchodní preferenci (není levnější, není víc skladem)

→ NEZÁVISLE na matchType VŽDY vrať:
  selectedSku: null
  matchType: "multiple"
  confidence: 0
  reasoning: "Uživatel musí upřesnit: [název atributu]. Dostupné varianty: [seznam]"

Typické atributy pro kontrolu:
- Barva: kódy ZZ / C / R / S / B / ZE / BI / CE / OR nebo slova ZLUTOZELENA / CERVENA / CERNA / SEDA / BILA / HNEDA / MODRA
- Typ žíly: přípona -J (plné) vs -O (lanko/flexibilní)
- Typ balení: BUBEN vs BUBEN NEVRATNY
- Délka kusu: /2M/ vs /3M/ (u trubek, lišt)
- Barva žlabu: ZZ (žluto-zelená) vs SZ (světle šedá) vs TM (tmavě šedá)

Pokud poptávka atribut OBSAHUJE (např. "ZLUTOZELENA" nebo "lanko") → vyber normálně.
```

**Dopad:** Pokryje VŠECHNY variantní situace konzistentně — jak těch 13 "multiple", tak 17 "match" případů.

---

## P2: Brand substitution — výrobce nenalezen ve vyhledávání

### Problém
5× `rámeček jednonásobný` → expected ABB `JEDNORAMECEK 3901A-B10 B`, selected Legrand Unica.  
Reasoning SELECTORU: _"Preferovaný výrobce ABB zde v nabídce není zastoupen"_ — tedy ABB produkt **vůbec neskončil v candidates**, ne že by ho SELECTOR ignoroval.

### Příčina
Vyhledávání (embedding + fulltext) nenajde správný ABB produkt. `groupContext.preferredManufacturer = "ABB"` se předává pouze SELECTORU — ale kandidáti jsou již vybráni před SELECTORem. Pokud embedding "rámeček jednonásobný" nesurfuje ABB produkt, groupContext nepomůže.

### Řešení — dvě úrovně, obě promptem

**Úroveň 1 (okamžitá) — SELECTOR varování**

Přidat do SELECTOR promptu instrukci:
```
Pokud groupContext.preferredManufacturer existuje ALE žádný kandidát v shortlistu
není od tohoto výrobce → v reasoning uveď:
"⚠️ Preferovaný výrobce [X] nebyl nalezen v nabídce. Vybrána nejlepší dostupná alternativa."
```
Uživatel alespoň vidí, že preferovaný výrobce chybí a může ručně zasáhnout.

**Úroveň 2 (plná) — Reformulace s kontextem výrobce**

Předat `groupContext` do `createSearchPlan` a přidat instrukci:
```
Pokud je k dispozici preferredManufacturer, vytvoř DVOUPRŮCHODOVÝ plán vyhledávání:
1. Primární dotaz: "[název produktu] [výrobce]" — cílí přímo na preferovaného výrobce
2. Záložní dotaz: "[název produktu]" — generická varianta pro alternativy

Oba dotazy spusť paralelně, výsledky slouč. Tak máš šanci najít preferovaný produkt
i pokud by primární dotaz nic nevrátil.
```

**Proč ne kód:** Kdybychom v kódu napsali `query = name + " " + manufacturer`, přidáme to do KAŽDÉHO vyhledávání automaticky — to by mohlo přes-specifikovat hledání pro jiné kategorie kde výrobce v katalogu není. LLM v `createSearchPlan` to posoudí kontextově.

**Doporučení:** Implementovat Úroveň 1 hned (1 instrukce do SELECTOR promptu). Úroveň 2 po ověření, že reformulace `createSearchPlan` context přijímá.

### Doplněk do SELECTOR promptu (okamžitá verze)

Přidat do sekce "Odpověď":
```
- Pokud groupContext.preferredManufacturer existuje ALE žádný kandidát v shortlistu není
  od tohoto výrobce → do reasoning uveď:
  "⚠️ Preferovaný výrobce [X] nebyl nalezen. Vybrána nejlepší dostupná alternativa."
```

---

## P3: MATCHER přidá špatný průřez

### Problém
- `NSGAFOU 1x95mm²` → MATCHER zahrnul `1x240mm²` do shortlistu → SELECTOR vybral s důvěrou 86 %
- `kabel instalační CYKY 4x10mm²` → zahrnuto `4x70mm²` → vybráno jako alternative (55 %)

Pro silové kabely a vodiče je průřez **bezpečnostně kritický parametr** — záměna 95mm² za 240mm² je zásadní chyba.

### Příčina
MATCHER prompt obsahuje pravidlo:
```
- 50-69: Typ sedí, ale parametry se liší (jiný proud, jiný průřez)
- <50: Nezařazuj do shortlistu
```

Přesto MATCHER zařadí 1x240 do shortlistu s matchScore ≥ 70, pravděpodobně protože vidí "NSGAFOU 1x... průmyslový kabel" a považuje průřez za méně kritický parametr.

### Řešení — MATCHER prompt, explicitní pravidlo pro průřez

**Soubor:** `backend/src/services/searchPipeline.ts`, sekce `MATCHER_PROMPT`.

Přidat za stávající sekci o kabelech:

```
## Průřez a počet žil — TVRDÉ PRAVIDLO (bezpečnostně kritické)

Pro kabely, vodiče, přípojnice a svorky:
- Průřez (mm²) MUSÍ přesně odpovídat poptávce. Odlišný průřez → matchScore < 40 → NEZAHRNUJ.
- Počet žil (3x, 5x, 4x...) MUSÍ přesně odpovídat. Odlišný počet žil → matchScore < 40 → NEZAHRNUJ.
- Výjimka: Pokud poptávka průřez neuvádí (např. jen "kabel CYKY-J") → průřez nezahrnuj do hodnocení.

Příklady:
- Poptávka "NSGAFOU 1x95" → kandidát "NSGAFOU 1x240" → matchScore: 30 (NEZAHRNOVAT)
- Poptávka "CYKY-J 4x10" → kandidát "CYKY-J 4x70" → matchScore: 30 (NEZAHRNOVAT)
- Poptávka "CYKY-J 4x10" → kandidát "CYKY-J 4x10 BUBEN" → matchScore: 95 (OK)
```

**Dopad:** Eliminuje nejnebezpečnější typ chyby — záměnu průřezu u silových kabelů.

---

## P4: Packaging délka datových kabelů

### Problém
- `kabel datový U/UTP kat.6` → expected cívka `500M`, selected cívka `305M` (matchType: match, conf 97 %)

Pro silové kabely existuje logika KRUH vs BUBEN, pro datové kabely neexistuje žádná logika délky cívky. SELECTOR vybere první dostupný buben bez ohledu na délku.

### Příčina
Délka cívky datového kabelu není kritická pro typ nebo parametry (305M vs 500M je stejný kabel), ale pro nabídkový proces — 305M cívka může nestačit pro 400M zakázky.

### Řešení — SELECTOR prompt, pravidlo pro datové kabely

Přidat do SELECTOR promptu:

```
## Datové kabely — délka cívky

Pokud demand.unit = "m" a shortlist obsahuje cívky různých délek (305M, 500M apod.):
- Preferuj cívku, jejíž délka je ≥ demand.quantity (zákazník dostane celou zakázku z jedné cívky)
- Pokud žádná cívka délkou nepokryje celou zakázku → vyber nejdelší dostupnou a v reasoning uveď počet cívek
- Platí pro kabely bez KRUH varianty (typicky datové, koaxiální, sdělovací)
```

**Poznámka:** Toto je méně kritické než P1–P3 (1–2 případy v evaluaci).

---

## P5: Katalogové mezery — dokumentace

### Identifikované katalogové mezery (nelze opravit promptem)

Celkem **~25 položek not_found** pravděpodobně kvůli absenci v katalogu nebo jiné konvenci pojmenování:

| Skupina | Počet | Poznámka |
|---|---|---|
| `Datový kabel UTP CAT6 LSOH` (3× stejná) | 3 | Pravděpodobně není v katalogu SKU 1132208 |
| `CXKH-R-J` průřezy 5×95, 5×50, 5×16, 5×10, 5×4, 5×1,5, 3×1,5 | 7 | Chybí v katalogu nebo jiné pojmenování |
| `1–CXKH–R` s prefixem `1–` | 7 | Prefix `1–` způsobuje neúspěšné embedding vyhledávání |
| `Kabelový drátěný žlab + lávka` (kompletní sety) | 4 | Kompletní sety nejspíš nejsou v katalogu jako celek |
| `H07V-K 120mm²` | 1 | Velký průřez, možná není skladem/v katalogu |
| Ostatní (LED pásek, koaxiální kabel, chránič typ B...) | 4+ | Specializované produkty |

### Oprava pro prefix `1–CXKH`

**Není technická oprava.** V katalogu s milionem produktů existují tisíce pojmenovacích konvencí. Přidávat do promptu instrukci pro každou specifickou konvenci by vedlo k přespecifikovanému promptu, který se rozsype na dalším neočekávaném formátu.

Navíc — analýza ukázala, že tyto produkty pravděpodobně **v katalogu vůbec nejsou** (katalogová mezera). Oprava reformulace by nepomohla, protože DB záznam chybí.

Řeší katalogový tým doplněním dat.

---

## Pořadí implementace (celkové)

### Fáze 1 — Prompt + payload změny (nízké riziko, vysoký dopad)

| Krok | Změna | Soubor | Dopad |
|---|---|---|---|
| 1a | `foundByExactCode` flag do MATCHER + SELECTOR payloadu (P0) | `searchPipeline.ts` | Exact match neprojde přes MATCHER |
| 1b | Pravidlo exact code priority do MATCHER promptu (P0) | `searchPipeline.ts` MATCHER_PROMPT | Exact match vždy v shortlistu |
| 1c | Pravidlo exact code do SELECTOR promptu (P0) | `searchPipeline.ts` SELECTOR_PROMPT | Exact match vždy vybrán |
| 1d | Rozšířený blok pro detekci varianty (P1) | `searchPipeline.ts` SELECTOR_PROMPT | ~30 špatných → "multiple" |
| 1e | Pravidlo průřez + póly + páry pro MATCHER (P3) | `searchPipeline.ts` MATCHER_PROMPT | 5+ bezpečnostně kritické |
| 1f | Varování "výrobce nenalezen" (P2 — základní) | `searchPipeline.ts` SELECTOR_PROMPT | 5 položek — lepší UX |

### Fáze 2 — Kódové změny backend (střední riziko)

| Krok | Změna | Soubor | Dopad |
|---|---|---|---|
| 2a | Candidates cap pro "multiple" (viz předchozí dok.) | `searchPipeline.ts` | Korektní picker |
| 2b | Předání `groupContext` do `createSearchPlan` — dvouprůchodové hledání s výrobcem (P2 Úroveň 2) | `searchPipeline.ts` | 5+ špatných |

### Fáze 3 — Frontend (samostatná PR)

| Krok | Změna | Soubor | Dopad |
|---|---|---|---|
| 3a | VariantPicker komponenta (viz předchozí dok.) | `ResultsTable.tsx` (nová komponenta) | UX pro "multiple" |
| 3b | uncertainCount zahrnuje "multiple" | `ResultsTable.tsx` | Badge count |

---

## Odhadovaný celkový dopad

| Stav | Exact match | Wrong | Not found |
|---|---|---|---|
| **Aktuální** | 18/142 (13 %) | 74/142 (52 %) | 50/142 (35 %) |
| Po Fázi 1 (prompty) | +30 "multiple" z wrong | −30 wrong → multiple | beze změny |
| Po Fázi 2 (kód) | +7 z not_found | −2–3 wrong | −7 not_found |
| Po Fázi 3 (frontend) | Uživatel dokončí výběr | — | — |

> **Pozn.:** "Multiple" není špatně ani správně — je to "čeká na uživatele". Evaluační skript to bude potřeba upravit, aby "multiple + expected sku v candidates" = správně.

---

## Co promptem nevyřešíme

1. **Katalogové mezery** (~25 not_found) — produkt fyzicky není v DB. Řeší katalogový tým.
2. **CXKH vs CXKE záměna** — zákazník napsal CXKH, správný produkt je CXKE (jiný standard). Bez dodatečného kontextu (číslo projektu, norma) AI nemůže rozlišit. Řeší uživatel/projektant.
3. **Generace produktu** (PL6 vs PL7 jistič, podobné modely) — bez specifikace generace/roku nelze určit. Řeší uživatel výběrem.
