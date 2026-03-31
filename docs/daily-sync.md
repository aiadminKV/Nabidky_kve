# Denní synchronizace produktových dat

## O co jde

KV Offer Manager je aplikace pro správu produktové nabídky KV Elektro. Produktová data (názvy, ceny, sklady, kategorie, dodavatelé...) pochází z interního SAP systému a jsou dostupná přes API endpoint ve formě CSV souboru (~928 000 produktů, ~230 MB).

Tato data se mění — SAP aktualizuje ceny, stavy skladů, přidává nové produkty, mění názvy. Aby naše databáze (Supabase/PostgreSQL) odpovídala realitě, existuje **denní synchronizační pipeline**, která:

1. Stáhne aktuální CSV ze SAP API
2. Porovná ho s tím, co máme v databázi
3. Zapíše **pouze rozdíly** (ne celý dataset znovu)
4. Pro změněné/nové produkty vygeneruje vektorové embeddingy (pro fulltextové a sémantické vyhledávání)

Pipeline běží automaticky **každý den v 01:00 UTC** na Railway (hosting platformě) jako součást backend služby.

---

## Databázový model

Data jsou uložena v PostgreSQL (Supabase) v tzv. "V2" tabulkách:

| Tabulka | Co obsahuje |
|---|---|
| `products_v2` | Hlavní tabulka — název, dodavatel, kategorie, status, SKU, MATNR kód, `embedding_stale` flag |
| `product_price_v2` | Aktuální a předchozí cena produktu |
| `product_branch_stock_v2` | Stav skladu pro každou pobočku (WH_001, WH_002...) |
| `product_identifiers_v2` | EAN kódy a dodavatelské kódy (IDNLF) |
| `product_embeddings_v2` | Vektorové embeddingy pro sémantické vyhledávání |

Každý produkt má unikátní `source_matnr` (SAP kód) a interní `id` (UUID).

---

## Jak synchronizace funguje

Pipeline má 7 fází, které běží postupně:

### Fáze 1 — Stažení CSV

Script stáhne soubor `matnr_dispo_info.csv` ze SAP API přes HTTP s Basic Auth autentizací. Soubor má ~230 MB a obsahuje všechny produkty jako středníkem oddělený CSV (kódování UTF-8).

Každý řádek CSV obsahuje: MATNR (kód), MAKTX (název), LIFNR (dodavatel), C4_PRICE (cena), MSTAE/MSTAV (statusy), MATKL (kategorie), MEINS (jednotka), EAN, IDNLF, DISPO a sloupce WH_xxx pro skladové zásoby na jednotlivých pobočkách.

### Fáze 2 — Načtení dat pro porovnání

Paralelně probíhají dvě operace:
- **Parsování staženého CSV** → nový stav (~13s)
- **Načtení aktuálního stavu z databáze** → starý stav (~40-60s)

Obojí se načte do paměti jako klíč-hodnota mapa (MATNR → data produktu).

> Starý stav se vždy bere přímo z databáze — není potřeba žádný soubor z předchozího dne ani persistent storage na serveru.

### Fáze 3 — Porovnání (diff) a kontrola bezpečnostních limitů

Script projde všechny produkty a najde rozdíly:

| Typ změny | Příklad |
|---|---|
| Nový produkt | MATNR existuje v CSV, ale ne v DB |
| Odebraný produkt | MATNR existuje v DB, ale ne v CSV |
| Změna ceny | Cena v CSV se liší od ceny v DB |
| Změna názvu | Název v CSV se liší od názvu v DB |
| Změna dodavatele | Dodavatel v CSV se liší od dodavatele v DB |
| Změna skladu | Skladová zásoba na některé pobočce se liší |
| Změna kategorie | Kód kategorie (MATKL) se liší |
| Změna statusu | Status nákupu/prodeje se liší |

Poté se zkontrolují **bezpečnostní thresholds** — pokud je změn příliš mnoho, sync se zastaví a pošle alert. Tím se chrání proti situacím, kdy API vrátí poškozená/neúplná data:

| Co se kontroluje | Výchozí limit | Proč |
|---|---|---|
| Nové produkty | max 2 000 | Velký nárůst může znamenat chybu v API |
| Odebrané produkty | max 500 | Hromadné mazání je podezřelé |
| Změny názvů | max 5 000 | Masivní přejmenování je neobvyklé |
| Re-embedding count | max 5 000 | Příliš mnoho embeddingů = drahé a pomalé |
| Pokles počtu řádků | max 5% | API možná vrací neúplná data |

Limity lze upravit přes environment variables (viz sekce Konfigurace).

### Fáze 4 — Překlad kódů na databázové ID

SAP používá MATNR kódy (např. `000000000002074735`), databáze má UUID. V této fázi se vytvoří mapování MATNR → UUID pro všechny dotčené produkty. Stejně tak pro pobočky (WH kódy → UUID).

