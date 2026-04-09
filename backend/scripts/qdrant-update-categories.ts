/**
 * Add category_prefixes payload field to existing Qdrant points.
 * No re-migration needed — just updates payload in place.
 *
 * category_prefixes: e.g. code "4050205" → ["4050205", "40502", "405"]
 * This allows filtering by any category level (agent passes "405" for main cat).
 *
 * Usage: npx tsx backend/scripts/qdrant-update-categories.ts
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { QdrantClient } from "@qdrant/js-client-rest";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = "products_v2";
const PAGE_SIZE = 1000;

const qdrant = new QdrantClient({
  url: QDRANT_URL,
  ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
  checkCompatibility: false,
});

function buildPrefixes(code: string | null | undefined): string[] {
  if (!code) return [];
  const prefixes: string[] = [code];
  // Level 2 (5 digits from 7-digit code)
  if (code.length > 5) prefixes.push(code.slice(0, 5));
  // Level 1 (3 digits)
  if (code.length > 3) prefixes.push(code.slice(0, 3));
  return [...new Set(prefixes)];
}

async function ensureIndex() {
  try {
    await qdrant.createPayloadIndex(COLLECTION_NAME, {
      field_name: "category_prefixes",
      field_schema: "keyword",
    });
    console.log("Created category_prefixes index.");
  } catch {
    // Index might already exist — ignore
    console.log("category_prefixes index already exists, skipping creation.");
  }
}

async function main() {
  await ensureIndex();

  const collInfo = await qdrant.getCollection(COLLECTION_NAME);
  const total = collInfo.points_count ?? 0;
  console.log(`Updating ${total.toLocaleString()} points with category_prefixes...`);

  let offset: string | number | null = null;
  let updated = 0;
  const startTime = Date.now();

  while (true) {
    const page = await qdrant.scroll(COLLECTION_NAME, {
      limit: PAGE_SIZE,
      with_payload: ["category_code"],
      with_vector: false,
      ...(offset !== null ? { offset } : {}),
    });

    if (page.points.length === 0) break;

    // Build batch payload updates
    const pointUpdates = page.points.map((pt) => ({
      id: pt.id,
      payload: {
        category_prefixes: buildPrefixes(
          (pt.payload?.["category_code"] as string | null) ?? null,
        ),
      },
    }));

    // Group by unique prefix set — points sharing the same category_code get the same prefixes
    // This minimises number of API calls (one call per unique prefix combination)
    const byPrefixes = new Map<string, (string | number)[]>();
    for (const u of pointUpdates) {
      const key = JSON.stringify(u.payload.category_prefixes);
      if (!byPrefixes.has(key)) byPrefixes.set(key, []);
      byPrefixes.get(key)!.push(u.id);
    }

    for (const [prefixesJson, ids] of byPrefixes) {
      const prefixes = JSON.parse(prefixesJson) as string[];
      await qdrant.setPayload(COLLECTION_NAME, {
        payload: { category_prefixes: prefixes },
        points: ids,
      });
    }

    updated += page.points.length;
    offset = page.next_page_offset ?? null;

    if (updated % 10_000 === 0 || offset === null) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = Math.round(updated / elapsed);
      const eta = rate > 0 ? Math.round((total - updated) / rate) : 0;
      console.log(
        `Progress: ${updated.toLocaleString()}/${total.toLocaleString()} | ${rate}/s | ETA: ${Math.floor(eta / 60)}m${eta % 60}s`,
      );
    }

    if (offset === null) break;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone. Updated ${updated.toLocaleString()} points in ${elapsed}s.`);
}

main().catch((err) => {
  console.error("Update failed:", err);
  process.exit(1);
});
