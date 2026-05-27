import { pipeline } from "@huggingface/transformers";
import { Embeddings } from "@langchain/core/embeddings";
import { config } from "./config.js";

/**
 * Local embedder for BAAI/bge-m3 via the Xenova ONNX export.
 * No API key, no network calls after the first model download.
 *
 * Produces 1024-dim, L2-normalized vectors. Use cosine distance in Chroma.
 *
 * Supports dtype quantization for speed (configured in config.js):
 *  - fp32: original ~200-400ms/query, baseline quality
 *  - q8:   int8     ~80-150ms/query,  <2% quality loss
 *  - fp16: half     ~120-200ms/query, minimal quality loss
 */
export class BgeM3Embeddings extends Embeddings {
  constructor(params = {}) {
    super(params);
    this.modelId = config.embed.modelId;
    this.dtype = config.embed.dtype || "fp32";
    this.pipe = null;
    this._loadPromise = null;
  }

  async _ensureReady() {
    if (this.pipe) return;
    if (!this._loadPromise) {
      const startLoad = Date.now();
      console.log(`[embed] loading ${this.modelId} (dtype=${this.dtype}) ...`);
      console.log(`[embed] first run downloads ~500MB to ~/.cache/huggingface`);

      // Pass dtype option for quantization. Falls back gracefully if unsupported.
      const pipelineOptions = {};
      if (this.dtype && this.dtype !== "fp32") {
        pipelineOptions.dtype = this.dtype;
      }

      this._loadPromise = pipeline(
        "feature-extraction",
        this.modelId,
        pipelineOptions,
      ).then(
        (p) => {
          this.pipe = p;
          const loadDuration = Date.now() - startLoad;
          console.log(`[embed] model ready (loaded in ${loadDuration}ms, dtype=${this.dtype})`);
        },
        (err) => {
          // If quantized variant isn't available, fall back to fp32 transparently
          if (this.dtype !== "fp32") {
            console.warn(`[embed] dtype="${this.dtype}" failed to load: ${err.message}`);
            console.warn(`[embed] falling back to fp32`);
            this.dtype = "fp32";
            return pipeline("feature-extraction", this.modelId).then((p) => {
              this.pipe = p;
              const loadDuration = Date.now() - startLoad;
              console.log(`[embed] model ready (loaded in ${loadDuration}ms, dtype=fp32 fallback)`);
            });
          }
          throw err;
        },
      );
    }
    await this._loadPromise;
  }

  async embedDocuments(texts) {
    const startEmbed = Date.now();
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

    const embedDuration = Date.now() - startEmbed;
    console.log(`[embed] Generated embeddings for ${texts.length} documents in ${embedDuration}ms`);
    return out;
  }

  async embedQuery(text) {
    const [vec] = await this.embedDocuments([text]);
    return vec;
  }
}