### Fáze 5 — Zápis změn do databáze

Změny se zapisují do PostgreSQL přes přímé pg spojení (ne přes Supabase REST API — to by bylo příliš pomalé pro tisíce UPDATE příkazů). Zápis probíhá v transakcích po 500 řádcích.

Co se kam zapisuje:

| Změna | Tabulka | Detail |
|---|---|---|
| Nový produkt | `products_v2` + všechny podtabulky | INSERT nového záznamu + cena + sklady + identifikátory |
| Odebraný produkt | `products_v2` | Soft-delete (nastaví `removed_at`, nesmaže řádek) |
| Cena | `product_price_v2` | Stará cena → `previous_price`, nová → `current_price` |
| Sklad | `product_branch_stock_v2` | UPSERT skladové zásoby per pobočka |
| Název, dodavatel, kategorie, status, DISPO | `products_v2` | UPDATE příslušného sloupce |

Při změně **názvu** nebo **dodavatele** se v rámci stejného UPDATE příkazu nastaví i flag `embedding_stale = true`. Stejně tak u nově vložených produktů. Tento flag říká fázi 6, že produkt čeká na nový embedding. Zápis flagu je atomický se změnou dat — pokud se data zapíšou, flag se nastaví vždy.

### Fáze 6 — Generování embeddingů

Pipeline se dotáže databáze na všechny produkty kde `embedding_stale = true`. To zahrnuje:
- Produkty, u kterých se právě změnil název nebo dodavatel (z aktuálního syncu)
- Nové produkty vložené v aktuálním syncu
- Produkty z **předchozího přerušeného syncu**, kde se data zapsala ale embedding se nestihl vygenerovat

Tím je zajištěno, že se žádný produkt "neztratí" — i po crashy se při dalším syncu dožene.

Embeddingy se generují po dávkách (500 produktů najednou) a po úspěšném zápisu embeddings se v **rámci stejné transakce** flag `embedding_stale` vrátí na `false`. Pokud zápis selže, flag zůstává na `true` a příští sync to zkusí znovu.

Embedding se generuje z textu složeného z: název produktu, search hints, jméno dodavatele a hierarchie kategorií. Používá se model OpenAI `text-embedding-3-small` (256 dimenzí). Jedna dávka trvá ~55-70 sekund.

I na Phase 6 platí **bezpečnostní threshold** — pokud počet produktů čekajících na embedding překročí limit (default 5 000), fáze se přeskočí a pošle se alert.

> Změna **kategorie** nezpůsobí re-embedding — kategorie se sice do embedding textu zahrnuje, ale v praxi se mění tak zřídka, že by to bylo zbytečně drahé.

### Fáze 7 — Úklid

Stažený CSV soubor se přejmenuje na `.last` (pro případné debugování). Při dalším syncu se přepíše.

---

## Kde to běží

### Produkce (Railway)

Sync je součástí **backend služby** (Hono/Node.js) na Railway. Není to samostatný service — běží uvnitř stejného kontejneru jako API backend.

- Backend se startuje příkazem `node dist/index.js`
- Při startu se zaregistruje cron job přes knihovnu `node-cron`
- V 01:00 UTC cron spustí sync script jako child process (`npx tsx daily-sync-v2.ts`)
- Logy se streamují do Railway logu s prefixem `[sync]`

Sync používá dočasné úložiště `/tmp/sync/` pro stažený CSV. Po restartu kontejneru se smaže, ale to nevadí — baseline se vždy načítá z DB.

### Lokálně

Script lze spustit lokálně z adresáře `scripts/`. Používá `.env` soubor v kořeni projektu pro konfiguraci. Pracuje proti produkční databázi (nebo jakékoli, na kterou ukazuje `SUPABASE_DB_URL`).

---

## Jak to pouštět

### Automaticky (produkce)

Sync se spouští sám v 01:00 UTC. Není potřeba nic dělat.

### Manuálně z příkazové řádky (lokálně)

```bash
cd scripts/

# 1. Bezpečný test — jen porovná, nic nezapíše
npx tsx daily-sync-v2.ts --dry-run

# 2. Bezpečný test bez stahování (pokud CSV už máte stažené)
npx tsx daily-sync-v2.ts --dry-run --skip-download

# 3. Ostrý sync — stáhne, porovná, zapíše
npx tsx daily-sync-v2.ts

# 4. Ostrý sync — přeskočí bezpečnostní limity (POZOR, viz níže)
npx tsx daily-sync-v2.ts --force

# 5. Ostrý sync bez generování embeddingů (rychlejší, ale neaktualizuje vyhledávání)
npx tsx daily-sync-v2.ts --skip-embed

# 6. Kombinace — použít existující CSV + přeskočit limity
npx tsx daily-sync-v2.ts --skip-download --force
```

