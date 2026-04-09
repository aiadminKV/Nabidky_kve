import "dotenv/config";
import { lookupInKB } from "../services/kitKnowledgeBase.js";

const tests: [string, string][] = [
  ["Jednopólový vypínač", "Schneider Unica bílá"],
  ["Zásuvka 230V", "Schneider Unica bílá"],
  ["Datová zásuvka RJ45", "Schneider Unica bílá"],
  ["Schodový přepínač", "Schneider Unica bílá"],
  ["Jednopólový vypínač", "ABB Tango bílá"],
  ["Jednopólový vypínač", "ABB Tango černá"],
  ["Zásuvka 230V", "Legrand Valena bílá"],
  ["Klimatizace", "ABB Tango bílá"],           // unknown function type → only shared
  ["Něco neznámého", "Bosch XYZ"],             // no match
];

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const RST = "\x1b[0m";
const B = "\x1b[34m";

async function main() {
  console.log("\n KB lookup test\n");

  for (const [name, hint] of tests) {
    const res = await lookupInKB(name, hint);
    if (res && res.components.length > 0) {
      const hasAllRoles = res.components.some((c) => c.role === "mechanism");
      const col = hasAllRoles ? G : Y;
      console.log(`${col}✓ ${hint} / ${name}${RST}`);
      console.log(`  ${D}→ ${res.seriesName} / ${res.functionTypeName}${RST}`);
      for (const c of res.components) {
        console.log(`  ${B}${c.role.padEnd(10)}${RST} ${D}${(c.manufacturerCode ?? "—").padEnd(15)}${RST} ${c.name}`);
      }
    } else {
      console.log(`${R}✗ ${hint} / ${name} → NOT FOUND${RST}`);
    }
    console.log();
  }
}

main().catch(console.error);
