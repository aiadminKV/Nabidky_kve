/**
 * pipeline-test-data.ts
 * 30 test cases across all product categories.
 * Each test uses CRITERIA (natural language) not specific SKU.
 */

export interface TestCase {
  id: number;
  demand: string;
  quantity: number;
  unit: string;
  criteria: string;
  category: string;
  groupContext?: {
    preferredManufacturer: string | null;
    preferredLine: string | null;
  };
}

export const TEST_CASES: TestCase[] = [
  // ── KABELY (6) ─────────────────────────────────────────────
  {
    id: 1,
    demand: "CXKH-R-J 5×1,5",
    quantity: 3310, unit: "m",
    criteria: "Kabel bezhalogenový (CXKH nebo CXKE v názvu), kulatý profil (R), s ochranným vodičem (J), 5 žil, průřez 1,5mm². BUBEN nebo metráž pro dané množství.",
    category: "kabel",
  },
  {
    id: 2,
    demand: "CYKY-J 5×4",
    quantity: 150, unit: "m",
    criteria: "Instalační kabel CYKY (PVC, NE CXKH/CXKE), provedení J (s ochranným vodičem, NE O), 5 žil, průřez 4mm². BUBEN, KRUH nebo metráž.",
    category: "kabel",
  },
  {
    id: 3,
    demand: "1-CXKH-R 5x10mm2",
    quantity: 172, unit: "m",
    criteria: "Kabel bezhalogenový CXKH nebo CXKE, kulatý (R), 5 žil, průřez 10mm². Provedení J nebo bez specifikace. BUBEN nebo metráž.",
    category: "kabel",
  },
  {
    id: 4,
    demand: "Kabel H05VV-F 3x2,5mm2",
    quantity: 10, unit: "m",
    criteria: "Flexibilní kabel H05VV-F, 3 žíly, průřez 2,5mm². NE H07RN-F, NE CYKY.",
    category: "kabel",
  },
  {
    id: 5,
    demand: "Kabel UTP Cat.6A B2ca",
    quantity: 760, unit: "m",
    criteria: "Datový kabel UTP (NE FTP/STP), kategorie 6A (NE Cat.5e, NE Cat.6 bez A), reakce na oheň B2ca. BUBEN nebo metráž.",
    category: "kabel",
  },
  {
    id: 6,
    demand: "kabel sdělovací SYKY 5x2x0,5mm2",
    quantity: 48, unit: "m",
    criteria: "Sdělovací kabel SYKY, 5 párů (5x2), průřez 0,5mm². NE stíněný (NE SYKFY).",
    category: "kabel",
  },

  // ── VODIČE (2) ─────────────────────────────────────────────
  {
    id: 7,
    demand: "Vodič CYA 50mm2 (H07V-K) žz",
    quantity: 120, unit: "m",
    criteria: "Vodič CYA / H07V-K (lanovaný), průřez 50mm², barva žlutozelená. NE CY/H07V-U (drátový). BUBEN nebo metráž.",
    category: "vodič",
  },
  {
    id: 8,
    demand: "H07V-K 16mm2",
    quantity: 132, unit: "m",
    criteria: "Vodič H07V-K (lanovaný, CYA), průřez 16mm². Libovolná barva (barva není specifikována). NE H07V-U (drátový). BUBEN nebo metráž.",
    category: "vodič",
  },

  // ── JISTIČE (3) ─────────────────────────────────────────────
  {
    id: 9,
    demand: "Jistič 1-pólový, char.B, 10kA, 16A",
    quantity: 5, unit: "ks",
    criteria: "Jistič (NE pojistka, NE vypínač), 1 pól, vypínací charakteristika B (NE C, NE D), vypínací schopnost 10kA, jmenovitý proud 16A.",
    category: "jistič",
  },
  {
    id: 10,
    demand: "Jistič 3-pólový, char.C, 10kA, 40A",
    quantity: 11, unit: "ks",
    criteria: "Jistič 3-pólový, charakteristika C (NE B, NE D), vypínací schopnost 10kA, proud 40A.",
    category: "jistič",
  },
  {
    id: 11,
    demand: "Jistič 80A, 25kA, 3P",
    quantity: 1, unit: "ks",
    criteria: "Jistič nebo kompaktní jistič, 3 póly, 80A, vypínací schopnost min. 25kA. Může být BC160 nebo ekvivalent.",
    category: "jistič",
  },

  // ── CHRÁNIČE (2) ────────────────────────────────────────────
  {
    id: 12,
    demand: "Chránič s nadpr.ochranou, 1+N, 10kA, typ A, char.B, Idn=0.03A, In=16A",
    quantity: 10, unit: "ks",
    criteria: "Chránič s nadproudovou ochranou (kombinovaný RCBO), 1+N póly, typ A, charakteristika B, reziduální proud 0,03A (30mA), jmenovitý proud 16A, vypínací schopnost 10kA.",
    category: "chránič",
  },
  {
    id: 13,
    demand: "chránič proudový 4 pólový 25A typ A 0,03A",
    quantity: 2, unit: "ks",
    criteria: "Chránič proudový (RCD, NE RCBO), 4 póly, proud 25A, typ A, reziduální proud 0,03A (30mA).",
    category: "chránič",
  },

  // ── KRABICE (2) ────────────────────────────────────────────
  {
    id: 14,
    demand: "krabice pod omítku PVC přístrojová kruhová D 70mm hluboká",
    quantity: 92, unit: "ks",
    criteria: "Krabice přístrojová pod omítku (NE do dutých stěn, NE na povrch), PVC, kruhová, průměr cca 68-70mm, HLUBOKÁ (NE mělká/standardní hloubka 40-45mm). Hluboká = hloubka min. 60mm.",
    category: "krabice",
  },
  {
    id: 15,
    demand: "Krabice přístrojová 2x",
    quantity: 80, unit: "ks",
    criteria: "Krabice přístrojová dvojnásobná (2-gang, pro 2 přístroje vedle sebe). Libovolný typ montáže pokud není specifikován.",
    category: "krabice",
  },

  // ── ZÁSUVKY (3) ────────────────────────────────────────────
  {
    id: 16,
    demand: "Zásuvka 230V, 16A, IP20, jednonásobná",
    quantity: 220, unit: "ks",
    criteria: "Zásuvka 230V, 16A, krytí IP20, jednonásobná. Přístroj/mechanismus zásuvky (bez rámečku). Libovolný výrobce.",
    category: "zásuvka",
  },
  {
    id: 17,
    demand: "Nástěnná zásuvka BALS 400V 16A 5pól IP44",
    quantity: 12, unit: "ks",
    criteria: "Průmyslová nástěnná zásuvka, 400V (NE 230V), 16A, 5 pólů, IP44. Výrobce BALS preferován ale ekvivalent OK.",
    category: "zásuvka",
  },
  {
    id: 18,
    demand: "Zásuvka 230V ABB Levit bílá/bílá",
    quantity: 58, unit: "ks",
    criteria: "Zásuvka 230V z řady ABB Levit, barva bílá/bílá. Musí být Levit řada (NE Tango, NE Swing).",
    category: "zásuvka",
    groupContext: { preferredManufacturer: "ABB", preferredLine: "Levit" },
  },

  // ── SPÍNAČE (2) ─────────────────────────────────────────────
  {
    id: 19,
    demand: "Spínač ř.1 ABB",
    quantity: 15, unit: "ks",
    criteria: "Spínač jednopólový řazení 1 (NE řazení 6, NE řazení 7). Přístroj/mechanismus. Výrobce ABB.",
    category: "spínač",
  },
  {
    id: 20,
    demand: "přepínač střídavý, řazení 6, s krytem, bez rámečku",
    quantity: 14, unit: "ks",
    criteria: "Přepínač střídavý, řazení 6 (NE řazení 1, NE řazení 7). S krytem. Bez rámečku (rámeček se kupuje zvlášť). Libovolný výrobce.",
    category: "spínač",
  },

  // ── TRUBKY (2) ──────────────────────────────────────────────
  {
    id: 21,
    demand: "Trubka ohebná pr. 20mm",
    quantity: 120, unit: "m",
    criteria: "Trubka elektroinstalační ohebná (NE tuhá/pevná), průměr 20mm (vnější nebo vnitřní cca 16-20mm). Libovolná třída odolnosti pokud není specifikována.",
    category: "trubka",
  },
  {
    id: 22,
    demand: "Ochrann. Trubka KF09120 KOPOFLEX červ.",
    quantity: 77, unit: "m",
    criteria: "Ochranná trubka KOPOFLEX (výrobce Kopos), typ KF09120 nebo ekvivalent, červená. Průměr 120mm.",
    category: "trubka",
  },

  // ── ŽLABY (2) ───────────────────────────────────────────────
  {
    id: 23,
    demand: "Kabelový drátěný žlab v.50mm š.200mm",
    quantity: 192, unit: "m",
    criteria: "Kabelový žlab DRÁTĚNÝ (NE plný/perforovaný/neperforovaný), výška bočnice 50mm, šířka 200mm.",
    category: "žlab",
  },
  {
    id: 24,
    demand: "Elektroinstalační kabelové žlaby WKSG 130FT šířka 300mm",
    quantity: 33, unit: "ks",
    criteria: "Kabelový žlab typ WKSG nebo ekvivalent, šířka 300mm. Provedení FT (žárově zinkovaný) nebo ekvivalent.",
    category: "žlab",
  },

  // ── SVÍTIDLA (1) ────────────────────────────────────────────
  {
    id: 25,
    demand: "svítidlo vestavné stropní panelové kruhové D 200-250mm 1500-2200lm",
    quantity: 29, unit: "ks",
    criteria: "Svítidlo vestavné (NE přisazené), stropní, panelové/LED panel, kruhové (NE čtvercové), průměr 200-250mm, světelný tok 1500-2200lm.",
    category: "svítidlo",
  },

  // ── ČIDLA (1) ───────────────────────────────────────────────
  {
    id: 26,
    demand: "Pohybový detektor, 230V, IP23, stropní podhled, vert. 360°, 300W LED, 1xNO",
    quantity: 53, unit: "ks",
    criteria: "Pohybový/prezenční detektor, napájení 230V, min. IP23, montáž do stropního podhledu, záběr 360°, zatížení min. 300W LED, 1x spínací kontakt (NO).",
    category: "čidlo",
  },

  // ── SVODIČ PŘEPĚTÍ (1) ─────────────────────────────────────
  {
    id: 27,
    demand: "Svodič přepětí třídy SPD2 síť TN-S, DG M TNS CI 275",
    quantity: 1, unit: "ks",
    criteria: "Svodič přepětí typ/třída SPD2 (T2), pro síť TN-S. Typ DG M TNS nebo ekvivalent DEHN. Jmenovité napětí 275V.",
    category: "svodič",
  },

  // ── HROMOSVOD (1) ───────────────────────────────────────────
  {
    id: 28,
    demand: "Jímací tyč JT, AlMgSi, délka 2,5m",
    quantity: 18, unit: "ks",
    criteria: "Jímací tyč pro hromosvod, materiál AlMgSi (hliníková slitina), délka 2,5m (NE 2m, NE 3m).",
    category: "hromosvod",
  },

  // ── RÁMEČKY (2) ─────────────────────────────────────────────
  {
    id: 29,
    demand: "Levit rámeček jednonásobný, bílá/bílá",
    quantity: 30, unit: "ks",
    criteria: "Rámeček jednonásobný z řady ABB Levit, barva bílá/bílá. NE Tango, NE Swing, NE jiná řada.",
    category: "rámeček",
    groupContext: { preferredManufacturer: "ABB", preferredLine: "Levit" },
  },
  {
    id: 30,
    demand: "rámeček jednonásobný",
    quantity: 12, unit: "ks",
    criteria: "Rámeček jednonásobný, libovolný výrobce a řada (není specifikováno). Pokud existuje více variant, je správné vrátit 'multiple'.",
    category: "rámeček",
  },
];