### Manuálně přes API (produkce)

```bash
# Spustit sync
curl -X POST https://blissful-essence-production.up.railway.app/admin/sync/trigger

# Zkontrolovat, zda sync běží
curl https://blissful-essence-production.up.railway.app/admin/sync/status
```

---

## Konfigurace (environment variables)

### Povinné

| Variable | Popis |
|---|---|
| `SUPABASE_URL` | URL Supabase projektu |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role klíč (plný přístup k DB) |
| `SUPABASE_DB_URL` | PostgreSQL connection string (přímé spojení přes pooler) |
| `OPENAI_API_KEY` | API klíč pro generování embeddingů |
| `SYNC_API_URL` | URL SAP API endpointu (`https://api.kvelektro.cz/ainabidky/KVP`) |
| `SYNC_API_USER` | Uživatelské jméno pro SAP API |
| `SYNC_API_PASSWORD` | Heslo pro SAP API |

### Volitelné

| Variable | Default | Popis |
|---|---|---|
| `SYNC_WEBHOOK_URL` | _(vypnuto)_ | Google Chat webhook URL pro alertování |
| `SYNC_CRON_SCHEDULE` | `0 1 * * *` | Cron výraz pro plánované spuštění (01:00 UTC) |
| `SYNC_THRESHOLD_NEW` | `2000` | Max nových produktů před zastavením |
| `SYNC_THRESHOLD_REMOVED` | `500` | Max odebraných produktů |
| `SYNC_THRESHOLD_NAMES` | `5000` | Max změn názvů |
| `SYNC_THRESHOLD_REEMBED` | `5000` | Max produktů k re-embeddingu |
| `SYNC_THRESHOLD_ROW_DROP_PCT` | `5` | Max % pokles počtu řádků |

Thresholds se dají dočasně zvýšit v Railway environment variables pro konkrétní situace a pak vrátit zpět.

---

## Alertování (Google Chat)

Pokud je nastavený `SYNC_WEBHOOK_URL`, pipeline posílá zprávy do Google Chat:

| Zpráva | Kdy se pošle |
|---|---|
| 🔄 Sync started | Sync začal (informativní) |
| 🚨 Threshold violations | Bezpečnostní limit překročen — sync se zastavil, potřeba zásah |
| ❌ Sync FAILED | Neočekávaná chyba — sync spadl |
| ✅ Sync complete | Sync úspěšně dokončen + shrnutí změn |

---

## Co dělat, když přijde alert

### 🚨 Threshold violations

1. **Nepanikařit.** Sync se zastavil a nic se nezměnilo v DB.
2. Spustit lokálně `npx tsx daily-sync-v2.ts --dry-run` a podívat se na výpis změn.
3. Posoudit, zda jsou změny legitimní:
   - **Ano** (např. SAP přidal nový sortiment, přejmenoval řadu produktů) → spustit s `--force`
   - **Ne** (např. API vrací jen 100K produktů místo 928K) → počkat, zkusit znovu později, kontaktovat správce SAP API
4. Pokud jde o jednorázovou hromadnou změnu, lze dočasně zvýšit thresholds v env variables a po syncu vrátit.

### ❌ Sync FAILED

1. Podívat se do Railway logů na chybovou hlášku.
2. Nejčastější příčiny:
   - **SAP API nedostupné** → samo se opraví příští den
   - **OpenAI API limit** → zkontrolovat billing, sync spustit znovu s `--skip-embed`
   - **DB connection timeout** → zkontrolovat Supabase status

---

## Na co si dát pozor

### Baseline je vždy databáze, ne soubor

Důležitý architektonický detail: pipeline **neporovnává dva CSV soubory** (nový vs. předchozí). Baseline (starý stav) se vždy načítá přímo z databáze — to, co je aktuálně v DB, je "předchozí stav".

```
Jak to NEFUNGUJE (intuitivní, ale špatné):
  previous.csv  ←── porovnání ──→  new.csv
                                        ↓ po syncu se přepíše
                                    previous.csv   ← baseline pro příští sync

Jak to SKUTEČNĚ funguje:
  DB (aktuální stav)  ←── porovnání ──→  new.csv (stažené z API)
         ↑
  fáze 5 zapíše změny → DB je automaticky baseline pro příští sync
```

Výhody tohoto přístupu:
- Baseline je vždy **přesně to, co je v DB** — žádná možnost desynchronizace
- Po restartu serveru / redeploymentu sync funguje správně bez jakékoli přípravy
- Není potřeba persistent disk storage na Railway

Stažený CSV soubor se po syncu pouze přejmenuje na `.last` pro případné debugování. Příští sync ho ignoruje a znovu stáhne čerstvá data z API.

