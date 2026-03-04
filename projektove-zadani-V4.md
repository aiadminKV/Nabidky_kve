# KV Elektro – Projektové zadání (Varianta V4)
> **Verze:** 1.1 | **Datum:** 18. 2. 2026 | **Status:** Draft

---

## 1. Kontext a cíl projektu

KV Elektro je firma operující v B2B segmentu s rozsáhlým produktovým katalogem (statisíce SKU). Zaměstnanci dnes manuálně zpracovávají poptávky a objednávky, které přicházejí v různých formátech – neformátované e-maily, obrázky, PDF soubory. Cílem projektu je tuto rutinní práci automatizovat pomocí AI agenta.

**Klíčové problémy, které projekt řeší:**
- Poptávky přicházejí v nestrukturované formě (e-maily, obrázky, různé formáty)
- Ruční dohledávání produktů v katalogu je zdlouhavé a náchylné k chybám
- Výsledek musí být kompatibilní se stávajícím SAPem (nahrání přes Excel)

**Výsledkem projektu je** webová aplikace s AI agentem, který přijme vstup od uživatele (poptávka / technická specifikace), automaticky vyhledá odpovídající produkty v databázi a vrátí strukturovaný výstup připravený k nahrání do SAPu.

---

## 2. Zvolená varianta – V4 (Advanced Pro-Code)

Zákazník zvolil nejvyšší variantu, která kombinuje:
- **Pro-code custom frontend** integrující OpenAI ChatKit + AgentKit + Widgety jako UI vrstvu (ne hosted řešení, ale vlastní implementace)
- **OpenAI Agents SDK (TypeScript)** jako agentní runtime a orchestrátor – veškerá logika agenta, volání nástrojů (tools) a komunikace s LLM běží přímo přes OpenAI API bez prostředníka
- **Node.js backend (TypeScript) na Railway** jako runtime prostředí pro agenta – zvolen kvůli absenci timeout limitů (agentní run může trvat desítky sekund)
- **Supabase** jako backend pro autorizaci, databázi a vektorové vyhledávání

---

## 3. Technologický stack

### 3.1 Frontend
| Vrstva | Technologie | Poznámka |
|---|---|---|
| Jazyk | TypeScript | Sjednocený jazyk napříč celým stackem |
| UI framework | Next.js (React) | Pro-code implementace |
| AI Chat rozhraní | OpenAI ChatKit + AgentKit + Widgety | Vlastní integrace, ne hosted widget |
| Autorizace (UI) | Supabase Auth JS SDK | Login, JWT session management |
| Hosting frontendu | Railway | Stejná platforma jako backend, jeden deployment projekt |

### 3.2 Backend & Agent runtime
| Vrstva | Technologie | Poznámka |
|---|---|---|
| Jazyk | TypeScript (Node.js) | Sjednocený s frontendem |
| Agentní orchestrace | OpenAI Agents SDK (`@openai/agents`) | Nativní tool calling, streaming přes SSE |
| Backend framework | Hono | Moderní, rychlý TypeScript framework, ideální pro streaming |
| Hosting | Railway | Perzistentní server – žádné timeout limity, plná flexibilita |
| Autorizace | Supabase Auth (server-side JWT ověření) | RLS políčky na úrovni DB |
| Produktová DB | Supabase PostgreSQL + PGVector | Hybridní SQL + vektorové vyhledávání |

> **Poznámka k architektuře:** LLM reasoning (GPT-4o) běží na OpenAI serverech. Railway obsluhuje agentní loop koordinátor, tool execution (Supabase dotazy, XLSX generování) a streaming výsledků zpět do frontendu přes SSE. Zvolený přístup zajišťuje maximální flexibilitu bez serverless timeout omezení.

