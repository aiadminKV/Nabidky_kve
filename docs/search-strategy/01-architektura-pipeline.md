# Search Pipeline — architektura a stav

> Dokument popisuje jak funguje celý vyhledávací a výběrový pipeline k datu 1. 4. 2026.
> Navazuje na evaluaci 142 položek z `evaluace-final.csv` a Typesense PoC.

---

## 1. Tok jedné položky

```
Poptávka: "CYKY-J 3x2,5 100m"
│
├─ 1. Normalizace textu
│     Pouze character-level: × → x, em-dash → -, mm² → mm
│     Všechno doménové nechává LLM reformulaci.
│
├─ 2. Paralelně: Reformulace + Code Extractor
│     Reformulace (LLM):
│       "KABEL 1-CYKY-J 3x2,5 CYKY kabel instalační 3×2,5"
│       Dostane jméno produktu + instruction + groupContext (výrobce/řada)
│     Code Extractor (LLM):
│       Hledá kódy jako SKU, EAN, IDNLF v textu poptávky
│       Výsledky → extraExactLookup (prioritní)
│
├─ 3. Paralelní fan-out (všechny dotazy najednou)
│     ├─ Fulltext PG (originál) → search_products_v2_fulltext
│     ├─ Fulltext PG (reformulovaný) → search_products_v2_fulltext
│     ├─ Exact Lookup (celé jméno) → lookup_products_v2_exact
│     ├─ Exact Lookup (každý extrahovaný kód) → lookup_products_v2_exact
│     ├─ Embedding generace (originál) → text-embedding-3-small 256dim
│     └─ Embedding generace (reformulovaný) → text-embedding-3-small 256dim
│
├─ 4. Paralelně: Semantic search
│     ├─ Semantic (raw embedding) → search_products_v2_semantic top 50, threshold 0.35
│     ├─ Semantic (reformulated embedding) → search_products_v2_semantic top 50, threshold 0.35
│     └─ Semantic (manufacturer-boosted) → pokud je preferovaný výrobce/řada
│           query = "ABB Tango rámeček jednonásobný"
│
├─ 5. Merge
│     Všechny zdroje → MergedCandidate[] se source trackingem:
│       "raw" | "reformulated" | "fulltext" | "exact" | "both"
│     Exact match dostane cosine_similarity 0.97–1.0 (prioritizace nad semantic)
│     source: "exact" se zachová i po merge s jinými zdroji (fix mergeWithExisting)
│     Stock post-filter (pokud uživatel nastavil filtr skladu)
│
├─ 6. MATCHER (LLM gpt-5.4-mini, reasoning_effort: low)
│     Input: top 60 kandidátů z merge + demand (název, unit, quantity)
│     Výstup: shortlist max 8 kandidátů s matchScore
│     Logika:
│       - foundByExactCode = true → automaticky matchScore: 97
│       - Typ produktu musí sedět (jistič ≠ pojistka, CY ≠ CYA)
│       - Tvrdé parametry: průřez, póly, páry, třída odolnosti → nesedí → matchScore < 40
│       - Kabely v metrech: povoluje KRUH i BUBEN varianty, vyřazuje nesmyslné
│
├─ 7. Refinement loop (max 2×)
│     Pokud MATCHER nic nenašel → vygeneruje upřesněný dotaz → nové semantic search
│     Výsledky přidá do merge → MATCHER znovu
│
└─ 8. SELECTOR (LLM gpt-5.4-mini, reasoning_effort: low)
      Input: shortlist z MATCHER + ceny + sklad + demand + offerType + groupContext
      Výstup: selectedSku | null, matchType, confidence, reasoning, priceNote
      Pravidla (v pořadí priority):
        1. foundByExactCode = true → vždy vyber, confidence: 99
        2. Více variant v nespecifikovaném atributu → matchType: "multiple", selectedSku: null
        3. VÝBĚRKO → nejlevnější s matchScore ≥ 70
        4. REALIZACE → sklad > preferovaný výrobce (max 3× cena) > cena
        5. Kabely → KRUH vs BUBEN logika (dělitelnost množství)
```

---

## 2. Databázové funkce

