import { parentPort, workerData } from "node:worker_threads";
import { collectInboxSource } from "./inbox-source.ts";

try {
  parentPort!.postMessage({ result: await collectInboxSource(workerData.home, workerData.source) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
