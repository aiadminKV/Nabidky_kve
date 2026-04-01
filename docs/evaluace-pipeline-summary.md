# Evaluace search pipeline — shrnutí a rozhodovací body

> Stav k 1. 4. 2026. Navazuje na `implementace-pipeline-opravy.md` a `implementace-variant-picker.md`.

---

## 1. Co jsme udělali

### Testovací framework
Vytvořen `test-quality-eval.ts` — 21 cílených testů ve 4 sadách, každý ověřuje konkrétní problém identifikovaný z evaluace 142 položek (`evaluace-final.csv`).

| Suite | Co testuje | Problém |
|---|---|---|
| A (7 testů) | Varianta bez specifikace → `"multiple"` | P1 |
| B (5 testů) | MATCHER nesmí pustit špatné parametry | P3 |
| C (6 testů) | EAN/kódy → exact match musí vyhrát | P0 |
| D (3 testů) | Brand preference → preferovaný výrobce v candidates | P2 |

### Implementované změny v `searchPipeline.ts`

| Změna | Co dělá |
|---|---|
| `foundByExactCode` flag | Kandidáti z exact lookup dostanou příznak → MATCHER je automaticky zařadí (score 97) → SELECTOR je automaticky vybere (confidence 99) |
| SELECTOR prompt — varianta | Pokud shortlist obsahuje varianty lišící se v nespecifikovaném atributu → `matchType: "multiple"`, `selectedSku: null` |
| MATCHER prompt — tvrdé parametry | Průřez, póly, páry, třída odolnosti musí přesně sedět, jinak matchScore < 40 |
| `mergeWithExisting` fix | Pokud produkt přijde ze semantic i exact lookup, `source: "exact"` se zachová |
| `reformulate()` + groupContext | Reformulace dostane preferovaného výrobce/řadu → generuje přesnější dotaz |
| Manufacturer-boosted retrieval | Třetí paralelní sémantické hledání s výrobcem v dotazu |
| `exactLookupFound` fix | Sleduje i `extraExactResults` (kódy extrahované z textu), ne jen full-name lookup |
| REFORM prompt — synonyma | Přidána katalogová synonyma (JEDNORAMECEK = rámeček jednonásobný) |

---

## 2. Výsledky testů

### Progrese

| Run | Celkem | A | B | C | D |
|---|---|---|---|---|---|
| Baseline (před změnami) | **2/21 = 10%** | 1/7 | 0/5 | 1/6 | 0/3 |
| Po P0+P1+P2+P3 | 11/21 = 52% | 6/7 | 1/5 | 4/6 | 0/3 |
| Po mergeWithExisting fix | 10/21 = 48% | 4/7 | 0/5 | **5/6** | 1/3 |
| Poslední run | **10/21 = 48%** | 4/7 | 0/5 | **5/6** | 1/3 |

**Cíl 80% nesplněn.** Ale pozor — čísla kolísají kvůli LLM non-determinismu (Suite A 4–6/7 mezi runy).

### Co funguje stabilně
- **Suite C (EAN/kódy): 5/6** — `foundByExactCode` spolehlivě zachrání produkty nalezené přes kód
- **Eaton PL7 (Suite D)**: reformulace s řadou generuje "PL7-C2/1" → fulltext najde

### Co funguje nestabilně (LLM non-determinismus)
- **Suite A**: SELECTOR někdy vrátí `"multiple"` (správně), někdy `"match"` (špatně) — závisí na "náladě" modelu
- **Suite B**: MATCHER někdy vyřadí špatné parametry, jindy ne — prompt pravidla nedostatečná

### Co nefunguje vůbec (architekturální limity)
- **ABB rámeček (Suite D)**: DB název `"JEDNORAMECEK 3901A-B10 B"` — sémantické hledání ani fulltext ho nenajde pro dotaz "rámeček jednonásobný ABB". Problém synonymie v retrievalu.
- **ZONA čidlo (Suite D)**: SKU 1394321 se nedostane do top 20 sémantických výsledků pro žádnou formulaci dotazu.
- **NSGAFOU 1x95 (Suite B)**: Správný produkt (SKU 1524920) nenalezen retrievalem vůbec.

---

## 3. Kořenové příčiny

### 3.1 Retrieval je slabý článek
Biggest insight z celé evaluace: **většina problémů není v MATCHER/SELECTOR, ale v tom, že správný produkt se vůbec nedostane do candidates.**

Konkrétně:
- Sémantické hledání (embedding cosine similarity) má ~0.4 pro produkty s jiným názvoslovím → absolutní šum
- Fulltext (PostgreSQL ts_vector) nemá synonyma → "rámeček jednonásobný" ≠ "JEDNORAMECEK"
- Reformulace pomáhá, ale je omezená — nemůže znát všechna katalogová synonyma

