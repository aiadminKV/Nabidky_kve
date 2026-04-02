# Architektura vyhledávání produktů – KV Offer Manager

> **Verze:** 2.0 | **Datum:** 10. 3. 2026 | **Status:** Schváleno (interní)
>
> Tento dokument nahrazuje sekci 4.3 (Vyhledávací jádro) v `projektove-zadani-V4.md`.
> Vychází z reálných A/B testů provedených nad kompletní databází 471 237 produktů.

---

## 1. Východiska a zjištění z testování

### 1.1 Infrastruktura embeddings

| Parametr | Hodnota |
|---|---|
| Model | `text-embedding-3-small` |
| Dimenze | 256 (Matryoshka) |
| Tabulka | `product_embeddings` (offloaded, 100% pokrytí — 471 237/471 237) |
| Index | HNSW (`m=24, ef_construction=200, ef_search=200`) — **nutno vytvořit** |
| RPC | `search_product_embeddings_semantic` (join přes SKU na `products`) |
| Průměrná latence (bez indexu) | ~100ms per query (sequential scan) |
| Očekávaná latence (s HNSW) | ~1-5ms per query |

### 1.2 Zjištění z reálných testů

**Test 1 — Raw queries (30 položek z reálné poptávky):**
- 100% queries vrátilo výsledky
- ~60-70% queries správný produkt na 1. místě (kabely, zásuvky, svorky — similarity 80%+)
- ~30-40% queries špatné výsledky (zkratky, žargon — "B1x16", "Vodič CY 4", "Vypínač řazení 6")

**Test 2 — A/B test: raw vs reformulované dotazy (13 párů):**
- Reformulace vyhrála 9:4
- U problematických dotazů zlepšení **+9 až +15 procentních bodů** similarity
- U již dobrých dotazů reformulace občas **zhoršila** výsledky (-1.8 až -9.7pp)
- Příčina zhoršení: přidání zbytečného kontextu k jasnému dotazu rozplizne embedding

**Test 3 — Dual search (raw + reformulovaný, merge obou sad):**
- MERGED vždy vybere lepší z obou sad → **žádný downside**
- U 5 z 12 problematických dotazů správný produkt **není v raw top 30 vůbec** — samotné zvýšení počtu výsledků nestačí
- Overlap mezi raw a reformulovanými výsledky je ~0-15 SKU z 30 → merge efektivně zdvojnásobí coverage
- Cena: 2× batch embedding call (~200ms celkem) — zanedbatelné

### 1.3 Klíčové závěry

1. **Fulltext search je pro AI-driven hledání nedostatečný** — závisí na přesné formulaci klíčových slov, AI musí hádat katalogovou nomenklaturu
2. **Sémantický search funguje**, ale raw dotazy nestačí pro zkratky a odborný žargon
3. **Dual search (raw + reformulovaný) je optimální** — zachytí oba typy dotazů bez rizika zhoršení
4. **AI reformulace — vždy reformulovat, dual search vyřeší riziko** — není potřeba rozhodovat "měnit/neměnit", merge automaticky vybere lepší výsledek
5. **Fulltext zůstává pouze pro manuální vyhledávání** v review modalu (uživatel píše do search boxu)

---

## 2. Architektura vyhledávání — přehled

### 2.1 Dva kontexty vyhledávání

