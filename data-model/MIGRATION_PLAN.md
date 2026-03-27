# Migrační plán: redesign datového modelu KV Offer Manager

> **Datum:** 22. 3. 2026 | **Status:** V2 — schváleno k přípravě dat
>
> Tento dokument popisuje kompletní redesign datového modelu,
> inicializační nahrání dat a strategii denního updatu.
>
> **KLÍČOVÉ PRAVIDLO: NESMÍME PŘETÍŽIT DB.**
> Veškerá data se připravují lokálně (Fáze A), do DB se nahrávají
> jedním bulk write (Fáze B). Žádné inkrementální zápisy.

---

## 1. Východiska z analýzy dat

### 1.1 Současný stav DB

| Tabulka | Řádky | Problémy |
|---------|-------|----------|
| `products` | 472 748 | Monolith: cena + popis + kategorie + search_vector v jedné tabulce. 10 indexů. Každý upsert = rebuild search_vector + 10 index updates. |
| `product_embeddings` | 364 327 | **Nemá PK** — riziko duplicit. 77% pokrytí. |
| `offers` | 57 | Testovací data — archivovat |
| `offer_items` | 817 | FK → products.id — archivovat |

### 1.2 Nový zdroj dat (matnr_dispo_info)

- **927 893 produktů** (2× více než dnes)
- **95% má cenu**, 82% EAN, 98% IDNLF, 99% dodavatele
- **DESC je prázdný** (0%) — připraveno pro budoucí doplnění
- **THUMB_FILE** — template URL, připraveno pro budoucí doplnění
- **Sklad je extrémně sparse**: jen 2.9% produktů má sklad kdekoliv, jen 0.6% buněk product×branch je kladných
- **23 pobočkových WH_ sloupců** — dynamicky přibývají

### 1.3 Proč redesign

1. **Cena v monolitické tabulce** — update ceny = rebuild search_vector + 10 indexů
2. **Žádná evidence skladu** — přibývá 23 poboček × 928K produktů
3. **EAN/IDNLF multi-value** — nelze efektivně prohledávat v jednom text sloupci
4. **Kategorie jako volný text** — nespolehlivé, bez hierarchie
5. **Chybí zákazníci** — nová potřeba
6. **2× větší dataset** — 928K vs 471K

---

## 2. Cílový datový model

### 2.1 Přehled tabulek

```
┌─────────────────────────────────────────────────────────────────────┐
│  LOOKUP TABULKY (reference data)                                     │
│                                                                       │
│  status_types_v2          — MMSTA/VMSTA kódy + texty                │
│  product_categories_v2    — hierarchický strom kategorií             │
│  branches_v2              — seznam poboček z WH_ sloupců            │
│  customers_v2             — zákazníci z customer_info                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  PRODUCT CORE (stabilní, update jen při změně produktu)              │
│                                                                       │
│  products_v2              — hlavní produktová tabulka                │
│  product_identifiers_v2   — normalizované EAN + IDNLF               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  WRITE-HOT (mění se denně)                                           │
│                                                                       │
│  product_price_v2         — aktuální cena per produkt               │
│  product_branch_stock_v2  — sklad per produkt × pobočka (sparse)    │
│  (stock summary odstraněn — EXISTS na PK branch_stock stačí)        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  EMBEDDINGS (oddělené, ne write-hot)                                 │
│                                                                       │
│  product_embeddings_v2    — vector(256) per produkt, HNSW index     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  STAGING + PROVOZNÍ                                                   │
│                                                                       │
│  import_batches_v2        — evidence importů                        │
│  (staging tabulka odstraněna — file-to-file comparison)             │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 DDL — Lookup tabulky

```sql
-- ═══════════════════════════════════════════════════
-- STATUS TYPES (reference, téměř nikdy se nemění)
-- ═══════════════════════════════════════════════════
CREATE TABLE status_types_v2 (
  status_code   text    PRIMARY KEY,
  status_type   text    NOT NULL CHECK (status_type IN ('purchase', 'sales')),
  status_text   text    NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_status_types_v2_type ON status_types_v2 (status_type);

COMMENT ON TABLE status_types_v2 IS
  'MMSTA (purchase) a VMSTA (sales) kódy se statusovým textem z status_type CSV';

-- ═══════════════════════════════════════════════════
-- PRODUCT CATEGORIES (hierarchická, prefixová logika)
-- ═══════════════════════════════════════════════════
CREATE TABLE product_categories_v2 (
  category_code   text    PRIMARY KEY,
  category_name   text    NOT NULL,
  level           smallint NOT NULL CHECK (level IN (1, 2, 3)),
  parent_code     text    REFERENCES product_categories_v2(category_code),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_categories_v2_parent ON product_categories_v2 (parent_code);
CREATE INDEX idx_categories_v2_level ON product_categories_v2 (level);

COMMENT ON TABLE product_categories_v2 IS
  'Hierarchie: level 1 = 3-digit hlavní (32), level 2 = 5-digit sub (119), level 3 = 7-digit řada (382)';

-- ═══════════════════════════════════════════════════
-- BRANCHES (pobočky / sklady)
-- ═══════════════════════════════════════════════════
CREATE TABLE branches_v2 (
  id                bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_branch_code text    UNIQUE NOT NULL,
  name              text,
  active            boolean  NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE branches_v2 IS
  'Pobočky derivované z WH_#### sloupců v matnr_dispo_info. Jména zatím nemáme.';

-- ═══════════════════════════════════════════════════
-- CUSTOMERS
-- ═══════════════════════════════════════════════════
CREATE TABLE customers_v2 (
  id               bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kunnr     text     UNIQUE NOT NULL,
  ico              text,
  dic              text,
  name             text     NOT NULL,
  address          text,
  sperr            text,
  loevm            text,
  search_vector    tsvector,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_customers_v2_ico ON customers_v2 (ico) WHERE ico IS NOT NULL;
CREATE INDEX idx_customers_v2_name_trgm ON customers_v2 USING gin (name gin_trgm_ops);
CREATE INDEX idx_customers_v2_address_trgm ON customers_v2 USING gin (address gin_trgm_ops);
CREATE INDEX idx_customers_v2_search ON customers_v2 USING gin (search_vector);

COMMENT ON COLUMN customers_v2.address IS
  'ADDRE = identifikační adresa pro vyhledávání, NE dodací místo';
COMMENT ON COLUMN customers_v2.sperr IS
  'SPERR z SAP — surová hodnota, význam zatím neinterpretujeme';
COMMENT ON COLUMN customers_v2.loevm IS
  'LOEVM z SAP — surová hodnota, význam zatím neinterpretujeme';
```

### 2.3 DDL — Product Core

```sql
-- ═══════════════════════════════════════════════════
-- PRODUCTS V2 (stabilní produktová data)
-- ═══════════════════════════════════════════════════
CREATE TABLE products_v2 (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_matnr         text        UNIQUE NOT NULL,
  sku                  text        UNIQUE NOT NULL,
  name                 text        NOT NULL,
  unit                 text,
  supplier_name        text,
  
  category_code        text        REFERENCES product_categories_v2(category_code),
  category_main        text,
  category_sub         text,
  category_line        text,
  
  status_purchase_code text,
  status_sales_code    text,
  status_purchase_text text,
  status_sales_text    text,
  
  dispo                text,
  is_stock_item        boolean     NOT NULL DEFAULT false,
  description          text,
  thumbnail_url        text,
  
  source_ean_raw       text,
  source_idnlf_raw    text,
  
  search_hints         text,
  
  removed_at           timestamptz,
  search_vector        tsvector,
  
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Indexy pro search
CREATE INDEX idx_products_v2_search ON products_v2 USING gin (search_vector);
CREATE INDEX idx_products_v2_name_trgm ON products_v2 USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_v2_sku_trgm ON products_v2 USING gin (sku gin_trgm_ops);

-- Indexy pro filtrování
CREATE INDEX idx_products_v2_category ON products_v2 (category_code) WHERE category_code IS NOT NULL;
CREATE INDEX idx_products_v2_supplier ON products_v2 (supplier_name) WHERE supplier_name IS NOT NULL;
CREATE INDEX idx_products_v2_not_removed ON products_v2 (removed_at) WHERE removed_at IS NULL;
CREATE INDEX idx_products_v2_stock_item ON products_v2 (is_stock_item) WHERE is_stock_item = true;

-- Trigger: search_vector update (NEAKTUALIZUJE SE při změně ceny — ta je v jiné tabulce)
CREATE OR REPLACE FUNCTION products_v2_search_vector_update()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'public', 'extensions' AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.sku, '')), 'A') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.search_hints, '')), 'A') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.supplier_name, '')), 'B') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.category_main, '')), 'C') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.category_sub, '')), 'C') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.category_line, '')), 'C') ||
    setweight(to_tsvector('public.cs_unaccent', coalesce(NEW.description, '')), 'D');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_products_v2_search_vector
  BEFORE INSERT OR UPDATE OF name, supplier_name, category_main, category_sub, category_line, description, sku, search_hints
  ON products_v2
  FOR EACH ROW EXECUTE FUNCTION products_v2_search_vector_update();

COMMENT ON TABLE products_v2 IS
  'Stabilní produktová data z matnr_dispo_info. Cena a sklad jsou v oddělených tabulkách.';
COMMENT ON COLUMN products_v2.source_matnr IS
  'Plný 18-digit MATNR ze SAP (zero-padded)';
COMMENT ON COLUMN products_v2.sku IS
  'MATNR stripnutý o leading zeros = business klíč pro API a frontend';
