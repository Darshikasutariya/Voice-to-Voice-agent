import { Document } from "@langchain/core/documents";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { ChromaClient } from "chromadb";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { crawl, saveScrape } from "./crawler.js";
import { chunkDocuments } from "./chunker.js";
import { BgeM3Embeddings } from "./embedder.js";
import { config } from "./config.js";

const args = new Set(process.argv.slice(2));
const SCRAPE_ONLY = args.has("--scrape-only");
const USE_CACHE = args.has("--use-cache"); // reuse data/scraped.json if present
const CHUNK_ONLY = args.has("--chunk-only"); // chunk + preview, no embedding

/* ─── Step 1 ─ scrape (or load from cache) ─────────────────── */

async function step1Scrape() {
  if (USE_CACHE && existsSync(config.paths.scrapeOutput)) {
    console.log(
      `[step1] loading cached scrape from ${config.paths.scrapeOutput}`,
    );
    const raw = await readFile(config.paths.scrapeOutput, "utf-8");
    return JSON.parse(raw);
  }

  console.log(
    `[step1] crawling ${config.crawl.baseUrl} (maxDepth=${config.crawl.maxDepth})`,
  );
  const pages = await crawl();
  await saveScrape(pages, config.paths.scrapeOutput);
  return pages;
}

/* ─── Step 2 ─ reset Chroma collection ─────────────────────── */

async function step2ResetCollection() {
  const url = new URL(config.chroma.url);
  const ssl = url.protocol === "https:";
  const host = url.hostname;
  const port = url.port ? parseInt(url.port, 10) : (ssl ? 443 : 80);
  const client = new ChromaClient({ ssl, host, port });
  try {
    await client.deleteCollection({ name: config.chroma.collection });
    console.log(
      `[step2] deleted existing collection "${config.chroma.collection}"`,
    );
  } catch (err) {
    console.log(`[step2] no existing collection (ok)`);
  }
}

/* ─── Step 3 ─ chunk + embed + upsert ──────────────────────── */

/**
 * Print a few representative chunks so you can verify cleaning worked
 * before spending time on the embed step.
 */
function previewChunks(chunks) {
  if (chunks.length === 0) return;

  console.log("\n[preview] sample chunks (first 3):");
  console.log("─".repeat(60));

  const sample = chunks.slice(0, 3);
  for (const c of sample) {
    console.log(`  id        : ${c.id}`);
    console.log(`  title     : ${c.metadata.title}`);
    console.log(`  module    : ${c.metadata.module}`);
    console.log(`  priority  : ${c.metadata.priority}`);
    console.log(`  type      : ${c.metadata.type}`);
    console.log(`  intent    : ${c.metadata.intent}`);
    console.log(`  length    : ${c.metadata.cleanedLength} chars`);
    console.log(`  text      : ${c.text.slice(0, 180).replace(/\s+/g, " ")}...`);
    console.log("─".repeat(60));
  }

  // Also show priority distribution
  const priorityStats = {};
  const typeStats = {};
  for (const c of chunks) {
    priorityStats[c.metadata.priority] = (priorityStats[c.metadata.priority] || 0) + 1;
    typeStats[c.metadata.type] = (typeStats[c.metadata.type] || 0) + 1;
  }
  console.log(`[preview] priority distribution:`, priorityStats);
  console.log(`[preview] type distribution    :`, typeStats);
  console.log("");
}

async function step3Embed(pages) {
  const chunks = await chunkDocuments(pages);

  if (chunks.length === 0) {
    console.error("[step3] no chunks produced after cleaning. Check your scraped data.");
    process.exit(1);
  }

  previewChunks(chunks);

  if (CHUNK_ONLY) {
    console.log("[step3] --chunk-only flag set, stopping before embedding.");
    console.log(`[step3] would have embedded ${chunks.length} chunks.`);
    return;
  }

  const docs = chunks.map(
    (c) => new Document({ pageContent: c.text, metadata: c.metadata }),
  );
  const ids = chunks.map((c) => c.id);

  const embeddings = new BgeM3Embeddings();
  // Warm up the model so the first batch isn't measured incorrectly
  await embeddings.embedQuery("warmup query");

  const BATCH = 64;
  console.log(`[step3] upserting ${docs.length} chunks in batches of ${BATCH}`);

  const url = new URL(config.chroma.url);
  const ssl = url.protocol === "https:";
  const host = url.hostname;
  const port = url.port ? parseInt(url.port, 10) : (ssl ? 443 : 80);
  const chromaClient = new ChromaClient({ ssl, host, port });

  let store = null;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batchDocs = docs.slice(i, i + BATCH);
    const batchIds = ids.slice(i, i + BATCH);

    if (store === null) {
      store = await Chroma.fromDocuments(batchDocs, embeddings, {
        collectionName: config.chroma.collection,
        index: chromaClient,
        ids: batchIds,
        collectionMetadata: { "hnsw:space": "cosine" },
      });
    } else {
      await store.addDocuments(batchDocs, { ids: batchIds });
    }
    console.log(
      `[step3] chroma upsert ${Math.min(i + BATCH, docs.length)}/${docs.length}`,
    );
  }

  return chunks;
}

/* ─── main ────────────────────────────────────────────────── */

async function main() {
  console.log("════════════════════════════════════════");
  console.log("  TaxOne Help Center → ChromaDB Ingest  ");
  console.log("════════════════════════════════════════\n");

  const pages = await step1Scrape();

  if (pages.length === 0) {
    console.error("No pages crawled. Check CRAWL_BASE_URL and network.");
    process.exit(1);
  }

  console.log(`\n[summary] scraped ${pages.length} pages`);
  console.log(
    `[summary] total characters: ${pages.reduce((a, p) => a + p.charCount, 0)}`,
  );

  if (SCRAPE_ONLY) {
    console.log("\n--scrape-only flag set, stopping before embedding.");
    console.log(`Review the output at ${config.paths.scrapeOutput} then run:`);
    console.log("  npm run ingest -- --use-cache");
    return;
  }

  console.log("");
  if (!CHUNK_ONLY) {
    await step2ResetCollection();
    console.log("");
  }

  const chunks = await step3Embed(pages);

  console.log("\n════════════════════════════════════════");
  console.log("  Ingest complete                       ");
  console.log("════════════════════════════════════════");
  if (chunks) {
    console.log(`Total chunks   : ${chunks.length}`);
  }
  console.log(`Collection     : ${config.chroma.collection}`);
  console.log(`Chroma URL     : ${config.chroma.url}`);
  console.log(`Embedding model: ${config.embed.modelId}`);
  console.log(`\nTry: npm run query -- "how do I sync Vyapar with Tally"`);
}

main().catch((err) => {
  console.error("\n[fatal]", err);
  process.exit(1);
});