```
┌─────────────────────────────────────────────────────────────────────┐
│  Kontext A: Batch search (zpracování poptávky)                     │
│  → Semantic-first, dual search, AI evaluace                        │
│  → Optimalizováno pro throughput a přesnost                        │
│  → Detailně popsáno v sekci 3                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Kontext B: Interaktivní search (chat, review modal)               │
│  → Fulltext pro rychlé manuální hledání (user types in search box) │
│  → Semantic pro chat dotazy orchestrátora                          │
│  → Detailně popsáno v sekci 5                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Princip: AI jako hodnotitel, ne jako vyhledávač

**Předchozí přístup (fulltext-first):**
```
AI musí → formulovat klíčová slova → hádat formát katalogu → iterativně zkoušet
```

**Nový přístup (semantic-first):**
```
DB najde sémanticky podobné produkty → AI pouze vyhodnotí CO se našlo
```

AI se soustředí na to v čem je silná — porozumění kontextu a rozhodování.
DB dělá to v čem je silná — vektorové porovnávání.

---

## 3. Batch search flow (Kontext A)

### 3.1 Architektura: per-item paralelní pipeline

Každá položka z poptávky prochází **samostatným, nezávislým pipeline** — všechny
běží paralelně (až `CONCURRENCY = 30` najednou). Výsledky se streamují na
frontend přes SSE, jak jsou jednotlivé pipeline dokončeny.

```
┌──────────────────────────────────────────────────────────────────────┐
│  VSTUP: N parsovaných položek (název + množství)                     │
│  Např.: ["Jistič B1x16", "Kabel CYKY 3x1,5", "Vodič CY 10"]       │
└───────────────────────┬──────────────────────────────────────────────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
    ┌────▼────┐    ┌────▼────┐    ┌────▼────┐
    │ Item 1  │    │ Item 2  │    │ Item N  │    ← N paralelních pipeline
    │ pipeline│    │ pipeline│    │ pipeline│
    └────┬────┘    └────┬────┘    └────┬────┘
         │              │              │
         ▼              ▼              ▼           ← SSE stream per item
    ┌─────────────────────────────────────────┐
    │              VÝSTUP                      │
    │  {sku, confidence, matchType, candidates}│
    └──────────────────────────────────────────┘
```

**Jeden item pipeline (sekvenční kroky, běží nezávisle):**

```
Item "Jistič B1x16"
  │
  ├── KROK 1: LLM Reformulace      ~300ms (1 LLM call, 1 položka)
  │     → "Jednopólový jistič charakteristiky B 16A"
  │
  ├── KROK 2: Dual embedding        ~100ms (2 paralelní API calls)
  │     → raw embedding + reformulated embedding
  │
  ├── KROK 3: Dual semantic search   ~5ms (2 paralelní DB queries, HNSW)
  │     → 30 výsledků raw + 30 výsledků reformulated
  │
  ├── KROK 4: Merge                  ~1ms (in-memory)
  │     → ~40-60 unikátních kandidátů (deduplikace po SKU)
  │
  ├── KROK 5: AI Evaluace + Scoring  ~300ms (1 LLM call)
  │     → matchType, confidence, selectedSku
  │
  └── KROK 6: Refinement (pokud confidence < 60)  ~500ms
        → nový search s filtrem, opakovaná evaluace
```

**Proč per-item, ne batch?**

1. **Streaming UX** — výsledky se zobrazují jeden po druhém, uživatel vidí
   progress okamžitě
2. **Error izolace** — selhání jedné položky (timeout LLM, špatná reformulace)
   neovlivní ostatní
3. **Jednoduchost** — každá položka je nezávislá, žádná koordinace mezi nimi
4. **Odpovídá aktuální architektuře** — `CONCURRENCY = 30` v `agent.ts`

**Latence per item (odhad s HNSW):**
- Krok 1: ~300ms
- Krok 2: ~100ms
- Krok 3: ~5ms
- Krok 4: ~1ms
- Krok 5: ~300ms
- Krok 6: ~500ms (jen ~20-30% položek)
- **Per item: ~700ms (bez refinement), ~1.2s (s refinement)**
- **Celkem pro 30 položek: ~1-1.5s** (paralelně, bottleneck = nejpomalejší item)

### 3.2 Krok 1 — LLM Reformulace (per-item)

**Účel:** Rozvinout elektrotechnické zkratky a žargon do přirozeného jazyka
pro lepší embedding. Provádí se v **jednom LLM callu per položku**.

**Klíčový princip: VŽDY reformulovat, nikdy nerozhodovat "měnit/neměnit".**

Dual search řeší riziko automaticky — raw embedding zachytí dotazy, které
jsou v originále lepší, reformulovaný embedding zachytí ty, kde rozvinutí
pomůže. Merge vždy vybere vítěze. AI se nemusí rozhodovat, jestli je
dotaz "dostatečně jasný" — to je zbytečná zodpovědnost, která vede k bias.

**Prompt (systémový):**
```
Přeformuluj název elektrotechnického produktu do nejpopisnější možné formy
pro sémantické vyhledávání v českém B2B katalogu elektroinstalačního
materiálu.