COMMENT ON COLUMN products_v2.is_stock_item IS
  'DISPO = ANO → true. Skladová položka (příznak, ne skutečný stav). Pro search filtr "skladová/neskladová".';
COMMENT ON COLUMN products_v2.search_hints IS
  'Developer/admin-managed (SQL/skript, ne UI). Nejčastější dotazy / aliasy pro produkt. Zahrnuty do search_vector (váha A) i embedding textu. Po změně nutný re-embedding.';
COMMENT ON COLUMN products_v2.removed_at IS
  'NULL = produkt je v aktuálním CSV feedu. Non-NULL = kdy produkt zmizel z feedu. Historické nabídky zůstávají funkční.';
COMMENT ON COLUMN products_v2.dispo IS
  'Surová hodnota DISPO ze SAP (ANO, NE, ...).';

-- ═══════════════════════════════════════════════════
-- PRODUCT IDENTIFIERS (normalizované EAN + IDNLF)
-- ═══════════════════════════════════════════════════
CREATE TABLE product_identifiers_v2 (
  id               bigint   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id       bigint   NOT NULL REFERENCES products_v2(id) ON DELETE RESTRICT,
  identifier_type  text     NOT NULL CHECK (identifier_type IN ('EAN', 'IDNLF')),
  identifier_value text     NOT NULL,
  
  UNIQUE (product_id, identifier_type, identifier_value)
);

CREATE INDEX idx_identifiers_v2_product ON product_identifiers_v2 (product_id);
CREATE INDEX idx_identifiers_v2_value ON product_identifiers_v2 (identifier_value);

COMMENT ON TABLE product_identifiers_v2 IS
  'Normalizované identifikátory. EAN odděleno čárkou, IDNLF odděleno literálem ,:';
