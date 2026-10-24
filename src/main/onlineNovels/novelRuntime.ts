import {
  DEBUG_SYNC,
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten";
import type { NovelSetting } from "../../shared/onlineNovels";

const encode = (value: unknown) => JSON.stringify(value, (_key, item) => {
  if (item instanceof ArrayBuffer) return { $binary: Buffer.from(item).toString("base64") };
  if (ArrayBuffer.isView(item)) return { $binary: Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString("base64") };
  return item;
});
const decode = (value: string) => JSON.parse(value, (_key, item) =>
  item?.$binary !== undefined ? Uint8Array.from(Buffer.from(item.$binary, "base64")) : item,
);

export interface NovelRuntimeState {
  data: Record<string, unknown>;
  settings: Record<string, unknown>;
  credentials: Record<string, unknown>;
}
export type NovelRuntimeHost = (message: Record<string, unknown>) => Promise<unknown>;
export interface NovelRuntimeMeta {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  url: string;
  updateUrl?: string;
  assetReferer?: string;
  capabilities: { search: boolean; latest: boolean; popular: boolean; login: string[]; exportEpub: boolean };
  settings: Record<string, NovelSetting>;
}

/** User source code runs in a memory- and time-limited QuickJS context. */
export class NovelScriptRuntime {
  private vm!: QuickJSContext;
  private closed = false;
  private handles = new Set<QuickJSHandle>();
  private deferred = new Set<any>();
  private waiters = new Set<() => void>();
  private deadline = 0;
  private jobError?: Error;

  constructor(
    private readonly source: string,
    readonly state: NovelRuntimeState,
    private readonly host: NovelRuntimeHost,
  ) {}

  async open(): Promise<NovelRuntimeMeta> {
    const engine = await newQuickJSWASMModule(DEBUG_SYNC);
    this.vm = engine.newContext();
    this.vm.runtime.setMemoryLimit(128 * 1024 * 1024);
    this.vm.runtime.setMaxStackSize(1024 * 1024);
    this.vm.runtime.setInterruptHandler(() => this.closed || Date.now() > this.deadline);
    const encodeBytes = this.vm.newFunction("__encodeBytes", (arg) => {
      const value = this.vm.getArrayBuffer(arg);
      try { return this.vm.newString(Buffer.from(value.value).toString("base64")); }
      finally { value.dispose(); }
    });
    this.vm.setProp(this.vm.global, "__encodeBytes", encodeBytes);
    encodeBytes.dispose();
    const bridge = this.vm.newFunction("__host", (arg) => {
      try {
        const message = JSON.parse(this.vm.getString(arg), (_key, value) =>
          value?.$binary !== undefined ? Uint8Array.from(Buffer.from(value.$binary, "base64")) : value,
        );
        const pending = this.host(message);
        const deferred = this.vm.newPromise();
        this.deferred.add(deferred);
        void pending.then((value) => {
          if (this.closed) return;
          this.deadline = Date.now() + 5000;
          const result = this.valueHandle(value ?? null);
          deferred.resolve(result);
          result.dispose();
        }, (error) => {
          if (this.closed) return;
          this.deadline = Date.now() + 5000;
          const result = this.vm.newError(String(error));
          deferred.reject(result);
          result.dispose();
        });
        void deferred.settled.then(() => {
          if (!this.closed) this.pump();
          this.deferred.delete(deferred);
          deferred.dispose();
        });
        return deferred.handle;
      } catch (error) {
        throw new Error(String(error));
      }
    });
    this.vm.setProp(this.vm.global, "__host", bridge);
    bridge.dispose();
    this.run(`
      globalThis.__novelCall = (message) => __host(JSON.stringify(message, (_key,value) => {
        if (value instanceof ArrayBuffer) return {$binary:__encodeBytes(value)};
        if (ArrayBuffer.isView(value)) return {$binary:__encodeBytes(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength))};
        return value;
      }));
      globalThis.NovelSource = class {
        constructor(meta) { this.meta = meta; }
        setting(key) { return Object.prototype.hasOwnProperty.call(__novelState.settings, key) ? __novelState.settings[key] : this.meta.settings?.[key]?.default; }
        get credentials() { return __novelState.credentials; }
        saveCredentials(value) { __novelState.credentials=value; return __novelCall({op:'credentials', value}); }
        get data() { return __novelState.data; }
        saveData() { return __novelCall({op:'data', value:this.data}); }
        async isLogged() { return Boolean(this.credentials.logged || this.data.logged); }
        async cookieStatus(url, pattern='') { return __novelCall({op:'cookieStatus', url, pattern}); }
        async metadata() { return this.meta; }
      };
      globalThis.__novelState = ${encode(this.state)};
      globalThis.__hostApi = {
        request: (url, options={}) => __novelCall({op:'request', url, options}),
        query: (html, selectors, remove=[]) => __novelCall({op:'query', html, selectors, remove}),
        browser: (options) => __novelCall({op:'browser', options}),
        signalr: (options) => __novelCall({op:'signalr', options}),
        cookieStatus: (url, pattern='') => __novelCall({op:'cookieStatus', url, pattern}),
        digest: (value) => __novelCall({op:'digest', value}),
        gunzip: (value) => __novelCall({op:'gunzip', value}),
        gunzipJson: (value) => __novelCall({op:'gunzipJson', value}),
        visitor: () => __novelCall({op:'visitor'}),
        delay: (ms) => __novelCall({op:'delay', ms}),
      };
      globalThis.host = globalThis.__hostApi;
      globalThis.URLSearchParams = globalThis.URLSearchParams || class {
        constructor(values={}) { this.values=[]; if (values instanceof URLSearchParams) this.values=values.values.slice(); else for (const [k,v] of Object.entries(values)) this.append(k,v); }
        append(k,v) { this.values.push([String(k),String(v)]); }
        set(k,v) { this.values=this.values.filter(x=>x[0]!==String(k)); this.append(k,v); }
        get(k) { return this.values.find(x=>x[0]===String(k))?.[1] ?? null; }
        toString() { return this.values.map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&'); }
      };
      globalThis.__sourceState = __novelState;
      globalThis.__novelSerialize = (value) => JSON.stringify({result:value}, (_key,item) => {
        if (item instanceof ArrayBuffer) return {$binary:__encodeBytes(item)};
        if (ArrayBuffer.isView(item)) return {$binary:__encodeBytes(item.buffer.slice(item.byteOffset,item.byteOffset+item.byteLength))};
        return item;
      });
    `);
    const script = this.source
      .replace(/^\s*export\s+default\s+/gm, "")
      .replace(/^\s*export\s+(?=(?:class|const|let|var|function)\b)/gm, "");
    this.run(`${script}\nif (typeof NovelSourceEntry === 'undefined') throw Error('小说源必须导出 NovelSourceEntry 类'); globalThis.__source = new NovelSourceEntry();`);
    const meta = await this.call("metadata");
    if (!meta || meta.apiVersion !== 1 || typeof meta.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(meta.id) ||
      typeof meta.name !== "string" || !meta.name.trim() || meta.name.length > 80 || meta.id.startsWith("staging-") ||
      typeof meta.version !== "string" || !/^\d+\.\d+\.\d+/.test(meta.version) ||
      typeof meta.url !== "string" || !meta.capabilities || !meta.settings)
      throw new Error("小说源元信息无效或版本不兼容");
    const capabilities = meta.capabilities as any;
    if (
      typeof capabilities.search !== "boolean" ||
      typeof capabilities.latest !== "boolean" ||
      typeof capabilities.popular !== "boolean" ||
      typeof capabilities.exportEpub !== "boolean" ||
      !Array.isArray(capabilities.login) ||
      capabilities.login.some((item: unknown) => !["password", "webview"].includes(String(item)))
    ) throw new Error("小说源功能声明无效");
    const settings = meta.settings as Record<string, any>;
    if (Object.keys(settings).length > 100 || Object.entries(settings).some(([key, item]) => {
      if (!/^[a-zA-Z][\w.-]{0,63}$/.test(key) || !item || typeof item !== "object" ||
        !["input", "select", "switch"].includes(item.type) ||
        (item.title !== undefined && (typeof item.title !== "string" || item.title.length > 100)) ||
        (item.validator !== undefined && (typeof item.validator !== "string" || item.validator.length > 256))) return true;
      if (item.type === "input" && item.default !== undefined && typeof item.default !== "string") return true;
      if (item.type === "switch" && item.default !== undefined && typeof item.default !== "boolean") return true;
      if (item.type === "select") {
        if (!Array.isArray(item.options) || !item.options.length || item.options.length > 100) return true;
        if (item.options.some((option: any) => typeof option !== "string" &&
          (!option || typeof option.value !== "string" ||
            (option.label !== undefined && typeof option.label !== "string")))) return true;
        if (item.default !== undefined && !item.options.some((option: any) =>
          (typeof option === "string" ? option : option.value) === item.default)) return true;
      }
      if (item.validator !== undefined) {
        if (item.type !== "input") return true;
        try { void new RegExp(item.validator); } catch { return true; }
      }
      return false;
    })) throw new Error("小说源设置声明无效");
    const origin = new URL(meta.url);
    if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password)
      throw new Error("小说源主页地址无效");
    if (meta.assetReferer !== undefined) {
      if (typeof meta.assetReferer !== "string" || meta.assetReferer.length > 2048)
        throw new Error("小说源资源 Referer 无效");
      const assetReferer = new URL(meta.assetReferer);
      if (!/^https?:$/.test(assetReferer.protocol) || assetReferer.username || assetReferer.password)
        throw new Error("小说源资源 Referer 无效");
      meta.assetReferer = assetReferer.href;
    }
    if (meta.updateUrl) {
      const updateUrl = new URL(meta.updateUrl);
      if (!/^https?:$/.test(updateUrl.protocol) || updateUrl.username || updateUrl.password)
        throw new Error("小说源更新地址无效");
    }
    if ((meta as any).loginUrl) {
      const loginUrl = new URL((meta as any).loginUrl, meta.url);
      if (loginUrl.origin !== origin.origin) throw new Error("网页登录地址必须与小说源同域");
      (meta as any).loginUrl = loginUrl.href;
    }
    const methods = await this.evaluate(`Object.fromEntries(['search','discover','details','chapter','login','downloadEpub'].map(name=>[name,typeof __source[name]==='function']))`);
    if ((capabilities.search && !methods.search) || ((capabilities.latest || capabilities.popular) && !methods.discover) ||
      !methods.details || !methods.chapter || (capabilities.login.includes("password") && !methods.login) ||
      (capabilities.exportEpub && !methods.downloadEpub)) throw new Error("小说源声明的功能缺少对应方法");
    return meta as NovelRuntimeMeta;
  }

  private run(code: string) {
    this.deadline = Date.now() + 5000;
    const result = this.vm.evalCode(code);
    if (result.error) {
      const error = this.vm.dump(result.error);
      result.error.dispose();
      throw new Error(error?.message || String(error));
    }
    result.value.dispose();
  }
  private valueHandle(value: any): QuickJSHandle {
    if (value == null) return this.vm.null;
    if (typeof value === "string") return this.vm.newString(value);
    if (typeof value === "number") return this.vm.newNumber(value);
    if (typeof value === "boolean") return value ? this.vm.true : this.vm.false;
    if (value instanceof ArrayBuffer) return this.vm.newArrayBuffer(value);
    if (ArrayBuffer.isView(value)) return this.vm.newArrayBuffer(Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer);
    const object = Array.isArray(value) ? this.vm.newArray() : this.vm.newObject();
    try {
      for (const [key, child] of Object.entries(value)) {
        const handle = this.valueHandle(child);
        try { this.vm.setProp(object, key, handle); } finally { handle.dispose(); }
      }
      return object;
    } catch (error) { object.dispose(); throw error; }
  }
  private pump() {
    if (this.closed) return;
    this.deadline = Date.now() + 5000;
    const result = this.vm.runtime.executePendingJobs(1024);
    if (result.error) {
      const error = this.vm.dump(result.error);
      this.jobError = new Error(error?.message || String(error));
      result.error.dispose();
    }
    if (result.error || result.value) {
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    }
    // Successful executePendingJobs results are numbers in QuickJS 0.31;
    // only its error branch owns a disposable handle.
  }
  async evaluate(code: string): Promise<any> {
    if (this.closed) throw new Error("小说源实例已释放");
    this.deadline = Date.now() + 30_000;
    const result = this.vm.evalCode(code);
    if (result.error) {
      const error = this.vm.dump(result.error);
      result.error.dispose();
      throw new Error(error?.message || String(error));
    }
    const handle = result.value;
    this.handles.add(handle);
    const expires = Date.now() + 30_000;
    try {
      while (true) {
        this.pump();
        if (this.jobError) { const error = this.jobError; this.jobError = undefined; throw error; }
        const state = this.vm.getPromiseState(handle);
        if (state.type === "rejected") {
          const error = this.vm.dump(state.error);
          state.error.dispose();
          throw new Error(error?.message || String(error));
        }
        if (state.type === "fulfilled") {
          const serialize = this.vm.getProp(this.vm.global, "__novelSerialize");
          try {
            const encoded = this.vm.unwrapResult(this.vm.callFunction(serialize, this.vm.undefined, state.value));
            try { return decode(this.vm.getString(encoded)).result; } finally { encoded.dispose(); }
          } finally { serialize.dispose(); state.value.dispose(); }
        }
        if (Date.now() >= expires) throw new Error("小说源操作超过 30 秒");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { this.waiters.delete(wake); resolve(); }, 25);
          const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
          this.waiters.add(wake);
        });
      }
    } finally {
      this.handles.delete(handle);
      if (handle.alive) handle.dispose();
    }
  }
  call(method: string, args: unknown[] = []) {
    if (!/^[A-Za-z_$][\w$]*$/.test(method)) throw new Error("无效小说源方法");
    return this.evaluate(`Promise.resolve(__source[${JSON.stringify(method)}](...${encode(args)}))`);
  }
  async metadata() { return this.evaluate("Promise.resolve(__source.meta)"); }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    if (!this.vm) return;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    for (const handle of this.handles) if (handle.alive) handle.dispose();
    this.handles.clear();
    for (const deferred of this.deferred) { try { deferred.dispose(); } catch {} }
    this.deferred.clear();
    this.vm.dispose();
  }
}
