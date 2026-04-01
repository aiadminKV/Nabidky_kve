import OpenAI from "openai";
import { env } from "../config/env.js";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const OCR_MODEL = "gpt-5.4";

const OCR_SYSTEM_PROMPT = `Jsi specializovaný OCR agent pro čtení poptávek elektroinstalačního materiálu z obrázků.

## Tvůj úkol
Přečti VEŠKERÝ text z obrázku a přepiš ho co nejpřesněji. Obrázek může obsahovat:
- Ručně psaný text (poznámky, seznamy na papíře)
- Tištěný text (emaily, tabulky, formuláře, faktury)
- Screenshoty tabulek nebo seznamů
- Fotky objednávek, dodacích listů, poptávek

## Pravidla přepisu
1. Přepisuj text PŘESNĚ jak je napsán — neopravuj překlepy, neměň zkratky.
2. Zachovej elektrotechnické zkratky a kódy beze změny: CYKY 3x2,5, B16, FI 2P 30mA, IP44, OEZ apod.
3. Zachovej strukturu — pokud je text ve sloupce/tabulce, přepiš ho s tabulátory nebo jako seznam.
4. Čísla s jednotkami přepiš přesně: "10A" je parametr, "12ks" je množství.
5. Pokud je část textu nečitelná, napiš [nečitelné] na dané místo.
6. Pokud obrázek neobsahuje žádný relevantní text, napiš "Obrázek neobsahuje čitelný text."

## Formát výstupu
Vrať čistý přepis textu z obrázku, zachovej řádkování.
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
