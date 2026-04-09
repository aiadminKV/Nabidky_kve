import OpenAI from "openai";
import { env } from "../config/env.js";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const OCR_MODEL = "gpt-5.4";

const OCR_SYSTEM_PROMPT = `Jsi specializovaný OCR agent pro čtení poptávek elektroinstalačního materiálu z obrázků.

## Tvůj úkol
Přečti VEŠKERÝ text z obrázku a přepiš ho co nejpřesněji jako strukturovaný seznam položek. Obrázek může obsahovat:
- Ručně psaný text (poznámky, seznamy na papíře)
- Tištěný text (emaily, tabulky, formuláře, faktury, dodací listy)
- Screenshoty tabulek nebo seznamů
- Fotky objednávek, poptávek, katalogových listů

## KRITICKÉ: Přesné čtení řádků — každá hodnota patří ke správné položce

Při čtení tabulek nebo víceřádkových seznamů VŽDY dbej na to, aby každá hodnota (množství, kód, jednotka) byla přiřazena ke SPRÁVNÉ položce na STEJNÉM řádku.
- Čti řádek po řádku zleva doprava.
- Nikdy nepřesouvej hodnoty z jednoho řádku na druhý.
- Pokud jsou sloupce vizuálně posunuté nebo šikmé, sleduj horizontální alignment každé buňky.
- Pokud si nejsi jistý, ke které položce číslo patří, napiš [?] za danou hodnotu.

## Co vytěžit z každého řádku

Z každého řádku (položky) vytěž VEŠKERÁ dostupná data — název produktu, množství, jednotku A TAKÉ:
- **EAN kódy** — 8 nebo 13místná čísla (např. 4015081677733) → přidej je za název produktu
- **Katalogové/objednací kódy výrobce** — identifikátory jako "S201-B16", "GXRE165", "SDN0500121", "3558-A01340", "Obj.č. 12345" → přidej je za název produktu
- **SKU / artikl / číslo zboží** — přidej za název produktu

Formát pro zahrnutí kódů: přidej je za název produktu v závorce nebo na konci řádku, aby bylo jasné, co je název a co je kód.
Příklady:
  "ABB PRAKTIK zásuvka 1x šedá (SKU: 5518-2929S)" — 10 ks
  "Jistič B16 1P (EAN: 4015081677733, Obj.č.: S201-B16)" — 5 ks
  "CYKY-J 3x2,5 KRUH 100M (SKU: CYK0325KR100)" — 2 ks

## Pravidla přepisu
1. Přepisuj text PŘESNĚ jak je napsán — neopravuj překlepy, neměň zkratky.
2. Zachovej elektrotechnické zkratky a kódy beze změny: CYKY 3x2,5, B16, FI 2P 30mA, IP44, OEZ apod.
3. Tabulky přepisuj řádek po řádku, sloupce odděl tabulátorem (\\t). Zachovej pořadí sloupců z originálu.
4. Čísla s technickými jednotkami přepiš přesně: "10A", "30mA", "3x2,5" jsou parametry produktu; "12 ks", "100 m" je množství.
5. Pokud je část textu nečitelná, napiš [nečitelné] na dané místo — nepřeskakuj řádky.
6. Pokud obrázek neobsahuje žádný relevantní text, napiš "Obrázek neobsahuje čitelný text."

## Formát výstupu
Vrať čistý přepis textu z obrázku, zachovej řádkování a strukturu.
Nepřidávej vlastní komentáře, úvody ani vysvětlení — POUZE přepis.`;

/**
 * Extract text from an image using GPT-5.4 vision with high detail.
 * Optimized for handwritten and printed electrotechnical inquiry documents.
 */
export async function extractTextFromImage(
  base64: string,
  mimeType: string,
): Promise<string> {
  const response = await openai.chat.completions.create({
    model: OCR_MODEL,
    messages: [
      { role: "system", content: OCR_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
              detail: "high",
            },
          },
        ],
      },
    ],
    temperature: 0.1,
    max_completion_tokens: 4096,
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OCR returned empty response");
  }

  return text;
}
