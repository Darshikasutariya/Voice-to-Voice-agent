import { pipeline } from "@huggingface/transformers";
import { Embeddings } from "@langchain/core/embeddings";
import { config } from "./config.js";

/**
 * Local embedder for BAAI/bge-m3 via the Xenova ONNX export.
 * No API key, no network calls after the first model download.
 *
 * Produces 1024-dim, L2-normalized vectors. Use cosine distance in Chroma.
 */
export class BgeM3Embeddings extends Embeddings {
  constructor(params = {}) {
    super(params);
    this.modelId = config.embed.modelId;
    this.pipe = null;
    this._loadPromise = null;
  }

  async _ensureReady() {
    if (this.pipe) return;
    if (!this._loadPromise) {
      console.log(`[embed] loading ${this.modelId} ...`);
      console.log(`[embed] first run downloads ~500MB to ~/.cache/huggingface`);
      this._loadPromise = pipeline("feature-extraction", this.modelId).then(
        (p) => {
          this.pipe = p;
          console.log(`[embed] model ready`);
        },
      );
    }
    await this._loadPromise;
  }

  async embedDocuments(texts) {
    await this._ensureReady();
    const { batchSize, pooling, normalize } = config.embed;
    const out = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const tensor = await this.pipe(batch, { pooling, normalize });
      const vectors = tensor.tolist(); // shape: [batch, 1024]
      out.push(...vectors);

      const done = Math.min(i + batchSize, texts.length);
      if (done === texts.length || done % 32 === 0) {
        console.log(`[embed] ${done}/${texts.length}`);
      }
    }

    return out;
  }

  async embedQuery(text) {
    const [vec] = await this.embedDocuments([text]);
    return vec;
  }
}