PRAVIDLA:
1. VŽDY přeformuluj — rozviň zkratky, přidej odborný kontext
2. Pokud zkratce NEROZUMÍŠ, ponech originální text — NIKDY nevymýšlej
3. Zachovej specifické kódy výrobce, SKU, EAN beze změny (přidej kontext vedle)

Vrať plain text — jen přeformulovaný název.
```

**Vstup (user message):** Jeden originální název
**Výstup:** Přeformulovaný název (plain text)

> **Proč žádné příklady v promptu?** Příklady vytvářejí statický bias —
> AI se naučí rozvinout jen ty vzory, které vidí v příkladech.
> Obecná instrukce "rozviň do nejpopisnější formy" je škálovatelnější.
> Pokud se ukáže, že AI reformuluje špatně, příklady se přidají
> cíleně na základě dat z feedback loopu.

### 3.3 Krok 2-4 — Dual Embedding + Merge (per-item)

```typescript
async function searchPipelineForItem(item: ParsedItem) {
  // Krok 1: Reformulace
  const reformulated = await reformulateQuery(item.name);

  // Krok 2: Paralelní embedding (raw + reformulated)
  const [rawEmb, refEmb] = await Promise.all([
    openai.embeddings.create({ model, dimensions: 256, input: item.name }),
    openai.embeddings.create({ model, dimensions: 256, input: reformulated }),
  ]);

  // Krok 3: Paralelní semantic search
  const [rawResults, refResults] = await Promise.all([
    supabase.rpc("search_product_embeddings_semantic", {
      query_embedding: rawEmb.data[0].embedding,
      max_results: 30,
      similarity_threshold: 0.35,
    }),
    supabase.rpc("search_product_embeddings_semantic", {
      query_embedding: refEmb.data[0].embedding,
      max_results: 30,
      similarity_threshold: 0.35,
    }),
  ]);

  // Krok 4: Merge — union po SKU, best similarity wins
  const merged = mergeResults(rawResults.data, refResults.data);
  // merged: ~40-60 unikátních kandidátů, seřazeno podle similarity DESC

  // Krok 5-6: Evaluace + případný refinement
  return await evaluateAndRefine(item, merged);
}