### Crash resilience — flag `embedding_stale`

Fáze 5 (zápis dat) a fáze 6 (embedding) jsou dvě oddělené operace. Pokud sync crashne mezi nimi, data v DB jsou aktuální, ale embedding je zastaralý. Bez ošetření by se to nenapravilo — příští sync by viděl shodu mezi DB a API a nedetekoval by žádnou změnu.

Řešení: při každém zápisu nového názvu nebo dodavatele se **atomicky** nastaví `products_v2.embedding_stale = true`. Fáze 6 se pak neptá diffu "co se změnilo", ale přímo DB "které produkty mají stale flag". Po úspěšném zápisu embeddingu se flag vrátí na `false` v rámci stejné transakce.

```
Normální průběh:
  Phase 5: name = "NOVÝ", embedding_stale = TRUE    (jeden SQL příkaz)
  Phase 6: embedding generován, embedding_stale = FALSE  (jedna transakce)

Crash po Phase 5, před Phase 6:
  DB: name = "NOVÝ", embedding_stale = TRUE
  → příští sync: Phase 6 najde flag → dořeší

Crash uprostřed Phase 6 (polovina batchů hotová):
  Hotové batche: embedding_stale = FALSE
  Nedokončené: embedding_stale = TRUE
  → příští sync: Phase 6 dořeší jen nedokončené
```

V DB je partial index `WHERE embedding_stale = true` — dotaz na stale produkty je vždy rychlý (typicky 0 řádků, žádný full-table scan).

### Nikdy nepouštět `--force` slepě

Vždy nejdřív `--dry-run`, přečíst výpis, až potom se rozhodovat. `--force` přeskočí všechny bezpečnostní kontroly.

### Re-embedding je nejpomalejší a nejdražší fáze

- 500 produktů = ~55-70 sekund (OpenAI API call + zápis do DB)
- 1 000 produktů = ~2 minuty
- 14 000 produktů = ~40 minut
- Každá dávka stojí peníze (OpenAI API tokeny)

Pokud potřebujete rychlý sync a embeddingy nejsou urgentní, použijte `--skip-embed`. Embeddingy se dají doplnit později scriptem `backfill-embeddings.ts`.

### Paralelní běhy jsou blokované

Cron má ochranu — pokud předchozí sync ještě běží, další se přeskočí. To platí i pro manuální trigger přes API.

### Lookup tabulky musí být aktuální

V adresáři `data-model/sync/` jsou dva CSV soubory pro překlad kódů:
- `new_name_of_category.csv` — SAP kód kategorie → čitelný název
- `new_status_type.csv` — SAP kód statusu → popis

Tyto soubory se kompilují do Docker image. Pokud SAP přidá nové kódy kategorií/statusů, je potřeba soubory aktualizovat a redeploynout.

### Produkty s prázdným názvem se neembedují

V DB existuje ~17 produktů bez názvu. Sync je záměrně přeskakuje při embeddingu (OpenAI odmítne prázdný vstup). Jakmile API dodá název, embedding se vygeneruje automaticky při dalším syncu.

---

## Typický průběh běžného dne

```
01:00  Cron spustí sync
01:00  Fáze 1: Stažení CSV (25s)
01:01  Fáze 2: Parse CSV (13s) + DB snapshot (40s) — paralelně
01:01  Fáze 3: Diff — typicky: 50-200 cen, 100-500 skladů, 0-20 názvů
01:01  Fáze 3b: Threshold check — OK
01:02  Fáze 4: MATNR→ID překlad (30s)
01:02  Fáze 5: Zápis změn (10-30s)
01:03  Fáze 6: Re-embed (2-5 min pro 50-200 produktů)
01:05  Fáze 7: Úklid
01:05  ✅ "Sync complete in 5m | New: 3 | Prices: 87 | Stock: 312"
```

V běžný den sync trvá **3-5 minut**. Při větší změně (tisíce nových názvů) až **30-60 minut**.

---

## Struktura souborů

```
scripts/
├── daily-sync-v2.ts           # Hlavní sync pipeline
├── lib/sync-logger.ts         # Logger + Google Chat webhook
├── backfill-embeddings.ts     # Jednorázový script: doplní chybějící embeddingy
├── export-db-baseline.ts      # Jednorázový script: export DB do CSV (pro debug)
└── package.json

backend/src/
├── cron/daily-sync.ts         # Cron scheduler (node-cron) + child process
└── index.ts                   # API endpointy: /admin/sync/trigger, /admin/sync/status

data-model/sync/
├── new_name_of_category.csv   # Lookup: kód kategorie → název
└── new_status_type.csv        # Lookup: kód statusu → popis

Dockerfile.backend             # Docker image — obsahuje backend + scripts + lookup CSVs
```
