import "../../src/config/env";
import { extractProductCodes } from "../services/searchPipeline";

const tests = [
  "Spinac jednopoovy 3558N-C01510 S IP54",
  "ABB zasuvka 5518-2929S IP54",
  "HLAVNI VYPINAC 3P 40A IS-40/3",
  "elektroinstalacni prislusenstvi 1183636",
  "pozadujeme kabel SYKFY 25X2X0,5 dle projektove dokumentace",
  "1257420007",
];

async function main() {
  for (const t of tests) {
    const codes = await extractProductCodes(t);
    console.log(`INPUT: "${t}"`);
    console.log(`CODES: ${JSON.stringify(codes)}`);
    console.log("---");
  }
}
main().catch(console.error);