### 3.3 AI & OpenAI vrstva
| Vrstva | Model | Použití | Poznámka |
|---|---|---|---|
| Agentní běhy (komplexní) | GPT-5.1 | Parsování poptávek, iterace přes položky, rozhodovací logika, výběr z kandidátů | Adaptivní reasoning, dynamicky přizpůsobuje hloubku přemýšlení dle složitosti |
| Rychlé / jednoduché úlohy | GPT-4.1 | Dekompozice dotazu na klíčová slova, klasifikace vstupu, pomocné kroky | Bez reasoningu – nižší latence, nižší cena; dostupný přes API |
| Vision / OCR | GPT-5.1 | Extrakce textu z obrázků a PDF | Přes Agents SDK file input |
| Embeddings | `text-embedding-3-large` | Generování vektorů pro sémantické vyhledávání | 3072 dimenzí |

> **Poznámka k modelům:** GPT-4.1 byl v únoru 2026 odstraněn z ChatGPT UI, ale přes OpenAI API je nadále plně dostupný – náš projekt používá výhradně API integraci, takže bez dopadu.

---

## 4. Architektura agenta

### 4.1 Jádro agenta – jedna sdílená logika

Agent má **jedno jádro pro vyhledávání produktů**, které se volá ve dvou různých kontextech:

```
[Kontext A] Zpracování nabídky/poptávky
  → Parsování vstupního textu
  → Extrakce položek (název + množství)
  → Iterace přes položky → vyhledávání jádra

[Kontext B] Přímý dotaz na produkt
  → Uživatel zadá technické parametry / název
  → Přímé volání vyhledávacího jádra
```

### 4.2 Procesní flow – Kontext A (zpracování poptávky)

Flow je **dvoukolový**: nejprve agent autonomně zpracuje a vyhledá vše co zvládne, pak uživatel interaktivně dořeší nejisté položky.

```
── FÁZE 1: Automatické zpracování (bez zásahu uživatele) ──────────────────

1. Uživatel nahraje vstup
   ├── Text (copy-paste z e-mailu nebo jiného textového zdroje)
   ├── Tabulka z Excelu (copy-paste buněk přímo do rozhraní – vstup přijde jako TSV/plain text)
   ├── Obrázek (PNG, JPG – výřez z dokumentu)
   └── PDF soubor
   ⚠️ Upload .xlsx souboru není podporován – uživatel obsah zkopíruje a vloží

2. OCR / extrakce textu (OpenAI Vision API – GPT-4o)
   └── Z obrázku nebo PDF se extrahuje čistý text

3. Parsování položek (LLM)
   └── Agent identifikuje seznam položek
       Každá položka = { název_produktu, množství }
   → Položky se průběžně zobrazují v UI (živý status parsování)

4. Iterace přes položky – pro každou položku:
   └── Volání vyhledávacího jádra (viz 4.3)
   → Výsledek = { produkt, confidence_score, typ: shoda | alternativa | nenalezeno }
   → Každá položka okamžitě zobrazí svůj stav v UI tabulce

── FÁZE 2: Interaktivní review (uživatel dořeší nejisté položky) ───────────

5. Uživatel vidí tabulku všech položek se stavovými indikátory (viz 6.3)
   ├── Položky s confidence ≥ 99 % → produkt ID doplněno automaticky, bez zásahu
   ├── Položky s nižší jistotou, více kandidáty nebo alternativou → vyžadují review
   └── Nenalezené položky → vyžadují ruční řešení

6. Uživatel klikne na položku vyžadující review → otevře se modal (viz 6.4)
   └── V modalu uživatel:
       ├── Vybere správný produkt ze seznamu kandidátů (filtrovat dle dostupnosti)
       ├── Vyhledá jiný produkt manuálně (fulltext v modalu)
       └── Ručně zadá ID produktu ze SAPu

7. Po dokončení review → uživatel potvrdí výběr

── FÁZE 3: Export ─────────────────────────────────────────────────────────

8. Generování výstupu
   └── Soubor XLSX / CSV připravený pro import do SAPu
       ├── Nalezené a potvrzené položky (shoda + uživatelsky vybrané)
       └── Alternativy vizuálně odlišeny (sloupec "typ_shody")
```

### 4.3 Procesní flow – Vyhledávací jádro (sdílené)