// Spuštění N pipeline paralelně (CONCURRENCY = 30)
const results = await pMap(items, searchPipelineForItem, { concurrency: 30 });
```

### 3.4 Krok 5 — AI Evaluace (per-item)

AI dostane merged výsledky **pro jednu položku** a rozhodne:

**Vstup pro AI:**
```json
{
  "originalName": "Jistič B1x16",
  "candidates": [
    {"sku": "1168252", "name": "JISTIC HAGER 16/1/B MBN116", "similarity": 0.691,
     "manufacturer": "Hager", "subcategory": "Modulové přístroje", ...},
    {"sku": "1527581", "name": "JISTIC 1P 80A,CHAR. D,15KA", "similarity": 0.674, ...}
  ]
}
```

**AI hodnotí:**
1. Odpovídá subcategorie produktu očekávání?
2. Odpovídají technické parametry (proud, póly, napětí, IP)?
3. Je to přesný produkt nebo alternativa?

**Výstup AI:**
```json
{
  "matchType": "match|uncertain|alternative|not_found",
  "confidence": 0-100,
  "selectedSku": "1168252",
  "candidates": ["1168252", "1527581"],
  "reasoning": "Jistič 16/1/B odpovídá B1x16 — 1-pólový, 16A, char B."
}
```

### 3.5 Krok 5+6 — AI Evaluace s kontextem a Refinement (per-item)

#### Metadata ve výsledcích

Merge krok obohacuje výsledky o metadata, které AI potřebuje k rozhodování
a případnému refinementu:

```json
{
  "originalName": "Jistič B1x16",
  "totalCandidates": 52,
  "topSimilarity": 0.691,
  "sim10th": 0.612,
  "sim30th": 0.543,
  "subcategoryDistribution": {
    "Modulové přístroje": 20,
    "Výkonové jističe a stykače": 6,
    "Kabelový spojovací materiál": 4
  },
  "manufacturerDistribution": {
    "Hager": 15,
    "EATON": 10,
    "OEZ": 5
  },
  "candidates": [...]
}
```

AI se tím **učí z dat** — nemusí vědět předem jaké subcategorie existují,
vidí je přímo ve výsledcích a rozhoduje se na základě distribuce.

> **Poznámka:** `subcategoryDistribution` sloučí duplicity z "Obchodní zboží"
> meta-kategorie — `category = "Modulové přístroje"` a
> `category = "Obchodní zboží", subcategory = "Modulové přístroje"` se
> oba počítají pod klíč `"Modulové přístroje"`.

#### Katalogová struktura a filtrování

Katalog má tříúrovňovou hierarchii: `category > subcategory > sub_subcategory`.

**Klíčový problém: top-level `category` je nespolehlivá.**

1. Mnoho top-level kategorií je garbage — čísla (`"8,24"`), názvy výrobců
   (`"LEDVANCE"`, `"EATON"`), nebo nesmyslné hodnoty (~5K položek).
2. "Obchodní zboží" (118K položek) je meta-kategorie — její subcategorie
   zrcadlí jiné top-level kategorie:
   ```
   category = "Modulové přístroje":                     7 919 položek
   category = "Obchodní zboží", subcategory = "Modulové přístroje": 29 603 položek
   ```

**Řešení: filtrovat primárně přes `subcategory`** (případně `sub_subcategory`).
Top-level `category` ignorovat jako nespolehlivou. RPC filtr hledá ve všech
úrovních hierarchie, ale AI pracuje se subcategoriemi:

```sql
WHERE (
  category_filter IS NULL
  OR p.category = category_filter
  OR p.subcategory = category_filter
  OR p.sub_subcategory = category_filter
)
```

#### Refinement flow (per-item)

Pro položky kde AI v evaluaci určí `confidence < 60` nebo `matchType: "not_found"`:

AI rozhodne na základě toho CO VIDĚLA ve výsledcích — ne na základě
hardcoded znalostí:

```
AI vidí výsledky pro "Vypínač IP44 řazení 1":
  subcategoryDistribution: { "Rozvaděče a rozvodnice": 18, "Modulové přístroje": 5, ... }
  → "Většina výsledků jsou rozvaděče, ale hledám domovní vypínač."
  → Akce: nový search s filtrem subcategory = "Domovní spínače a zásuvky"
```

```json
{
  "action": "refine_search",
  "query": "jednopólový vypínač IP44 řazení 1",
  "subcategory": "Domovní spínače a zásuvky",
  "manufacturer": null,
  "reasoning": "Výsledky dominovaly rozvaděče. Zúžení na domovní spínače."
}
```

AI může při refinementu volat `get_category_tree` — strom kategorií se
načte z cache (~1ms) a pomůže AI vybrat správnou subcategorii pro filtr.
Toto je "safety net" pro edge cases, ne běžný krok.

**Maximálně 2 refinement pokusy per položku.** Pokud ani po refinementu
confidence nestačí → `not_found`, uživatel řeší ručně.

---

## 4. Architektura agentů

### 4.1 Dva režimy, společná infrastruktura

Systém má dva odlišné režimy práce s různými nároky na orchestraci:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  REŽIM A: Batch processing (zpracování poptávky)                        │
│                                                                         │
│  Tok: Vstup → Parser → N × Search Pipeline (paralelně) → Review        │
│                                                                         │
│  Orchestrace: DETERMINISTICKÝ KÓD (ne agent)                            │
│  Každá položka = nezávislý pipeline (kroky 1-6).                        │
│  Žádný agent s "vlastní vůlí".                                          │
│                                                                         │
│  Důvod: Předvídatelnost, testovatelnost, streaming UX.                  │
│  30 položek = 30× stejný pipeline, paralelně, výsledky streamovány.     │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  REŽIM B: Interaktivní chat (orchestrátor + sub-agenti)                 │
│                                                                         │
│  Tok: Uživatel ↔ Orchestrátor → delegace na Search sub-agenta           │
│                              → akce na nabídce (add/replace/remove)     │
│                                                                         │
│  Orchestrace: LLM AGENT s tools + delegace                              │
│  Orchestrátor rozumí kontextu, deleguje search, provádí akce.           │
│                                                                         │
│  Důvod: Uživatel mluví přirozeným jazykem, záměr je nepředvídatelný.   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Search Pipeline (Režim A) — deterministický kód

Search pipeline **není LLM agent** — je to deterministický kód s LLM voláními
ve specifických krocích. Každá položka prochází identickým pipeline nezávisle.

```
Search Pipeline (per-item) = kód, který:
  1. Volá LLM pro reformulaci (1 call, 1 položka)
  2. Volá OpenAI Embeddings API (2 paralelní calls: raw + reformulated)
  3. Volá Supabase RPC (2 paralelní searches)
  4. Merguje výsledky (deterministický kód)
  5. Volá LLM pro evaluaci (1 call, 1 položka)
  6. Podmíněně opakuje search s filtry (LLM rozhodne, kód provede)