### `search_products_v2_fulltext`
- Input: text dotaz
- Logika:
  1. `plainto_tsquery('cs_unaccent', ...)` → **AND sémantika** (musí matchovat všechny tokeny)
  2. Prefix tsquery: každé slovo → `slovo:*`, spojeno `&` → prefix AND
  3. Pokud ani jedno nespustí match → 0 výsledků (největší slabina)
  4. Ranking: `ts_rank_cd` + `similarity()` (pg_trgm trigram similarity)
  5. `cs_unaccent` custom text search config (bez diakritiky)
- **Nemá synonyma** → "rámeček jednonásobný" ≠ "JEDNORAMECEK"
- Výsledek: max 30 produktů

### `search_products_v2_semantic`
- Input: embedding vector (256 dim), threshold, max_results
- Logika: pgvector HNSW index, cosine similarity
- ef_search = 200 (1000 při stock filterech)
- Threshold: 0.35 (nízký záměrně — zachytit i vzdálené shody)
- Výsledek: max 50 produktů

### `lookup_products_v2_exact`
- Input: text (název nebo kód)
- Logika (priorita):
  1. `sku_exact` → přímá shoda SKU (cosine 1.0)
  2. `ean_exact` / `idnlf_exact` → přímá shoda v `product_identifiers_v2` (cosine 0.98)
  3. `idnlf_normalized` → shoda po odebrání mezer (cosine 0.97) — řeší ABB "5518-2929 S" vs "5518-2929S"
  4. `ean_contains` / `idnlf_contains` → ILIKE contains, min 6 znaků (cosine 0.90)
- Výsledek: max 10 produktů

### `products_v2` search_vector
- `setweight(to_tsvector('cs_unaccent', sku), 'A')` — nejvyšší váha
- `setweight(to_tsvector('cs_unaccent', name), 'A')` — nejvyšší váha
- `setweight(to_tsvector('cs_unaccent', search_hints), 'A')` — pole pro custom synonyma
- `setweight(to_tsvector('cs_unaccent', supplier_name), 'B')`
- `setweight(to_tsvector('cs_unaccent', category_*), 'C')`
- `setweight(to_tsvector('cs_unaccent', description), 'D')`

---

## 3. Modely a parametry

| Komponenta | Model | Reasoning |
|---|---|---|
| Reformulace | gpt-5.4-mini | low |
| Code Extractor | gpt-5.4-mini | low |
| Planning Agent | gpt-5.4-mini | low |
| MATCHER | gpt-5.4-mini | low |
| SELECTOR | gpt-5.4-mini | low |
| Set Decomposer | gpt-5.4-mini + web_search | low |
| Offer Agent (chat) | gpt-5.4 | low |
| Parser Agent | gpt-5.4-mini | — |
| Embeddings | text-embedding-3-small | 256 dim |

---

## 4. Evaluace — výsledky (142 položek)

### Metodika
- Dataset: `evaluace-final.csv` — 142 položek z reálné poptávky s expected SKU
- Cílové testy: `test-quality-eval.ts` — 21 cílených testů ve 4 sadách

### Recall retrieval (benchmark 25 dotazů)
Fulltext PG předčil Typesense v poměru **13/25 (52%) vs 3/25 (12%)**.
Hlavní důvod: Typesense nemá český stemmer ani technické tokenizátory.

### Cílené testy (21 testů, 4 sady)

| Suite | Problém | Výsledek | Stabilita |
|---|---|---|---|
| A — varianty | Nespecifikovaný atribut → "multiple" | 4–6/7 | Nestabilní (LLM) |
| B — parametry | MATCHER nesmí pustit špatný průřez/póly | 0/5 | Nefunguje |
| C — kódy/EAN | Exact match musí vyhrát nad LLM | 5/6 | Stabilní |
| D — výrobce | Preferovaný výrobce v candidates | 1/3 | Slabé |

**Celkem: 10/21 = 48%** (cíl byl 80%)

### Kořenové příčiny (seřazeny od nejdůležitějšího)

#### 1. Retrieval selhává — správný produkt se nedostane do candidates
Toto je **#1 problém**. Pokud správný produkt není v top 60 kandidátech, MATCHER/SELECTOR nemají šanci.