Vyhledávání funguje na principu **našeptávače** – vrací ranked seznam kandidátů seřazených dle relevance (nejvíce match → nejméně), ze kterého agent následně dovybere finální produkt. Sémantické vyhledávání slouží jako záchranná síť pro alternativy.

```
Vstup: vyhledávací dotaz (název produktu nebo technické parametry)

1. Dekompozice dotazu na klíčová slova (LLM)

2. Hybridní vyhledávání v Supabase – fáze 1 (přesná shoda)
   ├── SQL fulltext search (přesná shoda klíčových slov)
   └── Skórování a seřazení výsledků dle relevance (ranked list)
   → Výstup: TOP N kandidátů seřazených sestupně dle shody

3. AI výběr z kandidátů (LLM)
   └── Agent dostane ranked seznam a dovybere nejlepší shodu
       dle kontextu: cena, dostupnost, technické parametry dotazu
       → Pokud agent vybere shodu s dostatečnou jistotou → KONEC

4. Sémantické vyhledávání – fáze 2 (alternativy, pouze pokud fáze 1 selže)
   └── PGVector embedding similarity search
   → Hledá produkty s podobným významem / parametry (jiný výrobce, náhrada)
   → Agent označí výsledek jako "alternativa" (ne přesná shoda)

5. Fallback
   └── Pokud ani fáze 2 nenajde relevantní výsledek →
       produkt zařazen do seznamu nenalezených položek

Výstup: { produkt_id, název, kód, cena, dostupnost, confidence_score, typ: "shoda" | "alternativa" | "nenalezeno" }
```

### 4.4 Procesní flow – Kontext B (přímý chat dotaz)

```
1. Uživatel zadá dotaz v chat rozhraní (ChatKit)
   Příklad: "Najdi mi jistič 3-pólový 16A typ B"

2. Agent zpracuje dotaz → volání vyhledávacího jádra

3. Výsledky zobrazeny v chat UI (Widgety / strukturované karty)

4. Uživatel může upřesnit dotaz nebo potvrdit výběr

5. Volitelně → export do XLSX
```

---

## 4.5 Spolehlivost parsování a validace uživatelem

> **Klíčová designová priorita:** AI dělá chyby. Uživatel musí být schopen rychle a jednoznačně ověřit, zda agent správně rozpoznal všechny položky – ještě *před* vyhledáváním. Chyba v parsování znamená chybný výstup i při 100% přesnosti vyhledávání.
>
> **Důležitá nuance:** Riziko parsovacích chyb roste s počtem položek. U malých poptávek (jednotky až nízké desítky položek) AI pracuje spolehlivě a uživatel výsledek snadno zkontroluje. Kritické se to stává u **rozsáhlých poptávek s velkým množstvím položek** – tam je vyšší pravděpodobnost chyby a ruční kontrola je časově náročná. Právě pro tyto případy jsou validační krok a Excel copy-paste nejdůležitější.

### Problém: parsování nestrukturovaného vstupu

Při zpracování e-mailu, obrázku nebo PDF musí AI nejprve **rozpoznat seznam položek** (název + množství) z volného textu. Tato fáze je nejrizikovější:
- Položky mohou být špatně odděleny, zkráceny nebo sloučeny
- Množství může být přiřazeno k nesprávné položce
- Zkratky a odborné názvy mohou být špatně interpretovány

### Doporučená mitigace: Excel jako primární a nejspolehlivější vstup

Pokud uživatel vkládá obsah z Excelu (copy-paste TSV), **parsování AI není potřeba** – rozhraní zpracuje strukturovaná data přímo na úrovni UI (sloupce = pole, řádky = položky). Tím se zcela eliminuje riziko chybné extrakce.

```
Excel copy-paste (TSV)  →  UI parser (deterministický)  →  položky rovnou do vyhledávání
                                    ↑
                            žádné AI parsování,
                            žádná chyba extrakce
```

**Doporučení pro zákazníka:** Kdykoliv je to možné, preferovat vstup přes Excel copy-paste jako nejjistější cestu.