```

Výhoda oproti plně agentnímu přístupu: **předvídatelnost, testovatelnost,
konzistentní výsledky**. Agent má tendenci dělat neočekávané věci pod tlakem.
Pipeline vždy udělá totéž.

### 4.3 Orchestrátor (Režim B) — LLM agent s delegací

Orchestrátor je LLM agent, který řídí interaktivní konverzaci s uživatelem
po zpracování poptávky (review fáze) nebo pro ad-hoc dotazy.

**Klíčový rozdíl oproti Režimu A:** Orchestrátor **deleguje vyhledávání na
Search sub-agenta** — sám nehledá. Search sub-agent provede kompletní
search pipeline (reformulace → embedding → search → evaluace) a vrátí
hotový výsledek.

```
┌──────────────────────────────────────────────────────────────────────┐
│                     ORCHESTRÁTOR                                      │
│  Model: gpt-5-mini (low reasoning)                                    │
│                                                                       │
│  Domain kontext (broad):                                              │
│  "Jsi asistent pro B2B distributora elektroinstalačního materiálu.    │
│   Katalog ~470K položek: svítidla, jističe, kabely, zásuvky..."      │
│                                                                       │
│  Zodpovědnosti:                                                       │
│  1. Porozumět záměru uživatele                                       │
│  2. Delegovat search na sub-agenta                                   │
│  3. Provést akci na nabídce (add/replace/remove)                     │
│  4. Komunikovat výsledky zpět uživateli                              │
└──────┬────────────────┬────────────────┬────────────────┬────────────┘
       │                │                │                │
 ┌─────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐  ┌─────▼──────┐
 │ search_    │  │ add_item    │  │ replace_   │  │ remove_    │
 │ product    │  │ _to_offer  │  │ product    │  │ item       │
 │            │  │             │  │            │  │            │
 │ Deleguje   │  │ Přidá do    │  │ Zamění     │  │ Odebere    │
 │ na Search  │  │ nabídky     │  │ produkt    │  │ z nabídky  │
 │ sub-agenta │  │             │  │            │  │            │
 └────────────┘  └─────────────┘  └────────────┘  └────────────┘
                                                        │
                                                  ┌─────▼──────┐
                                                  │ get_       │
                                                  │ category_  │
                                                  │ tree       │
                                                  │            │
                                                  │ On-demand  │
                                                  │ strom kat. │
                                                  └────────────┘
