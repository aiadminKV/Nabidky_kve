# Nalezené problémy a řešení

> Přehled problémů, které se projevily při provozu asistenta KV Offer Manager, jejich dopad na práci obchodníků a provedená nápravná opatření.

---

## 1. Agent vybíral špatný typ balení kabelů

### Co se dělo
Při zpracování poptávek s kabely (např. CYKY-J 3x2,5 na 50 metrů) agent konzistentně vybíral **buben** (metráž) i v případech, kdy v katalogu existoval **kruh přesné délky**. Zákazník tak dostával v nabídce položku, ze které se kabely řežou na míru, místo předbaleného kruhu — rozdíl ve způsobu objednání i logistice.

Správné chování: poptávka 200 m → 2× kruh 100 m (ne buben 500 m).

### Příčina
Agent nedostával dostatečný kontext — katalog mu předával jen prvních 20 kandidátů z vyhledávání, přičemž vhodné kruhy byly často na pozici 30–60. Navíc AI model s úsporným nastavením nedokázal správně vyhodnotit, který kruh je pro dané množství vhodný.

### Řešení
Zvýšení počtu kandidátů předávaných agentovi na 60 a přidání konkrétní instrukce, jak vybírat balení kabelů (krok za krokem: vyřaď příliš velké kruhy, ověř dělitelnost množství, vyber největší vhodný, v ostatních případech buben). Zároveň posílení AI modelu pro tuto rozhodovací logiku.

### Výsledek
Testováno 7 scénářů (10 m, 25 m, 50 m, 75 m, 100 m, 200 m, 350 m) — správný výsledek **7/7**.

### Rizika
- Posílení AI modelu zdražuje zpracování. Při nabídce s 20 kabely jde o znatelný rozdíl v ceně API volání.
- Pravidlo funguje pro kabely a vodiče. Pokud by jiný typ produktu měl podobnou logiku balení, je třeba ho do instrukce přidat ručně.

---

## 2. Agent okamžitě spouštěl vyhledávání po vložení souboru

### Co se dělo
Když obchodník přiložil do chatu obrázek nebo PDF s poptávkou (ceník, e-mail, soupiska), agent automaticky **zpracoval a přiřadil všechny položky bez ptaní**. Nebylo možné zkontrolovat, co bylo z dokumentu vyčteno, než se spustilo hromadné vyhledávání.

### Příčina
Agent byl nastaven jako plně autonomní — instrukce říkala *„jednej okamžitě, nikdy se neptej na potvrzení"*. Výjimka pro soubory neexistovala.

### Řešení
Přidána výjimka: po přiložení souboru agent nejprve zobrazí, co z dokumentu vyčetl (seznam položek), a **zeptá se, zda má spustit vyhledávání**. Teprve po potvrzení pokračuje.

### Výsledek
Obchodník vidí parsované položky před vyhledáváním a může opravit případné chyby OCR nebo upřesnit záměr.

### Rizika
- Pokud uživatel napíše zprávu jako *„zpracuj tuto objednávku"* a přiloží soubor, agent by mohl tuto kombinaci vyhodnotit jako dostatečně jasnou a potvrzení přeskočit. Chování závisí na kontextu zprávy.
- Po delší konverzaci může LLM toto pravidlo opomenout (tzv. context drift). Doporučujeme průběžně testovat.

---

## 3. Objednací kódy z obrázků nebyly rozpoznány

### Co se dělo
Zákazníci často posílají ceníky nebo objednávky jako obrázky či PDF s tabulkou — PLU, název zboží, objednací číslo výrobce, množství. Agent uměl přečíst název produktu, ale **objednací kód ignoroval** nebo ho nedokázal použít k přesnému dohledání produktu v katalogu.

Výsledek: místo přímého dohledání produktu přes kód (`5518-2929S` → správný produkt) agent hledal sémanticky podle názvu a mohl najít podobný, ale jiný produkt.

### Příčina — dvojitá

**A) Agent nevěděl, že má kód použít.**
Instrukce pro využití objednacích kódů z tabulky existovala pouze pro Excel soubory. Pro obrázky a PDF chyběla.

**B) Databáze nenalezla kódy kvůli mezerám.**
ABB uchovává kódy ve formátu `"5518-2929 S"` (s mezerou před barevnou příponou), zatímco z obrázku přijde `"5518-2929S"` (bez mezery). Vyhledávání v databázi tento rozdíl neumělo překlenout — dotaz skončil prázdným výsledkem.

### Řešení

**K bodu A:** Agent nyní pro tabulkové obrázky přidává objednací kód přímo do hledaného názvu ve tvaru `název (SKU: kód)`. Pipeline pak kód extrahuje a použije jako prioritní vyhledávání.

**K bodu B:** Databázová funkce pro přesné dohledávání (`lookup_products_v2_exact`) byla rozšířena o porovnávání po odstranění mezer. Nový typ shody `idnlf_normalized` zajistí, že `"5518-2929S"` najde produkt uložený jako `"5518-2929 S"`.

### Výsledek
Z 8 objednacích kódů na testovacím obrázku (ABB TANGO ceník) nalezeno **7/8** — poslední produkt (SPC10T bužírka) v katalogu KV Elektro skutečně není.

### Rizika

**Kódy slepené bez oddělovače**
Někteří výrobci nebo zákazníci uvádějí kódy bez pomlček či mezer (např. `55182929S` místo `5518-2929S`). Normalizace mezer tento případ neřeší, protože DB identifikátory pomlčky obsahují. Taková poptávka by skončila sémantickým vyhledáváním podle názvu.

**Záměna interního čísla zákazníka za objednací kód výrobce**
Ceníky zákazníků typicky obsahují jejich vlastní interní číslo (PLU, skladové číslo) i kód výrobce. Agent musí správně rozlišit, který sloupec je pro vyhledávání v katalogu relevantní. Pokud jsou oba sloupce podobně strukturované nebo chybí hlavičky, může dojít k záměně.

**Nízká kvalita obrázku**
OCR model (GPT-5.4) čte kódy s vysokou přesností, ale při fotce mobilem, špatném osvětlení nebo zkresleném tisku se mohou zaměňovat podobné znaky (0/O, 1/I, 5/S). Jedna chybně přečtená číslice způsobí selhání přesného vyhledávání — fallback na sémantické hledání pak nemusí najít správný produkt.

**Kódy odpovídající více produktům po normalizaci mezer**
Teoreticky může nastat situace, kdy dvě různé položky mají identifikátory lišící se pouze mezerami. Minimální délka 6 znaků snižuje toto riziko, ale nevylučuje ho zcela.

---

## Aktualizace AI modelů

### Parser agent (extrakce položek z textu)
Model aktualizován z `gpt-4.1-mini` → **`gpt-5.4-mini`**. Jde o subagenta, který parsuje položky z textu (e-mail, tabulka, obrázek po OCR) před vyhledáváním. Novější model lépe rozumí elektrotechnickým zkratkám a strukturovaným tabulkám.

### OCR model (čtení obrázků)
Opravena chyba parametru `max_tokens` → `max_completion_tokens` pro model `gpt-5.4` (nová generace vyžaduje jiný název parametru). Bez opravy OCR při každém obrázku selhalo s chybou 400.
