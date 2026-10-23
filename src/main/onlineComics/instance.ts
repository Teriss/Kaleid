import { sourceImage } from "./image";
import { SourceRuntime, type RuntimeState } from "./runtime";
import initCode from "../../../vendor/venera/init.js?raw";

import { parentPort } from "node:worker_threads";
const port = {
  postMessage: (message: any) => parentPort!.postMessage(message),
  on: (_event: string, callback: (message: any) => void) =>
    parentPort!.on("message", (data) => callback({ data })),
};
const runtimes = new Map<string, { token: string; runtime: SourceRuntime }>();
const pending = new Map<
  number,
  { resolve(value: any): void; reject(error: Error): void }
>();
let serial = 0;
function host(id: string, token: string, message: any): Promise<any> {
  const request = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(request, { resolve, reject });
    port.postMessage({ event: "host", request, sourceId: id, token, message });
  });
}
port.on("message", async ({ data: message }: any) => {
  if (message.hostResponse) {
    const task = pending.get(message.hostResponse);
    if (!task) return;
    pending.delete(message.hostResponse);
    message.error
      ? task.reject(new Error(message.error))
      : task.resolve(message.value);
    return;
  }
  const { id, sourceId, token, operation, args = [] } = message;
  try {
    let result: any;
    if (operation === "load") {
      runtimes.get(sourceId)?.runtime.dispose();
      const runtime = new SourceRuntime(
        initCode,
        args[1] as RuntimeState,
        (m) => host(sourceId, token, m),
      );
      runtimes.set(sourceId, { token, runtime });
      try {
        result = await runtime.open(args[0]);
      } catch (error) {
        runtimes.delete(sourceId);
        runtime.dispose();
        throw error;
      }
    } else {
      const entry = runtimes.get(sourceId);
      if (!entry || entry.token !== token) throw new Error("漫画源实例已失效");
      const runtime = entry.runtime;
      switch (operation) {
        case "initialize":
          result = await runtime.initialize();
          break;
        case "inspect":
          result = await runtime.inspect();
          break;
        case "call":
          result = await runtime.call(args[0], args[1]);
          break;
        case "has":
          result = await runtime.has(args[0]);
          break;
        case "evaluate":
          result = await runtime.evaluate(args[0]);
          break;
        case "image":
          result = await sourceImage(runtime, args[0]);
          break;
        case "callback":
          result = await runtime.callback(args[0], args[1]);
          break;
        case "state":
          Object.assign(runtime.state, args[0]);
          result = null;
          break;
        case "unload":
          runtime.dispose();
          runtimes.delete(sourceId);
          result = runtime.disposalWarning
            ? { engineTeardownWarning: runtime.disposalWarning }
            : null;
          break;
        default:
          throw new Error("未知漫画源操作");
      }
    }
    port.postMessage({
      id,
      result,
      state: runtimes.get(sourceId)?.runtime.state,
      sourceId,
      token,
    });
  } catch (error) {
    port.postMessage({
      id,
      error: String(error),
      state: runtimes.get(sourceId)?.runtime.state,
      sourceId,
      token,
    });
  }
});