```

#### Search sub-agent

Search sub-agent je specializovaný agent/pipeline, který:

1. Dostane úkol od orchestrátora ("najdi alternativu k jističi Hager 16A")
2. Sám provede kompletní search pipeline (reformulace → embedding → dual search
   → merge → evaluace)
3. Vrátí hotový výsledek zpět orchestrátorovi (nejlepší match + kandidáti + reasoning)

Orchestrátor **může delegovat více search úkolů paralelně** — např. "najdi
alternativy od 3 různých výrobců" = 3 paralelní search sub-agent calls.

#### Kdy orchestrátor zasahuje

| Situace | Co orchestrátor dělá |
|---|---|
| "Najdi alternativu k položce 5 od ABB" | Deleguje na search sub-agenta s manufacturer filtrem |
| "Přidej 3 jističe B16 od různých výrobců" | Deleguje search, z výsledků vybere 3 různé výrobce, přidá |
| "Odstraň položky 7-10" | Volá remove_item 4× |
| "Co je tohle za produkt?" | Odpovídá z kontextu nabídky, nemusí hledat |
| "Proč agent vybral tento produkt?" | Odpovídá z reasoning pole v datech |

#### Kdy orchestrátor NEZASAHUJE

| Situace | Co se děje místo toho |
|---|---|
| Batch processing poptávky | Search Pipeline (Režim A) — deterministický kód |
| Manuální fulltext hledání v modalu | Přímý API call (`/agent/product-search`) |
| Parsování vstupního textu | Parser Agent (deterministický LLM call) |

#### Domain kontext orchestrátora

Orchestrátor MÁ domain kontext, ale **široký a obecný**:

**MÁ:**
- "Jsi asistent pro B2B distributora elektroinstalačního materiálu"
- "Katalog obsahuje ~470K položek v kategoriích jako svítidla, jističe, kabely..."
- Obecné principy elektrotechniky (co je jistič, co je kabel, co je IP krytí)
- Přístup k dynamickému stromu kategorií přes tool `get_category_tree`

**NEMÁ:**
- Hardcoded seznam kategorií s počty
- Specifické mapování zkratek (B3x16 = ...)
- Rigidní pravidla vyhledávání
- Statický kontext, který by se musel měnit s ceníkem

#### Principy orchestrátora

1. **Delegace, ne přímé hledání** — orchestrátor se soustředí na strategii
   a komunikaci, search sub-agent na hledání. Tím je orchestrátor rychlejší
   a přehlednější.

2. **Broad domain context** — orchestrátor má obecné povědomí o oboru, ale
   neobsahuje specifické detaily, které by mohly zastarávat.

3. **Akční autonomie** — orchestrátor sám rozhodne a provede akci.
   Neptá se uživatele "Chceš tento produkt?" — vybere nejlepší a přiřadí.
   Uživatel pak zkontroluje v review tabulce.

4. **Transparentnost** — po každé akci stručně vysvětlí co udělal a proč.

---

## 5. Kontext B — Interaktivní vyhledávání

### 5.1 Chat dotazy (orchestrátor → search sub-agent)

Když uživatel napíše dotaz v chatu (např. "Najdi mi alternativu k jističi Hager"),
orchestrátor **deleguje na search sub-agenta**, který provede kompletní search
pipeline (reformulace → dual embedding → dual search → merge → evaluace)
a vrátí hotový výsledek. Orchestrátor pak provede akci na nabídce a komunikuje
výsledek uživateli.

### 5.2 Manuální search v review modalu — jen fulltext

Fulltext search (`search_products_fulltext` RPC) je **jediný typ vyhledávání**
v review modalu, kde uživatel píše do search boxu. Semantic search se zde
nepoužívá.

Důvody:
- **Instant výsledky** — žádná LLM latence, as-you-type experience
- **Přesné textové shody** — uživatel obvykle zná kód produktu nebo jeho přesný název
- **Jednoduchost** — přímý API call bez pipeline, embedding, nebo merge logiky

---

## 6. Confidence scoring

### 6.1 Třístupňová škála

AI hodnotí confidence **kontextově**, ne jen na základě similarity score.
Similarity 82% u kabelu = jistá shoda, ale 82% u zásuvky = může být špatný typ.

| Confidence | matchType | UX indikátor | Akce uživatele |
|---|---|---|---|
| **85-100** | `match` | ✅ Zelená | Bez nutnosti kontroly |
| **60-84** | `uncertain` / `multiple` | 🟡 Žlutá | Doporučená kontrola |
| **30-59** | `alternative` | 🟠 Oranžová | Vyžaduje potvrzení |
| **0-29** | `not_found` | 🔴 Červená | Vyžaduje ruční řešení |

### 6.2 Co AI zohledňuje při hodnocení

1. **Subcategorie** — odpovídá nalezený produkt očekávané subcategorii?
2. **Technické parametry** — proud, napětí, póly, IP krytí
3. **Přesnost vs alternativa** — je to přesný produkt nebo náhrada?
4. **Similarity distribuce** — velký rozdíl mezi #1 a #2 = vyšší confidence

---

## 7. Principy škálovatelnosti a prevence bias

### 7.1 Broad domain context, ne hardcoded znalosti

**Špatně:**
```
prompt: "Kategorie: Svítidla (91K), Výkonové jističe (32K)..."
prompt: "B3x16 = 3-pólový jistič, char B, 16A"
```

**Správně:**
- Orchestrátor má **široký, obecný** domain kontext ("B2B distributor elektroinstalace")
- Agent se učí z dat — vidí subcategorie a výrobce ve výsledcích vyhledávání
- Reformulační prompt má obecná pravidla, ne specifické mapování
- Strom kategorií je **dynamicky načítaný** z DB s cachováním (TTL 1h) —
  ne staticky v promptu, ne jen při deployi (viz sekce 8.4)
- Pokud se kategorie změní nebo přibude nový typ produktu, systém se adaptuje
  automaticky při příští invalidaci cache

### 7.2 Reformulace: vždy reformulovat, dual search řeší riziko

Testování ukázalo, že reformulace někdy zhoršuje výsledky:
- `"Svorka WAGO"` → `"Pružinová svorka WAGO pro spojování vodičů"` = **-1.8pp**
- `"Zásuvka 400V 16A IP44"` → `"Průmyslová zásuvka 400V 16A IP44 pětipólová"` = **-9.7pp**

**Řešení: nehádej co je "dostatečně jasné" — reformuluj vždy a nech
dual search merge vybrat lepší výsledek.** AI se nemusí rozhodovat
jestli je dotaz "jednoznačný" — to je zodpovědnost, která vede k bias
a vyžaduje příklady co je/není jednoznačné. Dual search to řeší automaticky.

### 7.3 Graceful degradation

AI musí vědět, že "nevím" je validní odpověď:
- `confidence: 0, matchType: "not_found"` je lepší než falešně vysoká confidence
- Uživatel vždy vidí kandidáty a může vybrat ručně

### 7.4 Transparentnost

Uživatel vidí PROČ AI vybralo daný produkt:
- `reasoning: "Jistič 16/1/B odpovídá B1x16 — 1-pólový, 16A, char B"`
- Similarity score a kategorie jsou viditelné v debug panelu

### 7.5 Feedback loop (budoucí rozšíření — vyžaduje diskusi s uživateli)

Koncept: Když uživatel opraví AI výběr v review modalu → uložení páru
`(query → správný SKU)` pro budoucí vyhodnocení kvality a případné
zlepšení reformulačního promptu.

**Status: FUTURE WORK.** Před implementací je nutné probrat s koncovými
uživateli, jak a zda budou opravy dělat, aby se systém nestočil špatným směrem.

---

## 8. Databázová vrstva — požadované změny

### 8.1 HNSW index na product_embeddings (BLOKUJÍCÍ)

```sql
-- Spustit v Supabase Dashboard SQL Editor s navýšeným timeout:
SET statement_timeout = '600s';

