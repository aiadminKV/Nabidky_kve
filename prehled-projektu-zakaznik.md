# KV Elektro – Přehled projektu
> **Datum:** 18. 2. 2026 | **Status:** Draft ke schválení

---

## O čem projekt je

Vaši zaměstnanci každý den zpracovávají poptávky a objednávky, které přicházejí v nejrůznějších podobách – e-maily bez jednotné struktury, obrázky, PDF dokumenty nebo tabulky z Excelu. Každou takovou poptávku je potřeba ručně projít, rozpoznat jednotlivé položky a dohledat odpovídající produkty v katalogu. To zabírá čas, je náchylné k chybám a při větším objemu poptávek se stává skutečnou zátěží.

Cílem projektu je tento proces **automatizovat pomocí AI agenta** – chytrého nástroje, který poptávku přečte, položky rozpozná a produkty dohledá za zaměstnance. Ten pak jen zkontroluje výsledky, případně dořeší výjimky, a stáhne hotový podklad připravený k nahrání do SAPu.

Výsledkem je **webová aplikace** přístupná z prohlížeče, bez nutnosti instalace nebo složitého školení.

---

## Co aplikace umí

### Zpracování příchozích poptávek

Zaměstnanec dostane poptávku v libovolné podobě. Obsah vloží do aplikace – a systém se postará o zbytek:

1. **Rozpozná položky** – přečte poptávku a identifikuje seznam poptávaných produktů včetně množství
2. **Zaměstnanec potvrdí seznam** – ještě před vyhledáváním vidí co systém rozpoznal a může cokoliv opravit nebo doplnit
3. **Vyhledá produkty** – pro každou položku prohledá váš katalog a přiřadí nejlepší shodu
4. **Zobrazí výsledky** – přehledná tabulka s barevným označením stavu každé položky
5. **Zaměstnanec dořeší výjimky** – u nejistých nebo nenalezených položek vybere správný produkt
6. **Export** – hotový přehled se stáhne jako Excel připravený k nahrání do SAPu

### Přímé vyhledávání produktů

Zaměstnanec může aplikaci využít i jako chytrý vyhledávač – zadá název produktu nebo technické parametry přirozenou větou a systém okamžitě zobrazí odpovídající položky z katalogu. Pokud přesný produkt není dostupný, nabídne nejbližší alternativu.

---

## Jak vypadá rozhraní

Aplikace je rozdělena na dvě části vedle sebe, které spolupracují v reálném čase:

```
┌──────────────────────────┬───────────────────────────────────────┐
│  Chat                    │  Tabulka výsledků                     │
│                          │                                       │
│  Sem vložíte poptávku    │  #  │ Název z poptávky │ Produkt │ Stav│
│  nebo napíšete dotaz.    │  1  │ Jistič 3P 16A B  │ ABC-123 │ ✅  │
│                          │  2  │ Vypínač 2P ...   │ XYZ-456 │ 🟡  │
│  Průběžně zde vidíte     │  3  │ Kabel 3x2,5mm²   │ —       │ ⏳  │
│  co systém právě dělá.   │  4  │ ...              │         │     │
│                          │                                       │
│                          │            [ Stáhnout Excel ]         │
└──────────────────────────┴───────────────────────────────────────┘
```

**Chat vlevo** slouží jako vstup i jako průběžný přehled – zaměstnanec vidí, na které položce systém právě pracuje.

**Tabulka vpravo** se plní automaticky jak agent postupuje – není potřeba čekat na zpracování celé poptávky. Zaměstnanec může začít kontrolovat první hotové položky, zatímco systém zpracovává další. U rozsáhlých poptávek to výrazně šetří čas.

---

## Jak systém zobrazuje výsledky

Každá položka v tabulce je barevně označena, aby zaměstnanec okamžitě věděl, co je vyřešeno a co vyžaduje jeho pozornost:

| Stav | Barva | Co to znamená | Co zaměstnanec udělá |
|---|---|---|---|
| Shoda | ✅ Zelená | Produkt nalezen s vysokou jistotou | Nic – automaticky vyřešeno |
| Nejistá shoda | 🟡 Žlutá | Systém vybral kandidáta, ale není si zcela jistý | Doporučujeme ověřit kliknutím |
| Více možností | 🔵 Modrá | Nalezeno více stejně vhodných produktů | Vybere správný ze seznamu |
| Alternativa | 🟠 Oranžová | Přesná shoda neexistuje, systém nabídl náhradu | Potvrdí nebo vybere jiný |
| Nenalezeno | 🔴 Červená | Produkt v katalogu nebyl nalezen | Dohledá ručně nebo zadá SAP kód |

