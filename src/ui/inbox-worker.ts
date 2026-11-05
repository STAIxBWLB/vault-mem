import { parentPort, workerData } from "node:worker_threads";
import { collectInboxSource } from "./inbox-source.ts";
import { boundInbox } from "./inbox.ts";

try {
  parentPort!.postMessage({ result: boundInbox(await collectInboxSource(workerData.home, workerData.source)) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