CREATE INDEX idx_product_embeddings_hnsw
ON public.product_embeddings
USING hnsw (embedding extensions.vector_cosine_ops)
WITH (m = 24, ef_construction = 200);
```

Očekávaný build time: ~3-5 minut pro 471K vektorů × 256 dims.

### 8.2 Úprava RPC search_product_embeddings_semantic

Přidat category filtr. **Pozor na anomálii "Obchodní zboží":** tato
meta-kategorie (118K položek) má subcategorie zrcadlící top-level kategorie.
Filtr musí hledat v **obou** — category i subcategory.

```
Příklad: "Modulové přístroje" existuje jako:
  category = "Modulové přístroje"                    →  7 919 položek
  category = "Obchodní zboží", subcategory = "Modulové přístroje" → 29 603 položek
  Filtr jen na category by minul 79% produktů!
```

```sql
CREATE OR REPLACE FUNCTION search_product_embeddings_semantic(
  query_embedding vector,
  max_results integer DEFAULT 10,
  similarity_threshold double precision DEFAULT 0.5,
  manufacturer_filter text DEFAULT NULL,
  category_filter text DEFAULT NULL  -- hledá v category, subcategory I sub_subcategory
)
RETURNS TABLE(...)
LANGUAGE plpgsql
SET search_path = public, extensions
SET statement_timeout = '10s'
AS $$
BEGIN
  SET LOCAL hnsw.ef_search = 200;

  RETURN QUERY
  SELECT ...
  FROM product_embeddings pe
  JOIN products p ON p.sku = pe.sku
  WHERE (1 - (pe.embedding <=> query_embedding)) > similarity_threshold
    AND (manufacturer_filter IS NULL
         OR p.manufacturer ILIKE '%' || manufacturer_filter || '%')
    AND (category_filter IS NULL
         OR p.category = category_filter
         OR p.subcategory = category_filter
         OR p.sub_subcategory = category_filter)
  ORDER BY pe.embedding <=> query_embedding
  LIMIT max_results;