### Co se stane po kliknutí na položku

U každé položky, která vyžaduje pozornost, se po kliknutí otevře detail. Zaměstnanec tam vidí:

- **Seznam kandidátů** seřazených od nejlepší shody – s názvem, kódem, cenou a dostupností
- **Možnost filtrovat** kandidáty například podle dostupnosti na skladě
- **Vyhledávání** – pokud správný produkt v nabídce není, může ho vyhledat přímo v detailu
- **Ruční zadání kódu** – pokud zaměstnanec kód produktu zná, může ho zapsat přímo

---

## Jaké vstupy aplikace přijímá

| Typ vstupu | Podporováno | Poznámka |
|---|---|---|
| Text z e-mailu (copy-paste) | ✅ | Jakýkoliv volný text |
| Tabulka z Excelu (copy-paste) | ✅ | **Nejspolehlivější varianta** – viz tip níže |
| Obrázek nebo výřez obrazovky | ✅ | PNG, JPG |
| PDF soubor | ✅ | |
| Nahrání Excel souboru (.xlsx) | ❌ | Není podporováno |

> **Tip – jak na Excel:** Pokud máte poptávku v Excelu, označte buňky s položkami, zkopírujte je (Ctrl+C) a vložte přímo do chatu (Ctrl+V). Systém tabulku přečte přímo bez nutnosti AI rozpoznávání – výsledek je tak nejpřesnější a nejrychlejší. Tuto variantu doporučujeme vždy, když je to možné.

---

## Kontrola jako součást procesu – ne jako přítěž

Systém je navržen tak, aby AI pracovala co nejvíce samostatně, ale zároveň aby zaměstnanec měl **kdykoli přehled a kontrolu**. Funguje to takto:

- **Před vyhledáváním** – zaměstnanec potvrdí, že systém správně rozpoznal všechny položky z poptávky. U krátkých poptávek je to rychlá kontrola, u dlouhých je tento krok zásadní.
- **Během zpracování** – výsledky přibývají průběžně, zaměstnanec nemusí čekat.
- **Po zpracování** – jasné barevné označení ukáže, co je vyřešeno a co ne. Naprostá většina položek bude zelená a nevyžaduje žádný zásah.

Cílem není nahradit úsudek zaměstnance, ale **odstranit tu část práce, která je čistě mechanická** – opisování, hledání v katalogu, porovnávání.

---

## Napojení na SAP

Systém se SAPem **nepropojuje přímo**. Výstupem aplikace je vždy formátovaný Excel soubor, který zaměstnanec nahraje do SAPu stejnou cestou jako doposud. Tím zůstává plná kontrola procesu na vaší straně a nevzniká žádná závislost na přímém propojení systémů.

---

## Produktový katalog v aplikaci

Aby systém mohl vyhledávat, potřebuje mít k dispozici váš katalog produktů. Při spuštění aplikace provedeme **jednorázový import** vašeho ceníku. Součástí projektu je rovněž jednoduchý mechanismus pro pravidelnou aktualizaci katalogu – stačí nahrát nový soubor a systém automaticky porovná změny, přidá nové položky a odebere ty, které v katalogu již nejsou.

---

## Přístup, zabezpečení a provoz

- Aplikace běží v prohlížeči – **žádná instalace**, funguje na počítači i notebooku
- Přihlášení přes **e-mail a heslo**
- Každý zaměstnanec vidí pouze svá data
- Veškerá data jsou uložena v zabezpečeném cloudu
- Aplikace je dostupná odkudkoli s připojením k internetu

---

## Co první verze neobsahuje

Níže jsou oblasti, které nejsou součástí tohoto projektu. Mohou být předmětem rozšíření v dalších fázích.

| Oblast | Stav |
|---|---|
| Přímé propojení se SAPem (automatické vkládání objednávek) | Není součástí projektu |
| Správa uživatelských rolí a oprávnění | V první verzi jeden typ přístupu pro všechny |
| Administrátorské rozhraní pro správu katalogu | Katalog se aktualizuje importem souboru |
| Automatická synchronizace katalogu se SAPem v reálném čase | Není součástí projektu |

---

*Dokument připraven k odsouhlasení před zahájením vývoje.*
*V případě dotazů nebo připomínek nás prosím kontaktujte před podpisem.*