```

### 2.4 DDL — Write-Hot tabulky

```sql
-- ═══════════════════════════════════════════════════
-- PRODUCT PRICE (jedna cena per produkt, write-hot)
-- ═══════════════════════════════════════════════════
CREATE TABLE product_price_v2 (
  product_id       bigint      PRIMARY KEY REFERENCES products_v2(id) ON DELETE RESTRICT,
  current_price    numeric(12,2) NOT NULL,
  currency         text        NOT NULL DEFAULT 'CZK',
  batch_id         bigint,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE product_price_v2 IS
  'Aktuální cena. 1 řádek = 1 produkt. Minimální indexy — PK stačí.';

-- ═══════════════════════════════════════════════════
-- PRODUCT BRANCH STOCK (sparse — jen kladné zásoby)
-- ═══════════════════════════════════════════════════
CREATE TABLE product_branch_stock_v2 (
  product_id       bigint      NOT NULL REFERENCES products_v2(id) ON DELETE RESTRICT,
  branch_id        bigint      NOT NULL REFERENCES branches_v2(id) ON DELETE RESTRICT,
  stock_qty        numeric(12,3) NOT NULL CHECK (stock_qty > 0),
  batch_id         bigint,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  
  PRIMARY KEY (product_id, branch_id)
);

CREATE INDEX idx_branch_stock_v2_branch ON product_branch_stock_v2 (branch_id);

COMMENT ON TABLE product_branch_stock_v2 IS
  'Jen kladné zásoby. 131K řádků místo 21.3M (99.4% úspora). Nulový sklad = řádek neexistuje.
   Stock summary ODSTRANĚN — použít EXISTS na této tabulce (PK = product_id, branch_id → O(log n)).';
```

### 2.5 DDL — Embeddings

```sql
-- ═══════════════════════════════════════════════════
-- PRODUCT EMBEDDINGS V2 (s PK, provázáno přes product_id)
-- ═══════════════════════════════════════════════════
CREATE TABLE product_embeddings_v2 (
  product_id       bigint    PRIMARY KEY REFERENCES products_v2(id) ON DELETE RESTRICT,
  sku              text      NOT NULL,
  embedding        vector(256) NOT NULL,
  embedding_text   text,
  model_version    text      NOT NULL DEFAULT 'text-embedding-3-small-256',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pe_v2_sku ON product_embeddings_v2 (sku);

-- HNSW index — vytvořit PO naplnění dat (build time ~5 min pro 928K)
-- CREATE INDEX idx_pe_v2_hnsw ON product_embeddings_v2
--   USING hnsw (embedding vector_cosine_ops) WITH (m = 24, ef_construction = 200);

COMMENT ON TABLE product_embeddings_v2 IS
  'Oproti staré tabulce: má PK, FK na products_v2, uchovává embedding_text pro audit.';
COMMENT ON COLUMN product_embeddings_v2.embedding_text IS
  'Text ze kterého byl embedding vygenerován — pro debugging a re-generaci.';
```

### 2.6 DDL — Staging + Provozní

```sql
-- ═══════════════════════════════════════════════════
-- IMPORT BATCHES (evidence importů)
-- ═══════════════════════════════════════════════════
CREATE TABLE import_batches_v2 (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_name      text        NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text        NOT NULL DEFAULT 'running'
                               CHECK (status IN ('running', 'completed', 'failed')),
  row_count_products integer,
  row_count_prices   integer,
  row_count_stock    integer,
  row_count_identifiers integer,
  error_message    text,
  metadata         jsonb       DEFAULT '{}'
);

-- STAGING TABULKA ODSTRANĚNA
-- Staging je file-based: předchozí CSV soubor na disku (data-model/sync/previous_matnr_dispo_info.csv)
-- slouží jako referenční bod pro file-to-file porovnání.
-- Pokud soubor neexistuje (první spuštění), provede se full sync z DB.
```

### 2.7 Přehled indexovací strategie

| Tabulka | Index | Typ | Důvod |
|---------|-------|-----|-------|
| **products_v2** | PK (id) | btree | Joins |
| | source_matnr UNIQUE | btree | CSV matching |
| | sku UNIQUE | btree | API lookups |
| | search_vector | GIN | Fulltext search |
| | name | GIN trigram | Trigram search |
| | sku | GIN trigram | Trigram search |
| | category_code | btree partial | Category filtering |
| | supplier_name | btree partial | Manufacturer filtering |
| | removed_at | btree partial | Filtr: removed_at IS NULL (aktuální produkty) |
| | is_stock_item | btree partial | Filtr "skladová položka" (21.8K z 928K) |
| **product_identifiers_v2** | (product_id, type, value) UNIQUE | btree | Deduplicate per product |
| | product_id | btree | Reverse lookup |
| | identifier_value | btree | EAN/IDNLF exact match search |
| **product_price_v2** | PK (product_id) | btree | **Žádné další!** Přístup jen přes product_id |
| **product_branch_stock_v2** | PK (product_id, branch_id) | btree | Composite lookup + EXISTS pro "skladem" |
| | branch_id | btree | Branch-level queries |
| **product_embeddings_v2** | PK (product_id) | btree | Join |
| | sku | btree | Legacy compat |
| | embedding | HNSW | Vector search |
| **customers_v2** | source_kunnr UNIQUE | btree | CSV matching |
| | ico | btree partial | IČO lookup |
| | name | GIN trigram | Name search |
| | address | GIN trigram | Address search |
| | search_vector | GIN | Fulltext search |

**Celkem na product_price_v2: 1 index (PK)** vs **10 indexů na starém products** — masivní snížení write load pro denní update cen.

---

## 3. Mapování sloupců: CSV → nový model

### 3.1 matnr_dispo_info → products_v2

| CSV sloupec | Cílový sloupec | Transformace |
|-------------|---------------|-------------|
| MATNR | source_matnr | Beze změny (18-digit) |
| MATNR | sku | `ltrim('0')`, pokud vše '0' → '0' |
| MAKTX | name | Trim |
| MEINS | unit | Trim |
| LIFNR | supplier_name | Trim |
| MATKL | category_code | Beze změny (7-digit) |
| MATKL[:3] | category_main | Lookup → name_of_category |
| MATKL[:5] | category_sub | Lookup → name_of_category |
| MATKL | category_line | Lookup → name_of_category |
| MSTAE | status_purchase_code | Beze změny |
| MSTAV | status_sales_code | Beze změny |
| MSTAE | status_purchase_text | Lookup → status_type (MMSTA→MMSTB) |
| MSTAV | status_sales_text | Lookup → status_type (VMSTA→VMSTB) |
| DISPO | dispo | Beze změny (surová hodnota) |
| DISPO | is_stock_item | `DISPO = 'ANO'` → true, jinak false |
| DESC | description | Zatím prázdný |
| THUMB_FILE | thumbnail_url | Beze změny (template) |
| EAN | source_ean_raw | Beze změny |
| IDNLF | source_idnlf_raw | Beze změny |

### 3.2 matnr_dispo_info → product_price_v2

| CSV sloupec | Cílový sloupec |
|-------------|---------------|
| MATNR → product_id | product_id (přes products_v2.source_matnr) |
| C4_PRICE | current_price |

### 3.3 matnr_dispo_info → product_branch_stock_v2

| CSV sloupec | Transformace |
|-------------|-------------|
| WH_1001..WH_1062 | Unpivot: každý sloupec → řádek (product_id, branch_id, stock_qty) |
| | **Jen kde stock_qty > 0** |

### 3.4 EAN → product_identifiers_v2

| Vstup | Separator | Pravidlo |
|-------|-----------|---------|
| EAN sloupec | `,` (čárka) | Split, trim, zahodit prázdné |
| IDNLF sloupec | `,:` (čárka-dvojtečka) | Split by literál `,:`, trim, zahodit prázdné |

### 3.5 customer_info → customers_v2

| CSV sloupec | Cílový sloupec |
|-------------|---------------|
| KUNNR | source_kunnr |
| STCD2 | ico |
| STCEG | dic |
| NAME1 | name |
| ADDRE | address |
| SPERR | sperr (surová hodnota) |
| LOEVM | loevm (surová hodnota) |

### 3.6 name_of_category → product_categories_v2

| CSV sloupec | Transformace |
|-------------|-------------|
| CLASS (3 digits) | level=1, parent_code=NULL |
| CLASS (5 digits) | level=2, parent_code=CLASS[:3] |
| CLASS (7 digits) | level=3, parent_code=CLASS[:5] |
| KSCHL | category_name |

### 3.7 status_type → status_types_v2

| CSV sloupec | Transformace |
|-------------|-------------|
| MMSTA | status_code, status_type='purchase' |
| MMSTB | status_text (pro purchase) |
| VMSTA | status_code, status_type='sales' |
| VMSTB | status_text (pro sales) |

---

## 4. Inicializační pipeline — FÁZE A: Lokální příprava dat

> **KLÍČOVÉ: Fáze A = NULA zápisů do DB. Vše se připraví lokálně jako soubory.**

### 4.1 Přehled Fáze A

```
CSV soubory (data-model/)
    │
    ▼
[A1] Parse + decode encoding (cp1250/latin-1 → UTF-8)
    │
    ▼
[A2] Sestavit lookup data (statusy, kategorie, pobočky)
    │
    ▼
[A2b] Validace kategorií: MATKL kódy z produktů vs name_of_category
      → Neznámé kódy → auto-add s category_name = 'Neznámá kategorie'
    │
    ▼
[A3] Transformovat produkty (resolve lookupů, derive is_stock_item)
    │
    ▼
[A4] Normalizovat identifikátory (EAN split by ',', IDNLF split by ',:')
    │
    ▼
[A5] Extrahovat ceny
    │
    ▼
[A6] Unpivot sklad → sparse řádky (jen stock > 0)
    │
    ▼
[A7] Transformovat zákazníky
    │
    ▼
[A8] Vygenerovat embeddingy (OpenAI API → JSONL)
    │   ⚠ Nejdražší krok — ~453 API callů (batch size 2048)
    │   Spouštět zvlášť, výstup ukládat do JSONL souboru
    │
    ▼
OUTPUT: data-model/prepared/
  ├── 01_status_types.csv
  ├── 02_categories.csv         (včetně auto-added 'Neznámá kategorie')
  ├── 03_branches.csv
  ├── 04_products.csv           (~928K řádků)
  ├── 05_identifiers.csv        (~1M řádků)
  ├── 06_prices.csv             (~889K řádků)
  ├── 07_stock.csv              (~132K řádků, sparse!)
  ├── 08_customers.csv          (~147K řádků)
  └── 09_embeddings.jsonl       (~928K vektorů, batch 2048)
```

### 4.2 TypeScript skript: `scripts/prepare-v2-data.ts`

Tento skript čte zdrojové CSV, provádí VŠECHNY transformace lokálně
a zapisuje připravené soubory do `data-model/prepared/`.

```typescript
// Klíčové funkce (pseudokód — finální implementace v scripts/)

function decodeBuffer(buffer: Buffer): string {
  try {
    const text = buffer.toString('utf-8');
    if (!text.includes('\uFFFD')) return text;
  } catch {}
  const iconv = require('iconv-lite');
  return iconv.decode(buffer, 'cp1250');
}

function buildEmbeddingTextV2(product: {
  name: string;
  supplier_name: string | null;
  category_main: string | null;
  category_sub: string | null;
  category_line: string | null;
  description: string | null;
  search_hints: string | null;
}): string {
  const lines: string[] = [product.name];
  if (product.search_hints) {
    lines.push(`Také známo jako: ${product.search_hints}`);
  }
  if (product.supplier_name) {
    lines.push(`Výrobce: ${product.supplier_name}`);
  }
  const cats = [product.category_main, product.category_sub, product.category_line]
    .filter(Boolean);
  if (cats.length > 0) {
    lines.push(`Kategorie: ${cats.join(' > ')}`);
  }
  if (product.description) {
    lines.push(`Popis: ${product.description.slice(0, 500)}`);
  }
  return lines.join('\n');
}

// SKU derivace
function matnrToSku(matnr: string): string {
  const stripped = matnr.replace(/^0+/, '');
  return stripped || '0';
}

// DISPO → is_stock_item
function isStockItem(dispo: string): boolean {
  return dispo?.trim().toUpperCase() === 'ANO';
}

// EAN split (separator: čárka)
function splitEan(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// IDNLF split (separator: LITERÁL ',:', NE jen čárka!)
function splitIdnlf(raw: string): string[] {
  return raw.split(',:').map(s => s.trim()).filter(Boolean);
}

// Unpivot WH_ sloupců → sparse řádky
function unpivotStock(row: CsvRow, whColumns: string[]): StockRow[] {
  const result: StockRow[] = [];
  for (const col of whColumns) {
    const val = parseFloat(row[col] || '0');
    if (val > 0) {
      result.push({ source_matnr: row.MATNR, branch_code: col, stock_qty: val });
    }
  }
  return result;
}
```

### 4.3 Embedding příprava (skript: `scripts/prepare-v2-embeddings.ts`)

```typescript
// Spouštět ZVLÁŠŤ — trvá ~5-10 min, výstup do JSONL
// Vstup: data-model/prepared/04_products.csv
// Výstup: data-model/prepared/09_embeddings.jsonl

// Formát JSONL:
// {"sku": "1150217", "product_id": 1, "embedding": [0.123, -0.456, ...], "text": "..."}

// Batch size: 2048 textů per OpenAI API call (max povolený)
// 928K / 2048 = 453 API callů
// Rate limiting: exponential backoff
// Checkpoint: zapisovat po každém batchi, při restartu pokračovat
// search_hints: při změně → re-generate embedding (v denním syncu)
```

---

## 5. Inicializační pipeline — FÁZE B: Jednorázové nahrání do DB

> **KLÍČOVÉ: Jeden bulk write. Tabulky se vytvoří BEZ indexů a triggerů,
> data se nahrají, POTOM se vytvoří indexy a triggery.**

### 5.1 Přehled Fáze B

```
Připravené soubory (data-model/prepared/)
    │
    ▼
[B1] CREATE _v2 tabulky (DDL)
     → JEN PK + UNIQUE constraints
     → BEZ GIN/trigram/HNSW indexů
     → BEZ triggerů (search_vector se počítá v Fázi A)
    │
    ▼
[B2] Bulk INSERT lookup tabulek
     → status_types_v2 (18 řádků)
     → product_categories_v2 (534 řádků)
     → branches_v2 (23 řádků)
    │
    ▼
[B3] Bulk INSERT products_v2 (~928K řádků)
     → Včetně search_vector (předpočítaný v Fázi A)
     → Včetně is_stock_item (z DISPO)
    │
    ▼
[B4] Bulk INSERT product_identifiers_v2 (~1M řádků)
    │
    ▼
[B5] Bulk INSERT product_price_v2 (~889K řádků)
    │
    ▼
[B6] Bulk INSERT product_branch_stock_v2 (~132K řádků)
    │
    ▼
[B7] Bulk INSERT customers_v2 (~147K řádků)
    │
    ▼
[B8] Bulk INSERT product_embeddings_v2 (~928K řádků)
    │
    ▼
[B9] CREATE sekundární indexy (GIN, trigram, btree partial)
     ⚠ Tohle je IO-heavy, ale jednou a na hotová data = mnohem rychlejší
    │
    ▼
[B10] CREATE HNSW index na embeddingách (~5-10 min)
    │
    ▼
[B11] CREATE triggers (search_vector auto-update pro budoucí edity)
    │
    ▼
[B12] CREATE RPC funkce
    │
    ▼
[B13] INSERT záznam do import_batches_v2
    │
    ▼
[B14] Uložit zdrojový CSV jako baseline pro file-to-file sync:
      cp matnr_dispo_info.csv → data-model/sync/previous_matnr_dispo_info.csv
    │
    ▼
[B15] Validace (viz sekce 8)
```

### 5.2 Metoda bulk insertu

Dvě možnosti podle dostupného přístupu:

**Varianta A: Přímý Postgres (preferovaná, pokud máme SUPABASE_DB_URL)**

```typescript
import { Pool } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });
const client = await pool.connect();

// COPY je nejrychlejší způsob bulk loadu v Postgresu
const stream = client.query(copyFrom(
  `COPY products_v2 (source_matnr, sku, name, ...) FROM STDIN WITH (FORMAT csv, HEADER true)`
));
const fileStream = fs.createReadStream('data-model/prepared/04_products.csv');
fileStream.pipe(stream);
```

**Varianta B: Supabase REST API (fallback)**

```typescript
// Mega-batch dávky přes REST API
const BATCH_SIZE = 1000;
for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);
  await supabase.from('products_v2').insert(batch);
  // Throttle: 100ms pauza mezi batchi
  await sleep(100);
}
```

### 5.3 Pořadí vytváření indexů (po insertu dat)

```sql
-- Tyto indexy se vytváří AŽ PO naplnění dat (B10)
-- PK + UNIQUE constraints už existují z DDL (B1)

