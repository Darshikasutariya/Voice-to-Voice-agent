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

/** @param {string} question @param {number} [k] */
export async function searchSimilar(question, k = 4) {
  const store = await getVectorStore();
  return store.similaritySearchWithScore(question, k);
}
