import { searchSimilar } from "./retrieval.js";

async function main() {
  const query =
    process.argv.slice(2).join(" ").trim() ||
    "How do I integrate Vyapar with Suvit?";

  console.log(`\nQuery: "${query}"\n`);

  const results = await searchSimilar(query, 4);

  if (results.length === 0) {
    console.log("No results. Did you run `npm run ingest` first?");
    return;
  }

  results.forEach(([doc, score], i) => {
    console.log(`─── Result ${i + 1} ─ score=${score.toFixed(4)} ───────────`);
    console.log(`Title : ${doc.metadata.title}`);
    console.log(`URL   : ${doc.metadata.url}`);
    console.log(
      `Chunk : ${doc.metadata.chunkIndex + 1}/${doc.metadata.totalChunks}`,
    );
    console.log(
      `Text  : ${doc.pageContent.slice(0, 260).replace(/\s+/g, " ")}...`,
    );
    console.log();
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