-- products_v2
CREATE INDEX idx_products_v2_search ON products_v2 USING gin (search_vector);
CREATE INDEX idx_products_v2_name_trgm ON products_v2 USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_v2_sku_trgm ON products_v2 USING gin (sku gin_trgm_ops);
CREATE INDEX idx_products_v2_category ON products_v2 (category_code) WHERE category_code IS NOT NULL;
CREATE INDEX idx_products_v2_supplier ON products_v2 (supplier_name) WHERE supplier_name IS NOT NULL;
CREATE INDEX idx_products_v2_not_removed ON products_v2 (removed_at) WHERE removed_at IS NULL;
CREATE INDEX idx_products_v2_stock_item ON products_v2 (is_stock_item) WHERE is_stock_item = true;

-- product_identifiers_v2
CREATE INDEX idx_identifiers_v2_product ON product_identifiers_v2 (product_id);
CREATE INDEX idx_identifiers_v2_value ON product_identifiers_v2 (identifier_value);

-- product_branch_stock_v2
CREATE INDEX idx_branch_stock_v2_branch ON product_branch_stock_v2 (branch_id);

-- customers_v2
CREATE INDEX idx_customers_v2_ico ON customers_v2 (ico) WHERE ico IS NOT NULL;
CREATE INDEX idx_customers_v2_name_trgm ON customers_v2 USING gin (name gin_trgm_ops);
CREATE INDEX idx_customers_v2_address_trgm ON customers_v2 USING gin (address gin_trgm_ops);
CREATE INDEX idx_customers_v2_search ON customers_v2 USING gin (search_vector);

-- product_embeddings_v2 (HNSW — nejdelší krok)
CREATE INDEX idx_pe_v2_sku ON product_embeddings_v2 (sku);
SET statement_timeout = '3600s';
CREATE INDEX idx_pe_v2_hnsw ON product_embeddings_v2
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 24, ef_construction = 200);
```

---

## 6. Denní sync pipeline (HTTP fetch → diff → selective write)

> **Zdroj:** HTTP endpoint s basic auth → CSV (cp1250, ~414 MB, ~928K řádků)
> **Frekvence:** Jednou denně (např. noční cron)
> **Běží na:** Backend (Hono server)
> **Princip:** Stáhnout → porovnat v paměti → zapsat JEN změny
>
> **Scope:** Denní sync: **ceny** (všechny), **stock** (všechny — efektivní, 900K+ má hash=''),
> **nové/zmizelé produkty**, **změny názvů/statusů**. Méně časté: DISPO, EAN, IDNLF → **týdenní sync** (viz 6.7).

### 6.1 Architektura denního syncu

```
┌─────────────────────────────────────────────────────────────────────┐
│  KROK 1: HTTP FETCH                                                  │
│                                                                       │
│  GET /matnr_dispo_info.csv (basic auth)                              │
│  → Stream do temp: data-model/sync/new_matnr_dispo_info.csv        │
│  → Decode cp1250 → UTF-8                                            │
│                                                                       │
│  Lookup feeds (stahovat méně často, např. týdně):                    │
│  GET /status_type.csv, /name_of_category.csv, /customer_info.csv    │
└─────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  KROK 2: FILE-TO-FILE PARSE                                          │
│                                                                       │
│  Soubory:                                                             │
│    NEW  = data-model/sync/new_matnr_dispo_info.csv (právě stažený) │
│    PREV = data-model/sync/previous_matnr_dispo_info.csv            │
│                                                                       │
│  Parse obou CSV → dvě mapy se stejnou strukturou:                   │
│                                                                       │
│  Map<MATNR, {                                                        │
│    price: number,                                                    │
│    stockHash: string,    // hash(sortedPositiveWH), '' pokud         │
│                          // žádný WH > 0 (~900K řádků = '')          │
│    name: string,         // MAKTX                                    │
│    supplier: string,     // LIFNR                                    │
│    category: string,     // MATKL                                    │
│    statusP: string,      // MSTAE                                    │
│    statusS: string,      // MSTAV                                    │
│    dispo: string,        // DISPO (pro weekly check)                 │
│    stocks: {WH_code: qty} // jen kladné, null pokud vše=0            │
│  }>                                                                  │
│                                                                       │
│  Paměť: ~85 MB × 2 (new + prev) ≈ ~170 MB                          │
│  DB READS: NULA                                                       │
│                                                                       │
│  ⚠ Pokud PREV neexistuje (první run, ztracený soubor):              │
│    → FALLBACK: load current state z DB (původní KROK 3)             │
│    → Po úspěchu uložit new jako previous                             │
└─────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  KROK 3: MATNR→ID RESOLUTION                                         │
│                                                                       │
│  Jediný DB dotaz: SELECT id, source_matnr FROM products_v2;         │
│  → Map<MATNR, product_id> pro zápis do DB                           │
│  Paměť: ~928K × 25 bytes ≈ ~23 MB                                   │
│                                                                       │
│  (Nové produkty → dostanou ID po INSERT)                             │
└─────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  KROK 4: DIFF (new map vs prev map, žádné DB dotazy)                 │
│                                                                       │
│  ── DENNĚ (všechny produkty, 928K): ──                               │
│    V new ale ne v prev?  → newProducts[]                             │
│    V prev ale ne v new?  → removedProducts[] (SET removed_at)       │
│    Cena se liší?         → changedPrices[]                           │
│    Název se liší?        → nameChanged[]             (→ re-embed)   │
│    search_hints se liší? → hintsChanged[]            (→ re-embed)   │
│    Dodavatel se liší?    → supplierChanged[]                         │
│    Status se liší?       → statusChanged[]                           │
│    Stock hash se liší?   → stockChanged[]                            │
│    (900K+ má stockHash='' → instant porovnání)                      │
│                                                                       │
│  ── WEEKLY (příznak weeklyMode: true): ──                            │
│    DISPO NE↔ANO?        → dispoChanged[]                            │
│    EAN změna?            → identifiersChanged[]                      │
│    IDNLF změna?          → identifiersChanged[]                      │
│    MEINS změna?           → unitChanged[]                             │
│                                                                       │
│  CO SE NEPOROVNÁVÁ (nikdy):                                          │
│    DESC — prázdný, skip                                              │
│    THUMB_FILE — template, skip                                       │
└─────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  KROK 5: SELECTIVE WRITE (jen změny, batch operace)                  │
│                                                                       │
│  [5a] Nové produkty → INSERT products_v2 + identifiers + price      │
│       + generate embedding (lokálně) + INSERT embedding             │
│                                                                       │
│  [5b] Změněné ceny → UPSERT product_price_v2                        │
│       WHERE current_price IS DISTINCT FROM new_price                │
│       Typicky: tisíce řádků, 1 index (PK)                           │
│                                                                       │
│  [5c] Změněný stock → v TRANSAKCI per batch:                        │
│       DELETE + INSERT product_branch_stock_v2                        │
│       (crash-safe: atomické per produkt)                             │
│                                                                       │
│  [5d] Změněná metadata → UPDATE products_v2                          │
│       (název, dodavatel, kategorie, status)                          │
│       → Pokud name/search_hints change: re-generate embedding       │
│                                                                       │
│  [5e] Zmizelé produkty → UPDATE products_v2 SET removed_at = now()  │
│       Znovu objevené → SET removed_at = NULL                         │
│                                                                       │
│  [5f] Log → INSERT import_batches_v2                                 │
│                                                                       │
│  [5g] ÚSPĚCH → mv new_csv → previous_csv (atomický rename)         │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.2 Odhad denního write load

#### Denní write load

| Změna | Odhadovaný count | Tabulka | Indexů dotčených |
|-------|-------------------|---------|-----------------|
| Změněné ceny | ~5-50K (odhad) | product_price_v2 | 1 (PK) |
| Změněný stock (v transakci per batch) | ~2-5K produktů, ~10K řádků | product_branch_stock_v2 | 2 (PK + branch) |
| Nové produkty | ~0-100 | products_v2 + vše | Plný insert |
| Změněný název | ~0-50 (vzácné) | products_v2 + embedding | Re-embedding |
| Změněný status (MSTAE/MSTAV) | ~0-500 | products_v2 | 1 update |
| Zmizelé produkty (removed_at) | ~0-100 | products_v2 | 1 update |
| Znovu objevené (removed_at→NULL) | ~0-10 | products_v2 | 1 update |
| **Celkem denní writes** | **~15-60K** | | |

#### Týdenní write load (navíc k dennímu)

| Změna | Odhadovaný count | Tabulka |
|-------|-------------------|---------|
| DISPO NE↔ANO | ~0-200 | products_v2 (is_stock_item) |
| EAN/IDNLF změny | ~0-500 | product_identifiers_v2 |
| MEINS změny | ~0-50 | products_v2 |

**Srovnání: Starý model by pro update cen dělal 50K × 10 indexů = 500K index updates.
Nový model: 50K × 1 index = 50K index updates. 10× méně.**

### 6.3 HTTP fetch + streaming parse

```typescript
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

interface SyncConfig {
  baseUrl: string;
  username: string;
  password: string;
}

async function fetchCsvFeed(
  config: SyncConfig,
  feedPath: string,
  tempPath: string,
): Promise<void> {
  const url = `${config.baseUrl}/${feedPath}`;
  const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');

  const response = await fetch(url, {
    headers: { 'Authorization': `Basic ${auth}` },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  await pipeline(
    Readable.fromWeb(response.body!),
    createWriteStream(tempPath),
  );
}
```

### 6.4 Klíčové SQL pro denní sync

