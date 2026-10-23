import { Worker } from "node:worker_threads";

// The utility process owns routing only. Every source owns a terminable V8
// isolate, which also owns that source's complete QuickJS WASM memory arena.
const port = (process as any).parentPort;
interface Instance {
  worker: Worker;
  sourceId: string;
  token: string;
  closing: boolean;
  requests: Set<number>;
  deadlines: Map<number, ReturnType<typeof setTimeout>>;
}
const instances = new Map<string, Instance>();
const hosts = new Map<number, { instance: Instance; local: number }>();
let hostSerial = 0;
function releaseRoutes(instance: Instance, error: string) {
  for (const id of instance.requests)
    port.postMessage({
      id,
      sourceId: instance.sourceId,
      token: instance.token,
      error,
    });
  instance.requests.clear();
  for (const timer of instance.deadlines.values()) clearTimeout(timer);
  instance.deadlines.clear();
  for (const [id, route] of hosts)
    if (route.instance === instance) hosts.delete(id);
}
async function terminate(instance: Instance) {
  instance.closing = true;
  if (instances.get(instance.sourceId) === instance)
    instances.delete(instance.sourceId);
  releaseRoutes(instance, "源实例已释放");
  await instance.worker.terminate();
}
function failed(instance: Instance, error: string) {
  if (instance.closing) return;
  instance.closing = true;
  if (instances.get(instance.sourceId) === instance)
    instances.delete(instance.sourceId);
  releaseRoutes(instance, error);
  port.postMessage({
    event: "instance-exit",
    sourceId: instance.sourceId,
    token: instance.token,
    error,
  });
  void instance.worker.terminate();
}
port.on("message", async ({ data: message }: any) => {
  if (message.hostResponse) {
    const route = hosts.get(message.hostResponse);
    if (!route) return;
    hosts.delete(message.hostResponse);
    if (!route.instance.closing) {
      try {
        route.instance.worker.postMessage({
          ...message,
          hostResponse: route.local,
        });
      } catch (error) {
        failed(route.instance, String(error));
      }
    }
    return;
  }
  const { id, sourceId, token, operation } = message;
  try {
    let instance = instances.get(sourceId);
    if (operation === "unload") {
      if (instance && instance.token === token) await terminate(instance);
      port.postMessage({ id, sourceId, token, result: null });
      return;
    }
    if (operation === "load") {
      if (instance) await terminate(instance);
      const worker = new Worker(
        new URL("./comicSourceInstance.js", import.meta.url),
        { resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } },
      );
      instance = {
        worker,
        sourceId,
        token,
        closing: false,
        requests: new Set(),
        deadlines: new Map(),
      };
      const current = instance;
      instances.set(sourceId, current);
      worker.on("message", (reply: any) => {
        if (current.closing) return;
        if (reply.event === "host") {
          const request = ++hostSerial;
          hosts.set(request, { instance: current, local: reply.request });
          port.postMessage({ ...reply, request });
          return;
        }
        current.requests.delete(reply.id);
        clearTimeout(current.deadlines.get(reply.id));
        current.deadlines.delete(reply.id);
        port.postMessage(reply);
        if (reply.id === id && reply.error) void terminate(current);
      });
      worker.on("error", (error) => failed(current, String(error)));
      worker.on("exit", (code) => failed(current, "源线程退出 (" + code + ")"));
    }
    if (!instance || instance.closing || instance.token !== token)
      throw Error("源实例已失效");
    instance.requests.add(id);
    const current = instance;
    instance.deadlines.set(
      id,
      setTimeout(() => failed(current, "源执行超过 180 秒，已终止"), 180000),
    );
    instance.worker.postMessage(message);
  } catch (error) {
    port.postMessage({ id, sourceId, token, error: String(error) });
  }
});