### Validační krok – povinná zastávka před vyhledáváním

Po parsování vstupu (ať už AI nebo UI parserem) se uživateli zobrazí **mezikrok: seznam rozpoznaných položek ke schválení** – ještě před spuštěním vyhledávání.

```
Vstup → [Parsování] → ✋ VALIDAČNÍ KROK → [Vyhledávání] → Review → Export
                           ↑
              Uživatel vidí seznam položek:
              "Toto agent rozpoznal – je to správně?"
              Může přidat / odebrat / opravit položku
              Teprve pak potvrdí spuštění vyhledávání
```

Tím se zabraňuje tomu, aby chyba z parsování "probublala" celým flow a uživatel ji zjistil až na konci.

### Ostatní mitigace parsovacích chyb (pro unstrukturované vstupy)

| Přístup | Popis | Dopad na výkon |
|---|---|---|
| **Validační krok (doporučeno)** | Uživatel schválí seznam položek před vyhledáváním | Minimální – 1 klik pro potvrzení |
| Sekvenční extrakce | Agent extrahuje položky jednu po druhé s vyšší přesností | Mírně pomalejší |
| Multi-agent konsenzus | 3 agenti parsují nezávisle, výsledek se porovná | 3× dražší a pomalejší – pouze jako fallback pro kritické případy |

---

## 5. Datová vrstva

### 5.1 Produktová databáze

**Struktura tabulky (návrh):**
```sql
products (
  id            UUID PRIMARY KEY,
  sku           TEXT UNIQUE,
  name          TEXT,                -- full název produktu
  description   TEXT,               -- technický popis
  category      TEXT,
  parameters    JSONB,              -- technické parametry (A, V, typ, ...)
  price         NUMERIC,
  availability  TEXT,
  embedding     VECTOR(3072),       -- OpenAI text-embedding-3-large (3072 dimenzí)
  updated_at    TIMESTAMPTZ
)
```

### 5.2 Počáteční naplnění databáze

- Data budou nahrána **jednorázově při launchi** ze strukturovaného CSV/Excel souboru od zákazníka
- Součástí projektu je **importní skript**, který:
  1. Načte a validuje vstupní data
  2. Vygeneruje embeddingy pro každý produkt (OpenAI API)
  3. Nahraje záznamy do Supabase

### 5.3 Mechanismus aktualizací

Bude vytvořen jednoduchý aktualizační TypeScript skript (spouštěný manuálně nebo na schedule), který:
- Porovná nový soubor ceníku se stávajícím stavem v DB
- Identifikuje záznamy ke **smazání** (v novém ceníku chybí)
- Identifikuje záznamy k **přidání** (nové položky)
- Identifikuje záznamy k **aktualizaci** (změna ceny/parametrů)
- Automaticky přegeneruje embeddingy pro změněné záznamy

> **Poznámka:** Frekvenční aktualizace (denní / týdenní / na vyžádání) se domluví se zákazníkem. Admin UI pro správu DB není v současném scopu.

---

## 6. Uživatelské rozhraní

### 6.1 Autorizace
- Přihlášení přes e-mail + heslo (Supabase Auth)
- JWT session management
- RLS (Row Level Security) na úrovni Supabase – každý uživatel vidí jen svá data
- Role: zatím jeden typ uživatele (zaměstnanec). Rozšíření rolí = mimo scope.

### 6.2 Layout hlavní obrazovky – split view

Hlavní obrazovka je rozdělena na **dvě panely vedle sebe**:

```
┌────────────────────────┬──────────────────────────────────┐
│                        │                                  │
│   LEVÝ PANEL           │   PRAVÝ PANEL                    │
│   Chat rozhraní        │   Živá tabulka výsledků          │
│   (ChatKit)            │                                  │
│                        │   Položky se doplňují            │
│   – vstup textu        │   průběžně jak agent pracuje     │
│   – nahrání souboru    │                                  │
│   – průběh / status    │   [ Export XLSX ]                │
│   – konverzace         │                                  │
└────────────────────────┴──────────────────────────────────┘
```