```sql
-- [5b] Bulk upsert cen — JEN kde se cena skutečně liší
INSERT INTO product_price_v2 (product_id, current_price, batch_id)
SELECT unnest(:product_ids), unnest(:prices), :batch_id
ON CONFLICT (product_id) DO UPDATE SET
  current_price = EXCLUDED.current_price,
  batch_id = EXCLUDED.batch_id,
  updated_at = now()
WHERE product_price_v2.current_price IS DISTINCT FROM EXCLUDED.current_price;

-- [5c] Stock replace — v TRANSAKCI per batch (crash-safe)
-- Pro každý batch produktů se změněným stock_hash:
BEGIN;
  DELETE FROM product_branch_stock_v2
  WHERE product_id = ANY(:changed_stock_product_ids_batch);

  INSERT INTO product_branch_stock_v2 (product_id, branch_id, stock_qty, batch_id)
  SELECT unnest(:pids), unnest(:bids), unnest(:qtys), :batch_id;
COMMIT;
-- Batch size: ~500 produktů per transakce (balance atomicita vs lock time)

-- [5d] Metadata update — DENNĚ (název, dodavatel, kategorie, status)
UPDATE products_v2 SET
  name = :name,
  supplier_name = :supplier,
  category_code = :cat_code,
  category_main = :cat_main,
  category_sub = :cat_sub,
  category_line = :cat_line,
  status_purchase_code = :mstae,
  status_sales_code = :mstav,
  updated_at = now()
WHERE id = :product_id;
-- → Pokud name NEBO search_hints change: re-generate embedding

-- [5g] TÝDENNÍ: DISPO změna → update is_stock_item
UPDATE products_v2 SET
  dispo = :dispo,
  is_stock_item = :is_stock_item,
  updated_at = now()
WHERE id = :product_id AND (dispo IS DISTINCT FROM :dispo);

-- [5e] Zmizelé produkty — soft delete (historické nabídky zůstávají funkční)
UPDATE products_v2 SET removed_at = now(), updated_at = now()
WHERE source_matnr = ANY(:removed_matnrs) AND removed_at IS NULL;

-- Pokud se produkt znovu objeví v CSV (byl odstraněn omylem):
UPDATE products_v2 SET removed_at = NULL, updated_at = now()
WHERE source_matnr = ANY(:reappeared_matnrs) AND removed_at IS NOT NULL;
```

### 6.5 Stock hash pro efektivní porovnání

```typescript
import { createHash } from 'node:crypto';

function computeStockHash(stocks: Record<string, number>): string {
  const sorted = Object.entries(stocks)
    .filter(([, qty]) => qty > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (sorted.length === 0) return '';
  return createHash('md5')
    .update(JSON.stringify(sorted))
    .digest('hex');
}

// DB-side equivalent pro KROK 3:
// SELECT product_id,
//   md5(string_agg(b.source_branch_code || ':' || bs.stock_qty::text,
//                  ',' ORDER BY b.source_branch_code)) AS stock_hash
// FROM product_branch_stock_v2 bs
// JOIN branches_v2 b ON b.id = bs.branch_id
// GROUP BY product_id;
```

### 6.6 Nové WH_ sloupce (nové pobočky)

```typescript
function detectNewBranches(
  csvColumns: string[],
  existingCodes: Set<string>,
): string[] {
  const whCols = csvColumns.filter(c => c.startsWith('WH_'));
  return whCols.filter(code => !existingCodes.has(code));
}
// Nové pobočky → INSERT do branches_v2 (max. pár řádků, zanedbatelné)
```

### 6.7 Týdenní sync scope

> **Frekvence:** 1× týdně (víkendový cron, po denním syncu)
> **Princip:** Stejný CSV, ale porovnává navíc pole, která se denně přeskakují

Týdenní sync **rozšiřuje** denní o tyto kontroly:

| Pole | Akce pokud se liší |
|------|---------------------|
| **DISPO** | `UPDATE products_v2 SET dispo, is_stock_item` — pokud produkt přešel NE→ANO, poprvé se mu v dalším denním syncu začne kontrolovat stock |
| **EAN** | `DELETE + INSERT product_identifiers_v2 WHERE type = 'EAN'` |
| **IDNLF** | `DELETE + INSERT product_identifiers_v2 WHERE type = 'IDNLF'` |
| **MEINS** | `UPDATE products_v2 SET unit` |

**Proč ne denně:**
- DISPO se mění zřídka (desítky za týden)
- EAN/IDNLF se nemění téměř nikdy
- MEINS se nemění téměř nikdy
- Ušetříme denně porovnávání těchto polí pro 928K řádků

**Implementace:** Stejný TypeScript kód jako denní sync, ale s příznakem `weeklyMode: true`,
který zapne porovnávání těchto extra polí. Jede jako rozšíření denního — po denním syncu
ještě projede weekly diff a doplní změny.

```typescript
interface SyncOptions {
  weeklyMode: boolean;  // true = porovnávat i DISPO, EAN, IDNLF, MEINS
}

// V diff logice:
if (options.weeklyMode) {
  if (csvRow.dispo !== dbProduct.dispo) {
    changes.dispoChanged.push({ id: dbProduct.id, dispo: csvRow.dispo });
  }
  // + EAN, IDNLF, MEINS comparison...
}
```

---

## 7. RPC funkce pro nový model

### 7.1 Sémantický search

```sql
CREATE OR REPLACE FUNCTION search_products_v2_semantic(
  query_embedding     vector,
  max_results         integer DEFAULT 10,
  similarity_threshold double precision DEFAULT 0.5,
  manufacturer_filter text DEFAULT NULL,
  category_filter     text DEFAULT NULL,
  stock_item_only     boolean DEFAULT false,
  in_stock_only       boolean DEFAULT false,
  branch_code_filter  text DEFAULT NULL
)
RETURNS TABLE(
  id               bigint,
  sku              text,
  name             text,
  unit             text,
  current_price    numeric,
  supplier_name    text,
  category_main    text,
  category_sub     text,
  category_line    text,
  is_stock_item    boolean,
  has_stock        boolean,
  removed_at       timestamptz,
  cosine_similarity double precision
)
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
SET statement_timeout TO '10s'
AS $$
DECLARE
  safe_manufacturer text;
BEGIN
  -- Dynamic ef_search: stock filtry propustí jen ~3% kandidátů,
  -- potřebujeme prozkoumat více HNSW uzlů aby LIMIT dostal dost výsledků
  IF in_stock_only OR branch_code_filter IS NOT NULL THEN
    SET LOCAL hnsw.ef_search = 1000;
  ELSE
    SET LOCAL hnsw.ef_search = 200;
  END IF;

  -- Sanitize LIKE patterns (escape %, _, \)
  safe_manufacturer := replace(replace(replace(
    manufacturer_filter, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  SELECT
    p.id, p.sku, p.name, p.unit,
    pr.current_price,
    p.supplier_name,
    p.category_main, p.category_sub, p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs
            WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    (1 - (pe.embedding <=> query_embedding))::double precision AS cosine_similarity
  FROM product_embeddings_v2 pe
  JOIN products_v2 p ON p.id = pe.product_id
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  WHERE p.removed_at IS NULL
    AND (1 - (pe.embedding <=> query_embedding)) > similarity_threshold
    AND (manufacturer_filter IS NULL
         OR p.supplier_name ILIKE '%' || safe_manufacturer || '%')
    AND (category_filter IS NULL
         OR p.category_code = category_filter
         OR p.category_code LIKE category_filter || '%')
    AND (NOT stock_item_only OR p.is_stock_item = true)
    AND (NOT in_stock_only OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id
    ))
    AND (branch_code_filter IS NULL OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs
      JOIN branches_v2 b ON b.id = bs.branch_id
      WHERE bs.product_id = p.id
        AND b.source_branch_code = branch_code_filter
    ))
  ORDER BY pe.embedding <=> query_embedding
  LIMIT max_results;
END;
$$;

COMMENT ON FUNCTION search_products_v2_semantic IS
  'Tři úrovně stock filtru:
   stock_item_only = jen skladové položky (DISPO=ANO, příznak)
   in_stock_only = jen produkty reálně skladem kdekoliv (EXISTS on stock table)
   branch_code_filter = jen produkty skladem na konkrétní pobočce
   Dynamic ef_search: 200 (bez stock filtru) / 1000 (se stock filtrem)';
```

### 7.2 Fulltext search

