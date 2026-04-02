# Nová pipeline V2 — ReAct agent s prioritními vrstvami

## Architektura

```
Vstup: ParsedItem { name, unit, quantity, extraLookupCodes? }
     + SearchPreferences { offerType, stockFilter, branchFilter }
     + GroupContext { preferredManufacturer, preferredLine }

┌─────────────────────────────────────────────────────┐
│  FÁZE 0: AI Předzpracování (1 LLM call)            │
│  Model: gpt-5.4-mini                                │
│  Vstup: text poptávky                               │
│  Výstup JSON:                                       │
│    - eans: string[]         (nalezené EAN kódy)     │
│    - productCodes: string[] (objednací/katalogové)  │
│    - reformulated: string   (rozvinutý název)       │
│    - productType: string    (typ produktu)           │
│    - keyParams: object      (klíčové parametry)     │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│  VRSTVA 1: EAN lookup (deterministická)             │
│  Pokud eans.length > 0:                             │
│    → lookup_exact(ean)                              │
│    → 1 výsledek = HOTOVO (confidence 100%)          │
│    → matchMethod: "ean"                             │
│    → Žádný checker, žádný retry                     │
└──────────────┬──────────────────────────────────────┘
               │ (nenalezeno / žádný EAN)
               ▼
┌─────────────────────────────────────────────────────┐
│  VRSTVA 2: Kód produktu + checker                   │
│  Pokud productCodes.length > 0:                     │
│    → lookup_exact(code) pro každý kód               │
│    → 1 výsledek = CHECKER ověří kontext              │
│      → checker OK = HOTOVO (confidence 98%)         │
│      → checker FAIL = pokračuj na vrstvu 3          │
│    → 0 nebo 2+ výsledků = pokračuj na vrstvu 3     │
│  matchMethod: "code"                                │
└──────────────┬──────────────────────────────────────┘
               │ (nenalezeno / checker fail / žádný kód)
               ▼
┌─────────────────────────────────────────────────────┐
│  VRSTVA 3/4: ReAct agent (gpt-5.4-mini)            │
│                                                      │
│  POKUD groupContext.preferredManufacturer:           │
│    → tvrdý filtr: agent SMÍ hledat jen v rámci      │
│      daného výrobce (a řady pokud zadána)            │
│    → tool search_products dostane manufacturer filtr │
│    → pokud nic nenajde = NOT_FOUND (ne alternativa!) │
│                                                      │
│  POKUD bez výrobce:                                  │
│    → agent hledá volně                               │
│    → priorita: TECHNICKÁ SHODA (typ + parametry)    │
│    → sklad/cena se NEŘEŠÍ v agentovi                │
│                                                      │
│  Tools:                                              │
│    - search_products(query, manufacturer?)            │
│    - lookup_exact(code)                              │
│    - get_product_detail(sku)                         │
│    - submit_result(selectedSku, alternatives, ...)   │
│                                                      │
│  matchMethod: "semantic" / "fulltext"                │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│  CHECKER (gpt-5.4-mini, 1 call)                     │
│  Vstup: poptávka + vybraný produkt + alternativy    │
│  Výstup:                                             │
│    - selected_ok: bool                               │
│    - alternatives_ok: string[] (SKU co prošly)      │
│    - reason: string                                  │
│                                                      │
│  Pokud selected_ok = false:                          │
│    → odstraní špatné z kandidátů                    │
│    → pokud zbývají dobří kandidáti = vyber z nich   │
│    → pokud ŽÁDNÝ nezbyl = RETRY agent 1×            │
│      (s feedbackem: "minule jsi vybral X, to bylo   │
│       špatně protože Y, zkus znovu")                │
│    → po retry opět checker                          │
│    → pokud i retry fail = NOT_FOUND                 │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│  POST-PROCESSING (kód, ne AI)                       │
│  1. Sort kandidátů: skladem > neskladem             │
│  2. Sort kandidátů: nižší cena > vyšší              │
│  3. Vybraný produkt = první z tech. správných       │
│  4. matchMethod se přenese z vrstvy kde nalezen     │
└─────────────────────────────────────────────────────┘
```

## Fáze 0 — AI předzpracování

Jeden LLM call místo dvou (reformulation + code extraction se sloučí):