**Levý panel – chat:**
- Uživatel vloží vstup (text, Excel copy-paste, obrázek, PDF)
- Chat zobrazuje průběh zpracování (co agent dělá, jak postupuje)
- Kontext B: přímé dotazy na produkty s odpovědí v chatu

**Pravý panel – živá tabulka:**
- Tabulka se plní v reálném čase přes SSE streaming jak agent zpracovává položky
- Každý řádek se zobrazí jakmile je daná položka zpracována – uživatel nemusí čekat na dokončení celého běhu
- Stavové indikátory (viz 6.3) jsou viditelné okamžitě
- Kliknutím na řádek se otevře modal pro review (viz 6.4)
- Tlačítko Export XLSX je aktivní po zpracování všech položek

### 6.3 Obrazovka zpracování nabídky – tabulka položek

Po nahrání vstupu se zobrazí **živá tabulka položek** (renderuje se průběžně jak agent parsuje a vyhledává). Každý řádek = jedna položka poptávky.

**Stavové indikátory položky:**

| Stav | Vizuální indikátor | Popis | Akce uživatele |
|---|---|---|---|
| `zpracovává se` | ⏳ spinner | Agent právě hledá | — |
| `shoda` | ✅ zelená | Confidence ≥ 99 %, produkt ID doplněno automaticky | Volitelně rozkliknout a zkontrolovat |
| `nejistá shoda` | 🟡 žlutá | Confidence < 99 %, agent vybral kandidáta, ale není si jistý | **Vyžaduje review** |
| `více možností` | 🔵 modrá | Agent nalezl více stejně relevantních kandidátů | **Vyžaduje výběr** |
| `alternativa` | 🟠 oranžová | Přesná shoda nenalezena, agent nabízí náhradu | **Vyžaduje potvrzení** |
| `nenalezeno` | 🔴 červená | Ani sémantické vyhledávání nenašlo shodu | **Vyžaduje ruční řešení** |

**Sloupce tabulky (návrh):**
```
| # | Název z poptávky | Množství | Nalezený produkt | Kód (SKU) | Dostupnost | Confidence | Stav | Akce |
```

### 6.4 Modal – ruční review položky

Kliknutím na libovolnou položku (zejména ty s vyžadovaným review) se otevře **modal** s detailem.

**Modal obsahuje:**
- Originální text z poptávky (co agent dostal na vstupu)
- Seznam kandidátů seřazených dle relevance (ranked list z vyhledávacího jádra)
  - Každý kandidát zobrazuje: název, kód, cena, dostupnost, confidence score
  - Možnost filtrovat kandidáty dle dostupnosti
- Výběr produktu kliknutím na řádek kandidáta
- **Manuální vyhledávání** – fulltext search přímo v modalu pro případ, že správný produkt v kandidátovém seznamu není
- **Ruční zadání ID produktu** – textové pole pro přímý zápis SAP kódu (pokud uživatel zná produkt)
- Tlačítko Potvrdit / Přeskočit (přeskočené položky jdou do nenalezených)

### 6.5 Podporované vstupní formáty
| Formát | Podporováno | Poznámka |
|---|---|---|
| Plain text (copy-paste) | ✅ | E-mail, volný text |
| Tabulka z Excelu (copy-paste) | ✅ | Uživatel označí buňky, zkopíruje a vloží – agent zpracuje jako TSV |
| Obrázek (PNG, JPG, výřez) | ✅ | Zpracováno přes OpenAI Vision API |
| PDF | ✅ | Zpracováno přes OpenAI Vision API |
| Upload .xlsx souboru | ❌ | Není podporován – nahrazeno copy-paste přístupem |

---

## 7. Integrace se SAP

- **Přímé napojení na SAP není součástí projektu.**
- Výstupem agenta je **formátovaný XLSX soubor**, který zaměstnanec ručně nahraje do SAPu standardní cestou.
- Struktura výstupního XLSX bude definována dle požadavků zákazníka (mapování sloupců na SAP import formát).