```sql
CREATE OR REPLACE FUNCTION search_products_v2_fulltext(
  search_query        text,
  max_results         integer DEFAULT 20,
  manufacturer_filter text DEFAULT NULL,
  category_filter     text DEFAULT NULL,
  stock_item_only     boolean DEFAULT false,
  in_stock_only       boolean DEFAULT false,
  branch_code_filter  text DEFAULT NULL
)
RETURNS TABLE(
  id               bigint,
  sku              text,
  name             text,
  unit             text,
  current_price    numeric,
  supplier_name    text,
  category_main    text,
  category_sub     text,
  category_line    text,
  is_stock_item    boolean,
  has_stock        boolean,
  removed_at       timestamptz,
  rank             real,
  similarity_score real
)
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '5s'
AS $$
DECLARE
  sanitized       TEXT;
  safe_mfr        TEXT;
  ts_q            TSQUERY;
  ts_prefix       TSQUERY;
  prefix_str      TEXT;
BEGIN
  sanitized := trim(unaccent(search_query));
  sanitized := regexp_replace(sanitized, '([ABCDKZabcdkz])([0-9]+)[xX×]([0-9]+)',
    '\2P \1\3', 'g');
  ts_q := plainto_tsquery('public.cs_unaccent', sanitized);
  prefix_str := regexp_replace(
    trim(regexp_replace(sanitized, '\s+', ' ', 'g')),
    '(\S+)', '\1:*', 'g');
  prefix_str := replace(prefix_str, ' ', ' & ');
  BEGIN
    ts_prefix := to_tsquery('public.cs_unaccent', prefix_str);
  EXCEPTION WHEN OTHERS THEN
    ts_prefix := NULL;
  END;

  safe_mfr := replace(replace(replace(
    manufacturer_filter, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  WITH candidates AS (
    SELECT p.id FROM products_v2 p
    WHERE p.removed_at IS NULL
      AND (manufacturer_filter IS NULL
           OR p.supplier_name ILIKE '%' || safe_mfr || '%')
      AND (category_filter IS NULL
           OR p.category_code = category_filter
           OR p.category_code LIKE category_filter || '%')
      AND ((ts_q::TEXT <> '' AND p.search_vector @@ ts_q)
           OR (ts_prefix IS NOT NULL AND p.search_vector @@ ts_prefix))
    LIMIT max_results * 10
  )
  SELECT
    p.id, p.sku, p.name, p.unit,
    pr.current_price,
    p.supplier_name,
    p.category_main, p.category_sub, p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs
            WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    GREATEST(
      COALESCE(ts_rank_cd(p.search_vector, ts_q), 0),
      COALESCE(ts_rank_cd(p.search_vector, ts_prefix), 0) * 0.8
    )::REAL AS rank,
    GREATEST(
      similarity(p.name, sanitized),
      similarity(COALESCE(p.sku, ''), sanitized)
    )::REAL AS similarity_score
  FROM candidates c
  JOIN products_v2 p ON p.id = c.id
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  WHERE (NOT stock_item_only OR p.is_stock_item = true)
    AND (NOT in_stock_only OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id
    ))
    AND (branch_code_filter IS NULL OR EXISTS (
      SELECT 1 FROM product_branch_stock_v2 bs
      JOIN branches_v2 b ON b.id = bs.branch_id
      WHERE bs.product_id = p.id AND b.source_branch_code = branch_code_filter
    ))
  ORDER BY
    GREATEST(
      COALESCE(ts_rank_cd(p.search_vector, ts_q), 0),
      COALESCE(ts_rank_cd(p.search_vector, ts_prefix), 0) * 0.8
    ) DESC,
    GREATEST(
      similarity(p.name, sanitized),
      similarity(COALESCE(p.sku, ''), sanitized)
    ) DESC
  LIMIT max_results;
END;
$$;
```

### 7.3 Exact SKU / EAN / IDNLF lookup

```sql
CREATE OR REPLACE FUNCTION lookup_products_v2_exact(
  lookup_query text,
  max_results integer DEFAULT 20,
  include_removed boolean DEFAULT false
)
RETURNS TABLE(
  id bigint,
  sku text,
  name text,
  unit text,
  current_price numeric,
  supplier_name text,
  category_main text,
  category_sub text,
  category_line text,
  is_stock_item boolean,
  has_stock boolean,
  removed_at timestamptz,
  match_type text,
  matched_value text
)
LANGUAGE plpgsql
SET statement_timeout TO '5s'
AS $$
DECLARE
  sanitized text;
  safe_lookup text;
BEGIN
  sanitized := trim(unaccent(lookup_query));
  safe_lookup := replace(replace(replace(
    sanitized, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  WITH matches AS (
    -- 1) exact SKU
    SELECT p.id AS product_id, 1 AS priority, 'sku_exact'::text AS match_type, p.sku AS matched_value
    FROM products_v2 p
    WHERE p.sku = sanitized
      AND (include_removed OR p.removed_at IS NULL)

    UNION ALL

    -- 2) exact identifier (EAN / IDNLF)
    SELECT p.id AS product_id, 2 AS priority,
           lower(pi.identifier_type) || '_exact' AS match_type,
           pi.identifier_value AS matched_value
    FROM product_identifiers_v2 pi
    JOIN products_v2 p ON p.id = pi.product_id
    WHERE pi.identifier_value = sanitized
      AND (include_removed OR p.removed_at IS NULL)

    UNION ALL

    -- 3) contains fallback for identifier search
    SELECT p.id AS product_id, 3 AS priority,
           lower(pi.identifier_type) || '_contains' AS match_type,
           pi.identifier_value AS matched_value
    FROM product_identifiers_v2 pi
    JOIN products_v2 p ON p.id = pi.product_id
    WHERE length(sanitized) >= 6
      AND pi.identifier_value ILIKE '%' || safe_lookup || '%' ESCAPE '\'
      AND (include_removed OR p.removed_at IS NULL)
  ),
  ranked AS (
    SELECT DISTINCT ON (product_id)
      product_id, priority, match_type, matched_value
    FROM matches
    ORDER BY product_id, priority, length(matched_value)
  )
  SELECT
    p.id, p.sku, p.name, p.unit, pr.current_price, p.supplier_name,
    p.category_main, p.category_sub, p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    r.match_type,
    r.matched_value
  FROM ranked r
  JOIN products_v2 p ON p.id = r.product_id
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  ORDER BY r.priority, p.sku
  LIMIT max_results;
END;
$$;
```

### 7.4 Category tree

```sql
CREATE OR REPLACE FUNCTION get_category_tree_v2()
RETURNS TABLE(
  category_code text,
  category_name text,
  level smallint,
  parent_code text,
  product_count bigint
)
LANGUAGE sql STABLE
SET statement_timeout TO '5s'
AS $$
  SELECT
    c.category_code,
    c.category_name,
    c.level,
    c.parent_code,
    NULL::bigint AS product_count
  FROM product_categories_v2 c
  ORDER BY c.category_code;
$$;
```

### 7.5 Product detail pro nabídky (vrací i removed produkty)

```sql
CREATE OR REPLACE FUNCTION get_products_v2_by_ids(
  product_ids bigint[]
)
RETURNS TABLE(
  id               bigint,
  sku              text,
  name             text,
  unit             text,
  current_price    numeric,
  supplier_name    text,
  category_main    text,
  category_sub     text,
  category_line    text,
  is_stock_item    boolean,
  has_stock        boolean,
  removed_at       timestamptz,
  status_purchase_text text,
  status_sales_text    text
)
LANGUAGE sql STABLE
SET statement_timeout TO '5s'
AS $$
  SELECT
    p.id, p.sku, p.name, p.unit,
    pr.current_price,
    p.supplier_name,
    p.category_main, p.category_sub, p.category_line,
    p.is_stock_item,
    EXISTS (SELECT 1 FROM product_branch_stock_v2 bs
            WHERE bs.product_id = p.id) AS has_stock,
    p.removed_at,
    p.status_purchase_text,
    p.status_sales_text
  FROM products_v2 p
  LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
  WHERE p.id = ANY(product_ids);
$$;

COMMENT ON FUNCTION get_products_v2_by_ids IS
  'Pro zobrazení produktů v nabídkách. NEFILTRUJE removed_at — vrací i smazané produkty
   aby historické nabídky zůstaly funkční. Frontend zobrazí badge pro removed_at IS NOT NULL.';
```

---

## 8. Migrační strategie

### 8.1 Fáze

```
Fáze 1: DDL (vytvořit _v2 tabulky vedle stávajících)           ← žádný dopad na provoz
    │
    ▼
Fáze 2: Inicializační load (naplnit _v2 tabulky z CSV)        ← žádný dopad na provoz
    │
    ▼
Fáze 3: Embeddingy (vygenerovat 928K embeddingů)              ← žádný dopad na provoz
    │
    ▼
Fáze 4: Validace (SQL kontroly, sample checks)                ← žádný dopad na provoz
    │
    ▼
Fáze 5: HNSW index (build ~5-10 min)                          ← žádný dopad na provoz
    │
    ▼
Fáze 6: Testovací search RPC (nové funkce _v2)                ← žádný dopad na provoz
    │
    ▼
Fáze 7: Cutover (přepnout backend kód na _v2 tabulky)         ← PŘEPNUTÍ
    │
    ▼
Fáze 8: Stabilizace (monitorování, ověření)                   ← 1-2 dny
    │
    ▼
Fáze 9: Cleanup (archivace starých tabulek)                   ← po stabilizaci
```

### 8.2 Cutover plan

1. **Backend kód:** Změnit `search.ts` — přepnout na nové RPC funkce (`search_products_v2_semantic`, `search_products_v2_fulltext`)
2. **Frontend typy:** Upravit `Product` interface — nové sloupce (`supplier_name` místo `manufacturer`, přidat `has_stock`, `current_price` z joinu)
3. **Import skripty:** Nové `scripts/import-v2.ts` a `scripts/daily-update-v2.ts`
4. **Offer items:** Nové nabídky → FK na `products_v2.id`. Staré nabídky zůstávají napojené na starou `products` tabulku.

### 8.3 Co se NEDĚJE při cutoveru

- Staré tabulky se NEMAŽOU
- Staré RPC funkce se NEMAŽOU
- Staré offer_items FK se NEPŘEPOJUJE
- Stará data zůstávají pro audit

---

## 9. Validační dotazy

### 9.1 Po inicializačním loadu

