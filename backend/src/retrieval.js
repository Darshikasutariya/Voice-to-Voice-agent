import { Chroma } from "@langchain/community/vectorstores/chroma";
import { ChromaClient } from "chromadb";
import { BgeM3Embeddings } from "./embedder.js";
import { config } from "./config.js";

function makeChromaClient() {
  const url = new URL(config.chroma.url);
  const ssl = url.protocol === "https:";
  const host = url.hostname;
  const port = url.port ? parseInt(url.port, 10) : (ssl ? 443 : 80);
  return new ChromaClient({ ssl, host, port });
}

/** One shared store so the embedder model loads once per process. */
let storePromise = null;

async function getVectorStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const embeddings = new BgeM3Embeddings();
      return new Chroma(embeddings, {
        collectionName: config.chroma.collection,
        index: makeChromaClient(),
      });
    })();
  }
  return storePromise;
}

/**
 * Plain similarity search across the whole collection.
 *
 * @param {string} question
 * @param {number} [k=4]
 * @param {object} [filter] - Optional Chroma metadata filter, e.g. { module: "banking" }
 * @returns {Promise<[Document, number][]>}
 */
export async function searchSimilar(question, k = 4, filter = undefined) {
  const store = await getVectorStore();

  if (filter && Object.keys(filter).length > 0) {
    return store.similaritySearchWithScore(question, k, filter);
  }
  return store.similaritySearchWithScore(question, k);
}

/**
 * Module-filtered search. Restricts the candidate pool to one module
 * (e.g. only Banking chunks) before doing similarity search.
 *
 * Use this when conversation context strongly indicates a topic.
 *
 * @param {string} question
 * @param {string} module - e.g. "banking", "sales", "gst"
 * @param {number} [k=4]
 */
export async function searchByModule(question, module, k = 4) {
  if (!module || module === "general") {
    return searchSimilar(question, k);
  }
  return searchSimilar(question, k, { module });
}

/**
 * Hybrid search: pulls a wider pool, then re-ranks with module/priority hints.
 *
 * Use this when you have a soft signal about module (not certain) — it boosts
 * matching chunks but won't miss good answers from other modules.
 *
 * @param {string} question
 * @param {object} [hints]
 * @param {string} [hints.module]   - prefer chunks tagged with this module
 * @param {string} [hints.priority] - prefer chunks of this priority or higher
 * @param {number} [k=4]            - final number of results to return
 * @param {number} [poolSize=12]    - how many candidates to fetch before re-ranking
 */
export async function searchHybrid(question, hints = {}, k = 4, poolSize = 12) {
  const store = await getVectorStore();
  const candidates = await store.similaritySearchWithScore(question, poolSize);

  if (!hints.module && !hints.priority) {
    return candidates.slice(0, k);
  }

  const priorityWeight = { critical: 0.15, high: 0.08, medium: 0.0, low: -0.05 };
  const desiredPriorityRank = { critical: 3, high: 2, medium: 1, low: 0 };
  const minRank = hints.priority ? (desiredPriorityRank[hints.priority] ?? 1) : 0;

  const reranked = candidates.map(([doc, score]) => {
    let boost = 0;

    // Module match boost (lower score is better in cosine distance,
    // so we SUBTRACT to make matching docs win)
    if (hints.module && doc.metadata?.module === hints.module) {
      boost += 0.1;
    }

    // Priority boost
    const p = doc.metadata?.priority;
    if (p && priorityWeight[p] !== undefined) {
      boost += priorityWeight[p];
    }

    // If a min priority was requested, downrank below-threshold docs
    if (hints.priority && p) {
      const rank = desiredPriorityRank[p] ?? 1;
      if (rank < minRank) boost -= 0.1;
    }

    // Note: Chroma cosine returns distance (0 = perfect match).
    // Smaller is better, so a boost should REDUCE the effective score.
    return [doc, score - boost];
  });

  reranked.sort((a, b) => a[1] - b[1]);
  return reranked.slice(0, k);
}

/**
 * Convenience: same as searchSimilar but only returns the document objects
 * without scores. Use this in places where score isn't needed.
 */
export async function searchDocsOnly(question, k = 4, filter = undefined) {
  const hits = await searchSimilar(question, k, filter);
  return hits.map(([doc]) => doc);
}