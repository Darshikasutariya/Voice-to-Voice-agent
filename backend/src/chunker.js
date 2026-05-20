import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { createHash } from "node:crypto";
import { config } from "./config.js";

/**
 * Stable, deterministic ID per chunk so re-ingest overwrites the same vector
 * instead of duplicating it. Uses sha1(url) + chunk index.
 */
function chunkId(url, index) {
  const urlHash = createHash("sha1").update(url).digest("hex").slice(0, 12);
  return `${urlHash}_${index}`;
}

export async function chunkDocuments(pages) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.chunk.chunkSize,
    chunkOverlap: config.chunk.chunkOverlap,
    separators: ["\n\n", "\n", ". ", " ", ""],
  });

  const chunks = [];
  for (const page of pages) {
    const pieces = await splitter.splitText(page.text);
    pieces.forEach((piece, i) => {
      chunks.push({
        id: chunkId(page.url, i),
        text: piece,
        metadata: {
          url: page.url,
          title: page.title,
          chunkIndex: i,
          totalChunks: pieces.length,
          crawledAt: page.crawledAt,
        },
      });
    });
  }

  console.log(`[chunk] ${pages.length} pages → ${chunks.length} chunks`);
  return chunks;
}