---

## 8. Ukázková data a testování

- K dispozici je **cca 450 ukázkových e-mailů** s poptávkami pro trénink a testování agenta
- Testovací proces:
  1. Unit test parsovací logiky (extrakce položek z e-mailu)
  2. Benchmark vyhledávání (přesnost matchování na testovací sadě)
  3. End-to-end test celého flow (vstup → XLSX output)
- Cílová přesnost matchování: dohodnou se KPI se zákazníkem

---

## 9. Bezpečnost

- Všechny API klíče (OpenAI, Supabase) uloženy v `.env` proměnných na Railway
- Supabase RLS aktivní na všech tabulkách
- Backend (Node.js na Railway) komunikuje s Supabase přes Service Role Key – tento klíč nikdy neopustí server
- Frontend komunikuje se Supabase pouze přes Anon Key s omezenými oprávněními
- Soubory nahrané uživatelem (obrázky, PDF) jsou zpracovány a předány do OpenAI Vision API – neukládají se permanentně
- Žádná citlivá zákaznická data (ceník, poptávky) se nelogují do externích systémů mimo Supabase

---

## 10. Otevřené otázky (pro PM – nutno rozhodnout)

| # | Otázka | Dopad |
|---|---|---|
| 1 | Jaký je plánovaný počet uživatelů aplikace? | Ovlivní Supabase tier a Railway instanci |
| 2 | Jaká je požadovaná frekvence aktualizací ceníku (denně, týdně, manuálně)? | Design update mechanismu |
| 3 | Jaká je struktura výstupního XLSX pro SAP? | Nutné dodat před vývojem export funkce |
| 4 | Jsou k dispozici technické parametry produktů ve strukturované formě, nebo jen v textovém popisu? | Kvalita vyhledávání dle parametrů |
| 5 | Jaké jsou KPI pro přesnost agenta (% správně nalezených produktů)? | Acceptance criteria pro testování |

---

## 11. Co je explicitně MIMO scope

- ❌ Přímé napojení na SAP (API / klikač)
- ❌ Admin portál pro správu produktové databáze
- ❌ Zpracování Excel souborů jako vstup
- ❌ On-premise deployment (volíme cloud kvůli jednoduchosti a dostupnosti API)
- ❌ Správa více typů uživatelských rolí (zatím)
- ❌ Real-time synchronizace ceníku se SAPem

---

## 12. Navrhované fáze projektu

### Fáze 1 – Infrastruktura & Datová vrstva (přibližně 2 MD)
- Supabase projekt setup (Auth, DB schema, PGVector extension)
- Importní skript pro produktový katalog + generování embeddingů
- Základní hybridní vyhledávání (SQL + vector) – benchmark na testovacích datech

### Fáze 2 – Backend & Agentní logika (přibližně 3 MD)
- Railway setup – Hono server, environment, SSE streaming endpoint
- OpenAI Agents SDK integrace – definice agenta, tools (search, OCR, export)
- Implementace Kontext A (parsování poptávky → iterace → vyhledávání)
- Implementace Kontext B (přímý chat dotaz → vyhledávání)
- XLSX / CSV export logika
- Testování agentní logiky na 450 ukázkových e-mailech

### Fáze 3 – Frontend & ChatKit integrace (přibližně 3 MD)
- Pro-code implementace ChatKit + AgentKit + Widgety
- Nahrávání souborů (obrázek / PDF) a zobrazení výsledků
- Supabase Auth integrace (login, session, RLS)
- Export tlačítko (XLSX stažení)

### Fáze 4 – Testování, doladění & deployment (přibližně 2 MD)
- End-to-end testování celého flow
- Doladění agentní logiky (prompt engineering, threshold similarity)
- Aktualizační mechanismus ceníku
- Produkční deployment

---

*Dokument připravil: AI asistent na základě technického briefu*
*Ke schválení: PM + zákazník před zahájením vývoje*