END;
$$;
```

### 8.3 Přepnout semantic search na product_embeddings

Backend `searchProductsSemantic()` aktuálně volá `search_products_semantic`
(tabulka `products`, 84% pokrytí). Přepnout na `search_product_embeddings_semantic`
(tabulka `product_embeddings`, 100% pokrytí).

### 8.4 RPC get_category_tree

Nová DB funkce pro načtení stromu kategorií:

```sql
CREATE OR REPLACE FUNCTION get_category_tree()
RETURNS TABLE(
  category text,
  subcategory text,
  product_count bigint
)
LANGUAGE sql STABLE
AS $$
  SELECT category, subcategory, count(*) as product_count
  FROM products
  WHERE category IS NOT NULL
    AND subcategory IS NOT NULL
  GROUP BY category, subcategory
  HAVING count(*) > 50
  ORDER BY category, count(*) DESC;
$$;
```

> `HAVING count(*) > 50` filtruje garbage kategorie s pár položkami.

### 8.5 Dynamický strom kategorií — cache strategie

Kategorie se mohou měnit při aktualizaci ceníku. Strom kategorií se proto
**načítá dynamicky z DB a cachuje v paměti** — není hardcoded v promptu
ani načítán jen při deployi.

**Implementace:**

```typescript
let cachedTree: CategoryTree | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hodina

async function getCategoryTree(): Promise<CategoryTree> {
  if (cachedTree && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedTree;
  }
  const { data } = await supabase.rpc("get_category_tree");
  cachedTree = data;
  cachedAt = Date.now();
  return cachedTree;
}
```

Strom je malý (~75 subcategorií) — bez dopadu na výkon nebo kontext window.

**Použití:**
- Search pipeline (Krok 6 — refinement): AI dostane strom jako kontext, pokud
  potřebuje zvolit filtr
- Orchestrátor: může volat `get_category_tree` jako tool na vyžádání
- Není součástí KAŽDÉHO volání — jen on-demand když je potřeba

---

## 9. Implementační plán

| # | Úkol | Effort | Blokuje |
|---|---|---|---|
| 1 | HNSW index na `product_embeddings` | S (manual SQL) | Vše ostatní |
| 2 | Vytvořit RPC `get_category_tree` | XS | Krok 6 (refinement) |
| 3 | Přidat category filtr do RPC (hledá v category+subcategory+sub_subcategory) | S | Krok 6 |
| 4 | Přepnout backend na `product_embeddings` | XS | — |
| 5 | Implementovat per-item Search Pipeline (Kroky 1-6) | M | — |
| 6 | Implementovat category tree cache (in-memory, TTL) | S | — |
| 7 | Refaktorovat agenty → orchestrátor + search sub-agent | M | — |
| 8 | Aktualizovat frontend pro nový confidence scoring | S | — |
| 9 | Testy a benchmark na reálných poptávkách | M | — |

---

## 10. Metriky úspěchu

| Metrika | Aktuální stav | Cíl |
|---|---|---|
| Hit@1 (správný produkt na 1. místě) | ~60-70% (raw semantic) | 85%+ (dual search + AI eval) |
| Latence (30 položek batch) | ~30-60s (30× agent) | <1.5s (paralelní per-item pipeline) |
| Latence per item | N/A | ~700ms (bez refinement), ~1.2s (s refinement) |
| Coverage (produkty s embeddings) | 84% (products.embedding) | 100% (product_embeddings) |
| False positive rate (špatná confidence) | Neměřeno | <5% |
| Cena per batch (30 položek) | ~30× LLM agent call | 30× (2 LLM calls + 2 embedding calls) paralelně |
