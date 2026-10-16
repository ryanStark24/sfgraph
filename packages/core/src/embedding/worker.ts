/**
 * Embedding worker entry (spawned by EmbeddingPool from the compiled
 * `worker.js`). Runs the same `embedTexts` pipeline as the in-process path —
 * same model, tokenizer cap, length-sorted sub-batches and pooling — so a
 * vector is the same whichever thread computed it. Requests are processed one
 * at a time, in arrival order. The process env (SFGRAPH_EMBED_MODEL_*) is
 * inherited from the parent.
 */
import { parentPort } from "node:worker_threads";
import { embedTexts } from "./embed.js";
import type { EmbedReply, EmbedRequest } from "./pool.js";

const port = parentPort;
if (port) {
  let chain: Promise<void> = Promise.resolve();
  port.on("message", (req: EmbedRequest) => {
    chain = chain.then(async () => {
      let reply: EmbedReply;
      let transfer: ArrayBuffer[] = [];
      try {
        const vectors = await embedTexts(req.texts);
        reply = { id: req.id, vectors };
        transfer = [...new Set(vectors.map((v) => v.buffer as ArrayBuffer))];
      } catch (e) {
        reply = { id: req.id, error: (e as Error).message ?? String(e) };
      }
      port.postMessage(reply, transfer);
    });
  });
}
