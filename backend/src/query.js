import { searchSimilar, searchByModule } from "./retrieval.js";

const LOW_CONFIDENCE_THRESHOLD = 0.85; // keep in sync with rag.js

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

function scoreLabel(score) {
  // Chroma cosine distance: 0 = perfect, ~2 = unrelated
  if (score <= 0.4) return "STRONG";
  if (score <= 0.65) return "GOOD";
  if (score <= LOW_CONFIDENCE_THRESHOLD) return "OKAY";
  return "WEAK";
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  const query =
    positional.join(" ").trim() ||
    "How do I integrate Vyapar with Vyapar TaxOne?";

  const k = parseInt(flags.k ?? "4", 10);
  const moduleFilter = flags.module || null;

  console.log(`\n┌─ Query Test ─────────────────────────────────────────────`);
  console.log(`│ Query  : "${query}"`);
  console.log(`│ k      : ${k}`);
  if (moduleFilter) {
    console.log(`│ Filter : module = ${moduleFilter}`);
  }
  console.log(`└──────────────────────────────────────────────────────────\n`);

  const start = Date.now();
  const results = moduleFilter
    ? await searchByModule(query, moduleFilter, k)
    : await searchSimilar(query, k);
  const duration = Date.now() - start;

  if (results.length === 0) {
    console.log("No results found. Did you run `npm run ingest` first?");
    if (moduleFilter) {
      console.log(`Note: module filter "${moduleFilter}" may not match any chunks.`);
      console.log(`Try without --module flag, or check available modules in your data.`);
    }
    return;
  }

  // Confidence warning
  const topScore = results[0][1];
  if (topScore > LOW_CONFIDENCE_THRESHOLD) {
    console.log(
      `WARNING: top score ${topScore.toFixed(4)} exceeds confidence threshold ${LOW_CONFIDENCE_THRESHOLD}.`,
    );
    console.log(`In production, rag.js would return "I don't have that information" for this query.\n`);
  }

  console.log(`Found ${results.length} result(s) in ${duration}ms\n`);

  results.forEach(([doc, score], i) => {
    const meta = doc.metadata ?? {};
    const label = scoreLabel(score);

    console.log(`─── Result ${i + 1} ──── score=${score.toFixed(4)} [${label}] ──────────`);
    console.log(`  Title    : ${meta.title ?? "(no title)"}`);
    console.log(`  Module   : ${pad(meta.module ?? "(none)", 20)} Priority: ${meta.priority ?? "(none)"}`);
    console.log(`  Type     : ${pad(meta.type ?? "(none)", 20)} Intent  : ${meta.intent ?? "(none)"}`);
    console.log(`  Chunk    : ${(meta.chunkIndex ?? 0) + 1}/${meta.totalChunks ?? "?"}`);
    console.log(`  URL      : ${meta.url ?? "(no url)"}`);
    console.log(`  Text     : ${doc.pageContent.slice(0, 280).replace(/\s+/g, " ")}...`);
    console.log();
  });

  // Show module distribution of results — useful for spotting bias
  const modulesInResults = {};
  for (const [doc] of results) {
    const m = doc.metadata?.module ?? "unknown";
    modulesInResults[m] = (modulesInResults[m] || 0) + 1;
  }
  console.log(`Modules represented in results:`, modulesInResults);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});