### 3.2 LLM non-determinismus
MATCHER i SELECTOR prompt pravidla fungují *občas*, ale ne konzistentně:
- Tvrdé parametrové filtrování (průřez, póly) je deterministická operace → LLM na to není ideální
- Rozhodnutí "je barva specifikovaná?" závisí na kontextu → LLM to zvládá, ale ne na 100%

### 3.3 Zákazník říká: "klíčová slova na e-shopu fungují lépe"
E-shopové search enginy (Elasticsearch, Typesense, Algolia) mají:
- **Synonyma** (JEDNORAMECEK = rámeček) — řeší náš #1 problém
- **Stemming** (jistič = jističe)
- **Fuzzy matching** (tolerance překlepů)
- **Boostování** (popularita, dostupnost)

Náš pipeline tyto věci nemá. Sémantické hledání je silné pro konceptuální dotazy, ale pro technické produkty s přesnými názvy je fulltext s dobrým tokenizací a synonymy mnohdy lepší.

---

## 4. Rozhodovací body — co dál

### Varianta A: Optimalizovat současný pipeline (prompt-only)
- **Pro:** Žádná nová infrastruktura, rychlé iterace
- **Proti:** LLM non-determinismus nelze eliminovat, retrieval limity zůstanou
- **Reálný strop:** ~60–65% na našem testu
- **Úsilí:** Nízké

### Varianta B: Přidat search engine (Elasticsearch / Typesense)
- **Pro:** Synonyma, stemming, fuzzy matching, boostování — řeší retrieval z gruntu. Zákazník potvrzuje, že klíčová slova fungují.
- **Proti:** Nová infrastruktura, indexace 471K produktů, synchronizace s Supabase, náklady
- **Reálný strop:** 80%+ na retrievalu, LLM pak jen validuje
- **Úsilí:** Střední (Typesense je jednodušší, Elasticsearch je mocnější)

**Architektura s search enginem:**
```
Poptávka → Reformulace (LLM)
  → Search engine (klíčová slova + synonyma + fuzzy)  ← NOVÉ
  → Sémantické hledání (embedding)                    ← zachovat pro vágní dotazy
  → Exact lookup (SKU/EAN)                             ← zachovat
→ Merge → MATCHER (LLM — jen typová validace, ne parametry) → SELECTOR (LLM)
```

### Varianta C: Strukturovaná metadata + parametrické filtrování
- **Pro:** Deterministické filtrování parametrů (průřez, póly) bez LLM
- **Proti:** Vyžaduje kvalitní strukturovaná data (extrakce z názvů 471K produktů), údržba
- **Reálný strop:** Suite B → 100% (parametry se filtrují databází)
- **Úsilí:** Vysoké (parsování + indexace + validace dat)

### Varianta D: Kombinace B + C
- Search engine pro retrieval + strukturované parametry pro filtrování
- LLM MATCHER redukován na sémantické posouzení "je to vůbec tento typ?"
- SELECTOR se soustředí jen na obchodní rozhodnutí
- **Reálný strop:** 85–90%+
- **Úsilí:** Vysoké, ale nejrobustnější

---

## 5. Doporučení

### Krátkodobě (dny)
1. **Stabilizovat co funguje** — Suite C (5/6) je téměř hotovo, commitnout
2. **Zvýšit `reasoning_effort`** pro SELECTOR na `"medium"` — může pomoci s konzistencí Suite A (test)
3. **Opravit test pro ABB 5518-2929S** — vrací `"multiple"` protože existují varianty (B, S, M) — to je technicky správné chování

### Střednědobě (týdny)
4. **Proof of concept: Typesense** — naindexovat 471K produktů, porovnat retrieval kvalitu s aktuálním pipeline na stejných 21 testech
5. **Synonyma do fulltextu** — pokud ne search engine, alespoň PostgreSQL synonym dictionary pro ts_vector

### Dlouhodobě
6. **Strukturovaná metadata** — extrahovat parametry (průřez, póly, proud) do dedikovaných sloupců → deterministické filtrování

---

## 6. Soubory a skripty

| Soubor | Účel |
|---|---|
| `backend/src/scripts/test-quality-eval.ts` | Hlavní evaluační skript — 21 testů, 4 sady |
| `backend/src/scripts/debug-code-extractor.ts` | Debug `extractProductCodes` |
| `backend/src/scripts/debug-exact-lookup.ts` | Debug `lookupProductsExact` proti DB |
| `backend/src/scripts/debug-brand-retrieval.ts` | Debug sémantického hledání pro výrobce |
| `backend/src/scripts/debug-brand-sku.ts` | Debug fulltext + SKU lookup |
| `backend/src/scripts/debug-matcher-params.ts` | Debug MATCHER pro Suite B |
| `backend/src/services/searchPipeline.ts` | Pipeline — všechny prompt + kódové změny |
| `evaluace-final.csv` | 142 položek z reálné poptávky s expected SKU |
