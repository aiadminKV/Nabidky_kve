/**
 * eval-data-nabidka.ts
 * Test items from the offer evaluation (48 items).
 * previousSku = what was used before (NOT always correct ground truth)
 * note1/note2 = manual annotations from the previous run
 */

export interface EvalItem {
  id: number;
  demand: string;
  unit: string;
  quantity: number;
  previousSku: string;
  note1: string; // manual annotation from previous run
  note2: string; // secondary annotation
}

export const EVAL_ITEMS: EvalItem[] = [
  { id:  1, demand: "Datový kabel UTP CAT6 LSOH",                                                                   unit: "m",   quantity: 22620, previousSku: "1132208",    note1: "shodná alternativa, dokonce levnější 1147506",              note2: "" },
  { id:  2, demand: "Patch kabel 3m RJ45/RJ45 Cat6",                                                                unit: "ks",  quantity: 255,   previousSku: "1196599",    note1: "sedí",                                                     note2: "" },
  { id:  3, demand: "Datový kabel UTP CAT6 LSOH",                                                                   unit: "m",   quantity: 1141,  previousSku: "1132208",    note1: "shodná alternativa, dokonce levnější 1147506",              note2: "" },
  { id:  4, demand: "Kabel FTP CAT5e UTP LSOH Dca",                                                                 unit: "m",   quantity: 1880,  previousSku: "1227354",    note1: "zkontrolovat, zda 1233794 je ok",                          note2: "zkontrolovat" },
  { id:  5, demand: "Kabel JXFE-R B2cas1d0 2x2x0,8",                                                               unit: "m",   quantity: 8176,  previousSku: "1948632",    note1: "sedí",                                                     note2: "" },
  { id:  6, demand: "Kabel JXFE-R B2cas1d0 3x2x0,8",                                                               unit: "m",   quantity: 5160,  previousSku: "2017387",    note1: "navrhl 1236791 a 170533",                                  note2: "zkontrolovat" },
  { id:  7, demand: "Datový kabel UTP CAT6 LSOH",                                                                   unit: "m",   quantity: 584,   previousSku: "1132208",    note1: "shodná alternativa, dokonce levnější 1147506",              note2: "" },
  { id:  8, demand: "CYKY 3×240+120 (nap kabel)",                                                                   unit: "m",   quantity: 123,   previousSku: "1257441001", note1: "sedí",                                                     note2: "" },
  { id:  9, demand: "CYKY-J 5×1,5 (HDO)",                                                                           unit: "m",   quantity: 123,   previousSku: "1257397007", note1: "nezvolil buben",                                           note2: "!" },
  { id: 10, demand: "CXKH-R-J 5×95",                                                                                unit: "m",   quantity: 62,    previousSku: "1753411",    note1: "nenašel",                                                  note2: "neřešit, prootže se nabízela alternativa" },
  { id: 11, demand: "CXKH-R-J 5×50",                                                                                unit: "m",   quantity: 118,   previousSku: "1742666",    note1: "nenašel",                                                  note2: "neřešit, prootže se nabízela alternativa" },
  { id: 12, demand: "CXKH-R-J 5×16",                                                                                unit: "m",   quantity: 470,   previousSku: "1753410",    note1: "nenašel",                                                  note2: "neřešit, prootže se nabízela alternativa" },
  { id: 13, demand: "CXKH-R-J 5×10",                                                                                unit: "m",   quantity: 78,    previousSku: "1742664",    note1: "nenašel",                                                  note2: "neřešit, prootže se nabízela alternativa" },
  { id: 14, demand: "CXKH-R-J 5×6",                                                                                 unit: "m",   quantity: 78,    previousSku: "1748879",    note1: "našel 1257671",                                            note2: "zkontrolovat" },
  { id: 15, demand: "CXKH-R-J 5×4",                                                                                 unit: "m",   quantity: 269,   previousSku: "1757390",    note1: "našel 1257672",                                            note2: "zkontrolovat" },
  { id: 16, demand: "CXKH-R-J 5×2,5",                                                                               unit: "m",   quantity: 246,   previousSku: "1748878",    note1: "našel 1257673",                                            note2: "zkontrolovat" },
  { id: 17, demand: "CXKH-R-J 5×1,5",                                                                               unit: "m",   quantity: 3310,  previousSku: "1756872",    note1: "našel 1257674",                                            note2: "zkontrolovat" },
  { id: 18, demand: "CXKH-R-J 3×2,5",                                                                               unit: "m",   quantity: 18962, previousSku: "1748876",    note1: "našel 1257675",                                            note2: "zkontrolovat" },
  { id: 19, demand: "CXKH-R-J 3×1,5",                                                                               unit: "m",   quantity: 15019, previousSku: "1748875",    note1: "našel 1314262",                                            note2: "zkontrolovat" },
  { id: 20, demand: "CXKH-R-O 3×1,5",                                                                               unit: "m",   quantity: 10086, previousSku: "1257676",    note1: "sedí",                                                     note2: "" },
  { id: 21, demand: "CXKH-V-J 5×1,5",                                                                               unit: "m",   quantity: 45,    previousSku: "1757114",    note1: "našel 1257666",                                            note2: "zkontrolovat" },
  { id: 22, demand: "PraFlaDur 7×1,5",                                                                               unit: "m",   quantity: 627,   previousSku: "1949750",    note1: "našel alternativy 1146457, 12277778, 1699029",             note2: "zkontrolovat" },
  { id: 23, demand: "CXKH-V-O 3×1,5",                                                                               unit: "m",   quantity: 146,   previousSku: "1257664",    note1: "sedí",                                                     note2: "" },
  { id: 24, demand: "CYKY-J 5×6",                                                                                    unit: "m",   quantity: 202,   previousSku: "1257429004", note1: "sedí",                                                     note2: "" },
  { id: 25, demand: "CYKY-J 5×4",                                                                                    unit: "m",   quantity: 106,   previousSku: "1257428004", note1: "sedí",                                                     note2: "" },
  { id: 26, demand: "CYKY-J 3×6",                                                                                    unit: "m",   quantity: 78,    previousSku: "1257539",    note1: "sedí",                                                     note2: "" },
  { id: 27, demand: "CYKY-J 3×2,5",                                                                                  unit: "m",   quantity: 50,    previousSku: "1257420003", note1: "sedí",                                                     note2: "" },
  { id: 28, demand: "CYKY-J 3×1,5",                                                                                  unit: "m",   quantity: 386,   previousSku: "1257383007", note1: "sedí",                                                     note2: "" },
  { id: 29, demand: "JYTY 4×1",                                                                                      unit: "m",   quantity: 62,    previousSku: "1257377008", note1: "sedí",                                                     note2: "" },
  { id: 30, demand: "Vodič CYA95",                                                                                   unit: "m",   quantity: 28,    previousSku: "1257477003", note1: "sedí",                                                     note2: "" },
  { id: 31, demand: "Vodič CYA50",                                                                                   unit: "m",   quantity: 162,   previousSku: "1257467004", note1: "nenašel, možná ani není v nabídce",                        note2: "zkontrolovat" },
  { id: 32, demand: "Vodič CYA35",                                                                                   unit: "m",   quantity: 174,   previousSku: "1257473004", note1: "doporučil modrý ale neměl vybírat, protože v poptávce neupřesněno", note2: "zkontrolovat" },
  { id: 33, demand: "Vodič CYA25",                                                                                   unit: "m",   quantity: 62,    previousSku: "1257461004", note1: "sedí",                                                     note2: "" },
  { id: 34, demand: "Vodič CY16",                                                                                    unit: "m",   quantity: 151,   previousSku: "1203195",    note1: "sedí",                                                     note2: "" },
  { id: 35, demand: "Vodič CY10",                                                                                    unit: "m",   quantity: 392,   previousSku: "1189172",    note1: "nedal jako alternativu žlutou",                            note2: "zkontrolovat" },
  { id: 36, demand: "Vodič CY 6",                                                                                    unit: "m",   quantity: 2072,  previousSku: "1189178",    note1: "sedí",                                                     note2: "" },
  { id: 37, demand: "Vodič CY 4",                                                                                    unit: "m",   quantity: 3965,  previousSku: "1189181",    note1: "sedí",                                                     note2: "" },
  { id: 38, demand: "Trubka ohebná 32mm 320N",                                                                       unit: "ks",  quantity: 1,     previousSku: "1184615",    note1: "našel 1198314",                                            note2: "zkontrolovat" },
  { id: 39, demand: "trubka tuhá 32mm",                                                                              unit: "ks",  quantity: 1,     previousSku: "1185860",    note1: "našel 2013684 a 1185860 v kandidátech",                    note2: "zkontrolovat" },
  { id: 40, demand: "trubka pevná 32",                                                                                unit: "ks",  quantity: 1,     previousSku: "1185860",    note1: "našel 2013684 a 1185860 v kandidátech",                    note2: "zkontrolovat" },
  { id: 41, demand: "trubka pevná 32mm",                                                                              unit: "ks",  quantity: 1,     previousSku: "1185860",    note1: "našel 2013684 a 1185860 v kandidátech",                    note2: "zkontrolovat" },
  { id: 42, demand: "Trubka ohebná 25mm 720N",                                                                        unit: "ks",  quantity: 1,     previousSku: "1184614",    note1: "",                                                         note2: "" },
  { id: 43, demand: "žlab drátěný šířka 50mm",                                                                        unit: "ks",  quantity: 1,     previousSku: "1200220",    note1: "sedí",                                                     note2: "" },
  { id: 44, demand: "žlab neperforovaný 50x50",                                                                       unit: "ks",  quantity: 1,     previousSku: "1993714",    note1: "našeel 1999917",                                           note2: "zkontrolovat" },
  { id: 45, demand: "jistič charakteristika B 50A",                                                                   unit: "ks",  quantity: 1,     previousSku: "1157112",    note1: "našel jako alternativy 1157188, 1136897, 1180879, 2032687", note2: "zkontrolovat" },
  { id: 46, demand: "zásuvka s víčkem 230V 16A IP44",                                                                 unit: "ks",  quantity: 1,     previousSku: "2002984",    note1: "našel 2002987",                                            note2: "zkontrolovat" },
  { id: 47, demand: "krabice pod omítku PVC přístrojová kruhová D 70mm hluboká",                                      unit: "kus", quantity: 92,    previousSku: "1212052",    note1: "našel 1161959",                                            note2: "zkontrolovat" },
  { id: 48, demand: "krabice do dutých stěn PVC přístrojová kruhová D 70mm hluboká",                                  unit: "kus", quantity: 7,     previousSku: "1212052",    note1: "našel 1251537",                                            note2: "zkontrolovat" },
  { id: 49, demand: "kabel instalační jádro Cu plné izolace PVC plášť PVC 450/750V (CYKY) 3x1,5mm2",                 unit: "m",   quantity: 8625,  previousSku: "1257383007", note1: "chyba, vybral kruh 100m, nedává si na to pozor",           note2: "zkontrolovat" },
];