```json
{
  "eans": ["4015081677733"],
  "productCodes": ["S201-B16", "GXRE165"],
  "reformulated": "JISTIC PL6-B16/1 jistič jednopólový 16A charakteristika B",
  "productType": "jistič",
  "keyParams": {
    "poles": 1,
    "current": "16A",
    "characteristic": "B"
  }
}
```

Výhoda: agent v dalších krocích už má jasně extrahované informace.

## Vrstva 1 — EAN

- Čistě deterministické
- EAN je 13místné číslo, AI ho extrahuje ve fázi 0
- Pokud `lookup_exact` vrátí přesně 1 produkt přes `ean_exact` match → hotovo
- Žádný checker — EAN je unikátní identifikátor

## Vrstva 2 — Kód produktu

- AI extrahoval kódy ve fázi 0
- `lookup_exact` hledá v identifiers tabulce
- Pokud najde přesně 1 produkt → checker ověří, že to dává smysl v kontextu
- Checker fail = kód se asi shodoval náhodně → pokračuj na vrstvu 3
- Více výsledků = nejednoznačné → pokračuj na vrstvu 3

## Vrstva 3/4 — ReAct agent

Klíčové změny oproti testu:

### Výrobce jako tvrdý filtr
GroupContext.preferredManufacturer se nepředává jako "preferenci" ale jako **omezení**:
- Tool `search_products` automaticky filtruje na daného výrobce
- Agent NESMÍ navrhnout produkt jiného výrobce
- Pokud nic nenajde → `not_found`, NE alternativa

### Agent NEŘEŠÍ sklad a cenu
Prompt explicitně říká:
> "Tvůj jediný úkol je najít technicky správný produkt. IGNORUJ cenu, sklad, dostupnost.
> Pokud najdeš více technicky správných produktů, vrať je VŠECHNY jako alternativy."

### Alternativy
Agent vrací:
- `selectedSku` — nejlepší technický match, NEBO null pokud si není jistý (nesmí za každou cenu vybrat)
- `alternativeSkus` — další technicky správné produkty (max 10)

## Checker — logika retry

```
checker(poptávka, vybraný, alternativy)
  → selected_ok?
    → ANO: hotovo
    → NE:
      → jsou v alternativách dobří kandidáti?
        → ANO: vyber prvního dobrého, hotovo
        → NE (všichni špatní NEBO žádné alternativy):
          → RETRY agent s feedbackem (max 1×)
          → checker znovu
          → stále fail = NOT_FOUND
```

## Post-processing (kód)

Zatím minimální — stavíme základ, cenu/sklad doladíme později:
1. Vybraný produkt = to co agent vrátil (nebo null)
2. Alternativy = technicky správné produkty z agenta (max 10)
3. Řazení dle ceny/skladu — ODLOŽENO, dořešíme po validaci základu

## matchMethod pro UI

Každý výsledek nese `matchMethod`:
- `"ean"` — nalezeno přes EAN, 100% jistota
- `"code"` — nalezeno přes kód produktu, ověřeno checkerem
- `"semantic"` — nalezeno AI agentem, ověřeno checkerem
- `"not_found"` — nic nenalezeno

UI může zobrazit ikonu/badge podle matchMethod.

## Ekonomika (odhad per položka)

| Fáze | LLM calls | ~Tokeny | ~Čas |
|------|-----------|---------|------|
| Fáze 0 (předzpracování) | 1 | ~1K | ~1s |
| Vrstva 1 (EAN) | 0 | 0 | <0.5s |
| Vrstva 2 (kód + checker) | 0-1 | 0-1K | <1s |
| Vrstva 3/4 (ReAct, 2-3 tools) | 2-4 | ~8-15K | ~15-30s |
| Checker | 1 | ~1-2K | ~2s |
| Retry (10-20% případů) | 3-5 | ~10-15K | ~15-25s |
| **Typický případ** | **4-6** | **~12K** | **~20s** |
| **Worst case (retry)** | **8-10** | **~25K** | **~45s** |

Cena per položka: ~$0.005-0.008 (gpt-5.4-mini)

## Implementační plán

1. Nový soubor `searchPipelineV2.ts` — neřežeme do stávající pipeline
2. Nový endpoint `/agent/search-v2` — paralelně se stávajícím
3. Feature flag v UI pro přepnutí
4. Test na 30 cases → porovnání s V1
5. Postupný rollout