```sql
-- Počty
SELECT 'products_v2' AS tbl, count(*) FROM products_v2
UNION ALL SELECT 'product_price_v2', count(*) FROM product_price_v2
UNION ALL SELECT 'product_branch_stock_v2', count(*) FROM product_branch_stock_v2
UNION ALL SELECT 'product_identifiers_v2', count(*) FROM product_identifiers_v2
UNION ALL SELECT 'product_categories_v2', count(*) FROM product_categories_v2
UNION ALL SELECT 'branches_v2', count(*) FROM branches_v2
UNION ALL SELECT 'customers_v2', count(*) FROM customers_v2
UNION ALL SELECT 'status_types_v2', count(*) FROM status_types_v2;

-- Očekávané hodnoty:
-- products_v2:              927 893
-- product_price_v2:         ~889 305 (95% má cenu > 0)
-- product_branch_stock_v2:  ~131 800 (jen kladné zásoby)
-- product_identifiers_v2:   ~1 050 000 (EAN + IDNLF, multi-value)
-- product_categories_v2:    534
-- branches_v2:              23
-- customers_v2:             ~147 218
-- status_types_v2:          ~25

-- Kontrola FK integrity
SELECT 'orphan prices' AS chk, count(*)
FROM product_price_v2 pr
LEFT JOIN products_v2 p ON p.id = pr.product_id
WHERE p.id IS NULL

UNION ALL

SELECT 'orphan stock', count(*)
FROM product_branch_stock_v2 bs
LEFT JOIN products_v2 p ON p.id = bs.product_id
WHERE p.id IS NULL

UNION ALL

SELECT 'orphan identifiers', count(*)
FROM product_identifiers_v2 pi
LEFT JOIN products_v2 p ON p.id = pi.product_id
WHERE p.id IS NULL;

-- Náhodný vzorek: ověřit proti CSV
SELECT p.source_matnr, p.sku, p.name, p.supplier_name,
       pr.current_price, p.category_main, p.category_sub,
       p.status_purchase_code, p.status_purchase_text
FROM products_v2 p
LEFT JOIN product_price_v2 pr ON pr.product_id = p.id
ORDER BY random()
LIMIT 10;

-- Počet produktů se stockem (pro ověření)
SELECT count(DISTINCT product_id) AS products_with_stock
FROM product_branch_stock_v2;
-- Očekávaná hodnota: ~27 005
```

---

## 10. Odhad velikosti a výkonu

### 10.1 Velikost tabulek

| Tabulka | Řádky | Odhad velikosti |
|---------|-------|-----------------|
| products_v2 | 928K | ~500 MB (text heavy) |
| product_price_v2 | 889K | ~30 MB (úzká) |
| product_branch_stock_v2 | 132K | ~5 MB (sparse!) |
| product_identifiers_v2 | ~1M | ~40 MB |
| product_embeddings_v2 | 928K | ~1 GB (256-dim vectors) |
| customers_v2 | 147K | ~15 MB |

**Celkem: ~1.55 GB** (vs ~1.2 GB dnes, ale lépe strukturováno, méně write load)

### 10.2 Denní write load (po oddělení)

| Operace | Dnes (monolith) | Nově |
|---------|-----------------|------|
| Update ceny (889K) | 889K × 10 indexů + search_vector rebuild | 889K × 1 index (PK) |
| Update skladu (132K) | N/A | 132K řádků DELETE+INSERT (transakcemi) |
| **Celkový IO** | **~8.9M index updates** | **~1.1M index updates** |

**Snížení write IO o ~88%** oddělením ceny + zrušením stock summary.

---

## 11. Otevřené body

### Vyřešeno
- ~~MATNR → SKU mapping~~ → Strip leading zeros, potvrzeno
- ~~DISPO~~ → Skladová položka (ANO/NE), přidáno `is_stock_item` (příznak, ne skutečný stav skladu)
- ~~SPERR/LOEVM~~ → Uložit surové hodnoty, neinterpretovat
- ~~active flag~~ → Nahrazeno `removed_at timestamptz` (NULL = aktuální, non-NULL = kdy zmizel z CSV)
- ~~Embeddingy~~ → Připravit lokálně do JSONL, jeden bulk write do DB, batch 2048
- ~~Statusy~~ → Ukládáme přeložené (kód + text z lookup), žádná interpretace active/inactive
- ~~Stock scope~~ → Stock diff pro VŠECHNY produkty denně, 900K+ má hash='' → instant porovnání
- ~~Mazání produktů~~ → Soft delete (removed_at), historické nabídky zůstávají funkční (RPC `get_products_v2_by_ids`)
- ~~Search hints~~ → Sloupec `search_hints`, admin-managed, zahrnut do search_vector (A) i embeddingu, změna → re-embedding
- ~~Stock summary tabulka~~ → ODSTRANĚNA. Nahrazeno EXISTS na `product_branch_stock_v2` (PK = product_id → O(log n)). Ušetří 928K řádků + dvojitý zápis
- ~~Staging tabulka~~ → ODSTRANĚNA. File-to-file comparison místo DB staging. Předchozí CSV na disku
- ~~Identifiers UNIQUE~~ → Fix: `UNIQUE(product_id, type, value)` — více produktů může sdílet EAN
- ~~ON DELETE~~ → RESTRICT všude. Soft delete = hard delete zakázán
- ~~Neznámé kategorie~~ → Auto-add v Phase A s `'Neznámá kategorie'`. FK zůstává
- ~~File-to-file sync~~ → Denní diff porovnává two CSV soubory lokálně. Jediný DB read = `SELECT id, source_matnr` pro ID resolution
- ~~Crash safety~~ → Stock writes v transakcích per batch. CSV rename po úspěchu = self-healing
- ~~Dynamic ef_search~~ → 200 (bez stock filtru) / 1000 (se stock filtrem). Pokrývá fakt, že jen 2.9% má stock
- ~~EAN search~~ → Přes `product_identifiers_v2` (indexed exact match) místo ILIKE na source_ean_raw (seq scan)
- ~~LIKE injection~~ → Sanitizace `%`, `_`, `\` v manufacturer_filter

### Otevřeno
1. **Encoding**: `matnr_dispo_info` = cp1250, ostatní CSVs = latin-1 hybrid. Parser musí fallbackovat.
2. **Branch names**: Jen WH_#### kódy. Názvy poboček doplnit později.
3. **Denní update customers**: Frekvence? customer_info stahovat týdně? Nebo denně?
4. **SUPABASE_DB_URL**: Máme přímý Postgres přístup pro COPY? Nebo jdeme přes REST API?
5. **DISPO garbage data**: 30 řádků má v DISPO hodnoty jako kódy kategorií — ignorovat (isStockItem → false).
6. **HTTP endpoint URLs**: Zatím neznáme. Formát CSV zůstane stejný.
7. **HTTP auth credentials**: Basic auth — kam uložit? `.env` / Supabase vault?
8. **Lookup feeds frekvence**: status_type a name_of_category stahovat denně nebo týdně?
9. **Cron scheduling**: Jaký čas noční sync? Musí se koordinovat s jinými procesy?
10. **File-to-file storage**: `data-model/sync/` složka pro CSV soubory — persistentní úložiště na serveru?
11. **Paměťové požadavky**: Denní sync potřebuje ~200 MB RAM (2× CSV map + ID map). Dostatečné pro backend server?

---

## 12. Aktuální rollout stav a test plan

### 12.1 Aktuální stav DB rolloutu

- `products_v2`, `product_identifiers_v2`, `product_price_v2`, `product_branch_stock_v2`, `customers_v2`, `product_embeddings_v2` jsou naplněné
- `search_vector` je dopočítaný pro `products_v2` i `customers_v2`
- Sekundární indexy mimo HNSW jsou vytvořené
- Stará tabulka `product_embeddings` byla odstraněna kvůli místu na disku
- **NENÍ hotovo:** HNSW index na `product_embeddings_v2`
- **NENÍ hotovo:** triggery a RPC funkce pro `_v2`

### 12.2 Co jsme se naučili z reálného běhu

- HNSW build přes Node + pooler byl náchylný na `ECONNRESET`
- HNSW build s `statement_timeout = '7200s'` skončil v Postgres logu na `statement timeout`
- Progress HNSW je potřeba sledovat přes `pg_stat_progress_create_index`, ne přes velikost indexu na disku
- Při běhu s `maintenance_work_mem = '512MB'` PostgreSQL zahlásil:
  `NOTICE: hnsw graph no longer fits into maintenance_work_mem after 312185 tuples`
- Závěr: build funguje, ale po překročení RAM limitu se výrazně zpomalí a víc zatěžuje disk IO

### 12.3 Bezpečný postup pro HNSW

1. Spouštět HNSW jako **samostatný krok**, ne jako součást celé post-fáze
2. Preferovat `psql` před Node skriptem pro dlouhý admin job
3. Preferovat **direct connection**; pokud z aktuálního prostředí není dostupná, použít session pooler jako fallback
4. Používat oficiální pgvector defaulty:
   - `m = 16`
   - `ef_construction = 64`
5. Progres sledovat přes `pg_stat_progress_create_index`
6. Triggery a RPC vytvářet až **po úspěšném dokončení HNSW**

### 12.4 Proč jsou `m = 16` a `ef_construction = 64` v pořádku

- Jsou to výchozí / doporučené hodnoty pgvectoru pro kvalitní HNSW index
- Nejde o low-quality fallback
- Oproti `m = 24`, `ef_construction = 200` mají výrazně nižší build cost a IO nároky
- Kvalitu query výsledků pak lze dále ladit přes `hnsw.ef_search` bez rebuildu indexu

### 12.5 Query-time tuning po dokončení indexu

- `hnsw.ef_search` je **query-time** parametr
- Nemění index, jen kolik kandidátů se při dotazu prohledá
- Doporučený start:
  - bez stock filtru: `hnsw.ef_search = 200`
  - s `in_stock_only` / `branch_code_filter`: `hnsw.ef_search = 800-1000`

### 12.5a Routing search dotazů

- **Exact lookup (`lookup_products_v2_exact`)**:
  - použít pro konkrétní SKU
  - použít pro EAN / IDNLF
  - exact match má prioritu, contains fallback je jen doplněk pro identifier search
- **Fulltext (`search_products_v2_fulltext`)**:
  - použít jen pro textové hledání
  - nemá v sobě exact SKU/EAN `OR` logiku, aby se planner nepropadal do seq scanu
- **Semantic (`search_products_v2_semantic`)**:
  - použít pro embedding/hybrid vrstvu

### 12.5b Category tree pro AI

- `get_category_tree_v2()` vrací čistou hierarchii kategorií
- `product_count` je záměrně `NULL`
- důvod: AI potřebuje strom pro orientaci, ne live agregaci nad ~928K produkty
- tím se vyhneme zbytečnému full scanu `products_v2` při každém načtení stromu

### 12.6 Monitoring SQL

Soubor: `data-model/hnsw-monitor.sql`

Klíčový dotaz pro HNSW progress:

```sql
SELECT
  pid,
  phase,
  round(100.0 * blocks_done / nullif(blocks_total, 0), 1) AS progress_pct,
  blocks_done,
  blocks_total,
  tuples_done,
  now() - (
    SELECT query_start
    FROM pg_stat_activity
    WHERE pid = pg_stat_progress_create_index.pid
  ) AS running_for