Konkrétní případy:
- "rámeček jednonásobný" → JEDNORAMECEK (ABB) — fulltext nenajde (žádná synonyma)
- "NSGAFOU 1x95mm²" → SKU 1524920 — vůbec se nedostane do top 50 sémanticky
- "ZONA čidlo" → SKU 1394321 — žádná formulace dotazu ho nesurfuje
- "JXFE-R 3×2×0,8" — datový kabel specifický typ, embeddingy ho neznají

#### 2. LLM non-determinismus
MATCHER a SELECTOR prompt pravidla fungují občas, ale ne konzistentně:
- Suite B (tvrdé parametry): MATCHER správně vyřadí špatný průřez v 2/5 bězích, ve 3/5 ne
- Suite A (varianty): SELECTOR vrátí "multiple" v 4–6/7 bězích

Příčina: deterministické operace (průřez sedí nebo nesedí) jsou prováděny LLM, který je probabilistický.

#### 3. Synonymie v katalogu
Katalog používá vlastní naming convention, která se liší od hovorového jazyka:
- "rámeček jednonásobný" → "JEDNORAMECEK"
- "kabel instalační" → "CYKY-J"
- "chránič" → "PFGM" (OEZ) nebo "FID" (Eaton) nebo jiné zkratky výrobce

Reformulace (LLM) pomáhá, ale nezná všechny konvence.

---

## 5. Implementované opravy (stav k 1. 4. 2026)

| Oprava | Soubor | Dopad | Stav |
|---|---|---|---|
| `foundByExactCode` flag → MATCHER + SELECTOR | `searchPipeline.ts` | P0: Exact match neprojde přes MATCHER | Hotovo |
| SELECTOR prompt — varianta bez specifikace | `searchPipeline.ts` | P1: matchType "multiple" místo arbitrárního výběru | Hotovo, nestabilní |
| MATCHER prompt — tvrdé parametry | `searchPipeline.ts` | P3: průřez/póly/páry nesedí → matchScore < 40 | Hotovo, nestabilní |
| `mergeWithExisting` — zachování source "exact" | `searchPipeline.ts` | P0: source "exact" se neztrácí po merge | Hotovo |
| `reformulate()` + groupContext | `searchPipeline.ts` | P2: reformulace bere v potaz výrobce/řadu | Hotovo |
| Manufacturer-boosted semantic search | `searchPipeline.ts` | P2: třetí parallel semantic s výrobcem v dotazu | Hotovo |
| `lookup_products_v2_exact` — idnlf_normalized | `post-v2-finish.sql` | P0: "5518-2929S" najde "5518-2929 S" | Hotovo |
| REFORM prompt — katalogová synonyma | `searchPipeline.ts` | P5: JEDNORAMECEK, ZASUVKA CLON. atd. | Hotovo |
| Set decomposition pipeline | `searchPipeline.ts` | Designové řady → komponenty přes web search | Hotovo |

---

## 6. Co promptem/kódem nelze vyřešit

1. **Katalogové mezery** (~25 not_found) — produkt fyzicky není v DB. Řeší katalogový tým.
2. **Synonymie v fulltextu** — fulltext bez synonymového slovníku nenajde JEDNORAMECEK pro "rámeček jednonásobný". Řeší search engine nebo PG synonyma.
3. **Deterministické parametrické filtrování** — průřez, póly, páry by se měly filtrovat databází, ne LLM. Řeší strukturovaná metadata.
4. **CXKH vs CXKE záměna** — zákazník napsal jiný standard, AI nemůže rozlišit bez projektového kontextu.

---

## 7. Relevantní soubory

| Soubor | Účel |
|---|---|
| `backend/src/services/searchPipeline.ts` | Celá pipeline logika, prompty, merge |
| `backend/src/services/search.ts` | DB volání (fulltext, semantic, exact) |
| `backend/src/services/embedding.ts` | Generování embeddings |
| `backend/src/services/agent/index.ts` | Offer Agent, Parser Agent, tools |
| `data-model/post-v2-finish.sql` | DB funkce (fulltext, semantic, exact lookup) |
| `backend/src/scripts/test-quality-eval.ts` | 21 cílených testů (4 sady) |
| `evaluace-final.csv` | 142 položek s expected SKU |
| `docs/implementace-pipeline-opravy.md` | Detail implementovaných oprav P0–P5 |
| `docs/implementace-variant-picker.md` | Frontend picker pro matchType "multiple" |