FROM pg_stat_progress_create_index;
```

### 12.7 Test plan po dokončení HNSW

#### A. Strukturní validace

1. Ověřit existenci indexu `idx_pe_v2_hnsw`
2. Ověřit vytvoření triggerů:
   - `products_v2_search_vector_update`
   - `customers_v2_search_vector_update`
3. Ověřit vytvoření RPC funkcí:
   - `search_products_v2_semantic`
   - `search_products_v2_fulltext`
   - `get_category_tree_v2`
   - `get_products_v2_by_ids`

#### B. SQL smoke testy

1. `EXPLAIN ANALYZE` pro semantic search bez stock filtru
2. `EXPLAIN ANALYZE` pro semantic search s `in_stock_only = true`
3. `EXPLAIN ANALYZE` pro semantic search s `branch_code_filter`
4. `EXPLAIN ANALYZE` pro fulltext hledání podle SKU
5. `EXPLAIN ANALYZE` pro fulltext hledání podle EAN / IDNLF

#### C. Funkční testy vyhledávání

1. Přesná shoda SKU vrací správný produkt na top pozici
2. Přesná shoda EAN vrací správný produkt
3. Částečný název vrací relevantní fulltext výsledky
4. Semantic search vrací relevantní podobné produkty
5. Semantic search se stock filtrem vrací jen produkty se skladem
6. Semantic search s branch filtrem vrací jen produkty skladem na dané pobočce

#### D. Historie / removed testy

1. `get_products_v2_by_ids()` vrací i removed produkt
2. Search RPC nevrací produkty s `removed_at IS NOT NULL`
3. Frontend umí zobrazit removed badge pro historický produkt v nabídce

#### E. Výkonové testy

1. Semantic search bez stock filtru: p95 target pod 500 ms
2. Semantic search se stock filtrem: p95 target pod 1 s
3. Fulltext search: p95 target pod 300 ms
4. Zkontrolovat, že query používají správné indexy a nejdou do nečekaných seq scanů

---

## 13. Vylepšení pipeline a UX — implementační plán

> **Datum:** 22. 3. 2026 | **Status:** V1 — plánování
>
> Postup: backend first → test → frontend. Každá fáze se testuje samostatně.

### 13.1 FÁZE 1: Pre-search konfigurace a typ nabídky

**Cíl:** Uživatel nastaví typ nabídky (výběrko/realizace) a preference hledání.
Parametry protečou celým pipeline do RPCs.

#### Datový model

```typescript
type OfferType = "vyberko" | "realizace";

interface SearchPreferences {
  offerType: OfferType;
  stockFilter: "any" | "in_stock" | "stock_items_only";
  branchFilter: string | null;
  priceStrategy: "lowest" | "standard";
}
```

#### Backend změny (IMPLEMENTOVÁNO)

- `searchPipeline.ts`: Nový typ `SearchPreferences`, `DEFAULT_PREFERENCES`
- `searchPipelineForItem` rozšířen o `preferences?: SearchPreferences`
- `prefsToStockOpts()` konvertuje preferences → `StockFilterOptions` pro RPCs
- `evaluate()` přijímá preferences → přidává `offerContext` do LLM payload
- `EVAL_PROMPT` rozšířen o sekci "Kontext nabídky"
- `search.ts`: Nový `StockFilterOptions` interface, fulltext + semantic wrappery rozšířeny
- `agent/index.ts`: `createOfferAgentStreaming` přijímá `searchPreferences`
- `agent.ts`: Endpointy `/agent/offer-chat`, `/agent/search`, `/agent/search-semantic` přijímají `searchPreferences`

#### SQL RPCs (již implementováno)

Parametry `stock_item_only`, `in_stock_only`, `branch_code_filter` jsou v RPCs od začátku — teď se konečně volají z kódu.

#### Frontend (TODO)

- Rozšířit `OfferHeader` o `searchPreferences`
- `OfferHeaderForm` — sekce "Parametry hledání"
- `OfferHeaderSummary` — badgy pro aktivní preference
- `OfferDetailClient` → propagace preferences do API callů

#### Testy

1. Pipeline s `stockFilter: "in_stock"` → vrací jen produkty se skladem
2. Pipeline s `branchFilter: "WH_0101"` → vrací jen produkty na dané pobočce
3. Pipeline s `offerType: "vyberko"` → reasoning zmiňuje nejnižší cenu
4. Pipeline bez preferences → chová se jako dosud (backward compatible)

---

### 13.2 FÁZE 2: Intelligent Planning Agent (seskupování)

**Cíl:** Po parsování a PŘED hledáním AI analyzuje VŠECHNY položky, seskupí dle kategorií,
navrhne výrobce/řadu, obohatí instrukce.

#### Architektura

```
ParsedItems[] → Planning LLM → SearchPlan { groups[] }
  → User review (optional) → enriched instructions
  → process_items → parallel pipeline × N
```

#### Backend

- Nová funkce `createSearchPlan(items, preferences, categoryTree)` v `searchPipeline.ts`
- Nový endpoint `POST /agent/search-plan`
- Planning Agent prompt: seskupení dle MATKL, výrobce/řada/barva per skupina
- Enrichment: `instruction = "Preferuj výrobce: X, řada: Y, barva: Z"`

#### Frontend

- Nová fáze `"planning"` v `OfferPhase`
- Komponent `SearchPlanPanel` — karty dle kategorií, editovatelný výrobce
- Flow: parsed → planning → processing

---

### 13.3 FÁZE 3: Unit handling, cable logika, bug fixy

#### Bug: Tisícovky ("1.000" → 1)

```typescript
function parseNumberCzech(s: string): number | null {
  const trimmed = s.trim();
  const cleaned = trimmed
    .replace(/\.(\d{3})/g, '$1')   // tečka + 3 cifry = tisíce
    .replace(',', '.');             // čárka = desetinný oddělovač
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}
```

#### Bug: "kabel CYSY 361" nenalezen

- Rozšířit `REFORM_PROMPT` o expandování zkrácených zápisů průřezů kabelů

#### Cable metráž

- `EVAL_PROMPT` posílit: nejnižší násobek balení, BUBEN pro přesnou metráž
- KB→M převodní tabulka (dodá uživatel)

#### EAN/kód feedback

- `PipelineResult` rozšířit o `exactLookupAttempted`, `exactLookupFound`

---

### 13.4 FÁZE 4: Complex Product Assembly (sady)

**Cíl:** Vypínač = rámeček + mechanismus + kryt. Detekce v Planning Agent.

#### Backend

- Planning Agent identifikuje "set" položky (`isSet: true, components[]`)
- `searchPipelineForSet(parent, components[], manufacturer, position, ...)`
- `SetPipelineResult { parentPosition, parentName, components[], totalPrice }`

#### Frontend

- ResultsTable: rodičovská řádka + indentované sub-řádky pro komponenty

---

### 13.5 FÁZE 5: UX vylepšení

- **Drag & Drop** pro řazení položek (`@dnd-kit/sortable`)
- **Insert mezi řádky** — "+" zóna mezi řádky
- **Copy SAP code** — clipboard icon na SKU
- **Reasoning log** — info ikona per řádek s reasoning, matchType, confidence
- **Alternativy seřazení** dle míry splnění
- **100% match** → žádné extra doporučení
- **Manual položka** s volbou pozice

---

### 13.6 FÁZE 6: Standalone search modul

- `POST /agent/standalone-search` — pipeline bez vazby na nabídku
- Nová stránka `/search` — chat + výsledky
- Navigace v Header.tsx

---

### 13.7 FUTURE (po implementaci)

- Porovnání podobných nabídek napříč tenantem
- Personalizace pro uživatele
- Export do SAP (manual import / auto přes mail)
