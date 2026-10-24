import {
  newQuickJSWASMModule,
  DEBUG_SYNC,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { load } from "cheerio";
import * as crypto from "node:crypto";
import iconv from "iconv-lite";
import sharp from "sharp";

export interface RuntimeState {
  data: Record<string, any>;
  settings: Record<string, any>;
  logged: boolean;
  cookies: any[];
}
export type Host = (message: any) => Promise<any>;
type Pixels = { data: Buffer; width: number; height: number };
const wire = (value: any): string =>
  JSON.stringify(value, (_key, v) => {
    if (v instanceof ArrayBuffer)
      return { $binary: Buffer.from(v).toString("base64") };
    if (ArrayBuffer.isView(v))
      return {
        $binary: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString(
          "base64",
        ),
      };
    return v;
  }).replace(
    /[\u007f-\uffff]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
const unwire = (value: string): any =>
  JSON.parse(value, (_key, v) =>
    v?.$binary !== undefined
      ? Uint8Array.from(Buffer.from(v.$binary, "base64")).buffer
      : v,
  );
const bytes = (v: any) =>
  v instanceof ArrayBuffer ? Buffer.from(v) : Buffer.from(v ?? []);

/** The only executable site code lives in QuickJS, never Node's eval/vm. */
export class SourceRuntime {
  private vm!: QuickJSContext;
  private closed = false;
  private deadline = 0;
  private docs = new Map<
    number,
    { $: ReturnType<typeof load>; nodes: any[] }
  >();
  private images = new Map<number, Pixels>();
  private settingDefaults: Record<string, unknown> = {};
  private settingSchema?: Record<string, any>;
  private imageSerial = 0;
  private deferred = new Set<any>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private key = "";
  private handles = new Set<QuickJSHandle>();
  private waiters = new Set<() => void>();
  private cookieChain: Promise<unknown> = Promise.resolve();
  private loadingSerial = 0;
  private jobError?: Error;
  private helperActive = 0;
  private helperQueue: {
    run(): Promise<any>;
    resolve(value: any): void;
    reject(error: Error): void;
  }[] = [];
  disposalWarning?: string;
  private sourceInstanceId?: string;
  constructor(
    private initCode: string,
    readonly state: RuntimeState,
    private host: Host,
    private helperDepth = 0,
  ) {}

  async open(script: string) {
    // 0.32.0's optimized WASM build fails the large mixed-width text regression
    // during JS_FreeRuntime. Pin the checked build; a module per source also
    // prevents an engine failure from invalidating other source contexts.
    const engine = await newQuickJSWASMModule(DEBUG_SYNC);
    this.vm = engine.newContext();
    this.vm.runtime.setMemoryLimit(192 * 1024 * 1024);
    this.vm.runtime.setMaxStackSize(1024 * 1024);
    this.vm.runtime.setInterruptHandler(
      () => this.closed || Date.now() > this.deadline,
    );
    const register = (
      name: string,
      fn: (...h: QuickJSHandle[]) => QuickJSHandle,
    ) => {
      const handle = this.vm.newFunction(name, fn);
      this.vm.setProp(this.vm.global, name, handle);
      handle.dispose();
    };
    register("__encodeBytes", (h) => {
      const buffer = this.vm.getArrayBuffer(h);
      try {
        return this.vm.newString(Buffer.from(buffer.value).toString("base64"));
      } finally {
        buffer.dispose();
      }
    });
    register("__decodeBytes", (h) =>
      this.vm.newArrayBuffer(
        Uint8Array.from(Buffer.from(this.vm.getString(h), "base64")).buffer,
      ),
    );
    register("__parseJSON", (h) =>
      this.valueHandle(JSON.parse(this.vm.getString(h))),
    );
    register("__quoteJSON", (h) =>
      this.vm.newString(
        JSON.stringify(this.vm.getString(h)).replace(
          /[\u007f-\uffff]/g,
          (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
        ),
      ),
    );
    register("__host", (h) => {
      try {
        const message = unwire(this.vm.getString(h));
        const result = this.dispatch(message);
        if (result instanceof Promise) {
          const deferred = this.vm.newPromise();
          this.deferred.add(deferred);
          void result.then(
            (value) => {
              if (this.closed) return;
              this.deadline = Date.now() + 5000;
              const handle = this.valueHandle(value ?? null);
              deferred.resolve(handle);
              handle.dispose();
            },
            (error) => {
              if (this.closed) return;
              this.deadline = Date.now() + 5000;
              const handle = this.vm.newError(String(error));
              deferred.reject(handle);
              handle.dispose();
            },
          );
          void deferred.settled.then(() => {
            if (!this.closed) this.pump();
            this.deferred.delete(deferred);
            deferred.dispose();
          });
          return deferred.handle;
        }
        return this.valueHandle(result ?? null);
      } catch (error) {
        throw new Error(String(error));
      }
    });
    this.sync(
      `
      var appVersion = '1.18.0';
      var __refs = new Map(), __refId = 0, __initializationRequests = null;
      function __pack(v) {
        if (v === undefined) return null;
        if (typeof v === 'function') { let id=++__refId; __refs.set(id,v); return {$fn:id}; }
        if (v instanceof ArrayBuffer) return {$binary:__encodeBytes(v)};
        if (ArrayBuffer.isView(v)) return {$binary:__encodeBytes(v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength))};
        if (v instanceof Map) return {$map:Array.from(v,([k,x])=>[k,__pack(x)])};
        if (Array.isArray(v)) return v.map(__pack);
        if (v && typeof v==='object') { let o={}; for(let k of Object.keys(v)) if(!['__proto__','prototype','constructor'].includes(k)) o[k]=__pack(v[k]); return o; }
        return v;
      }
      function __unpack(v) {
        if(v && typeof v==='object') {
          if(v.$binary!==undefined) return __decodeBytes(v.$binary);
          if(v.$map) return new Map(v.$map.map(([k,x])=>[k,__unpack(x)]));
          if(v.$fn) return __refs.get(v.$fn);
          if(Array.isArray(v)) return v.map(__unpack);
          for(let k of Object.keys(v)) v[k]=__unpack(v[k]);
        } return v;
      }
      function __serialize(v) {
        if(typeof v==='string') return __quoteJSON(v);
        if(Array.isArray(v)) return '['+v.map(__serialize).join(',')+']';
        if(v && typeof v==='object') return '{'+Object.keys(v).filter(k=>v[k]!==undefined).map(k=>__quoteJSON(k)+':'+__serialize(v[k])).join(',')+'}';
        return JSON.stringify(v) ?? 'null';
      }
      function sendMessage(v) {
        let r=__host(__serialize(__pack(v)));
        let result=r && typeof r.then==='function' ? r.then(__unpack) : __unpack(r);
        if(__initializationRequests && v.method==='http' && result && typeof result.then==='function') {
          const requests=__initializationRequests;
          requests.add(result);
          result.then(()=>requests.delete(result),()=>requests.delete(result));
        }
        return result;
      }
      function __wire(v) { return __serialize(__pack(v)); }
      // Native construction avoids large mixed-width JSON bridge allocations.
      const __originalJSONParse = JSON.parse;
      JSON.parse = function(text, reviver) {
        if(typeof text!=='string'||text.length<65536||reviver) return __originalJSONParse(text,reviver);
        return __parseJSON(text);
      };
    `,
    ).dispose();
    this.sync(this.initCode).dispose();
    const preparedScript = script
      .replace(/\bexport\s+default\s+class\s+extends\s+ComicSource\b/g, "class __VeneraDefaultSource extends ComicSource")
      .replace(/\bexport\s+default\s+(?=class\s+\w+\s+extends\s+ComicSource\b)/g, "")
      .replace(/\bexport\s+(?=class\s+\w+\s+extends\s+ComicSource\b)/g, "")
      .replace(/\bexport\s*\{[^}]*\}\s*;?/g, "");
    const entry =
      preparedScript.match(/^\s*class\s+(\w+)\s+extends\s+ComicSource\b/m)?.[1] ||
      preparedScript.match(/^\s*(?:const|let|var)\s+(\w+)\s*=\s*class(?:\s+\w+)?\s+extends\s+ComicSource\b/m)?.[1];
    if (!entry)
      throw new Error(
        "漫画源必须声明继承 ComicSource 的入口类；请确认链接指向兼容的原始 Venera 脚本",
      );
    await this.evaluate(
      `(() => { ${preparedScript}\n globalThis.__source = new ${entry}(); ComicSource.sources[__source.key]=__source; return true; })()`,
    );
    // The upstream ehentai source's empty-page fallback deletes every cookie
    // on exhentai.org and replaces them with the e-hentai.org cookie set. In
    // isolated per-source sessions this can discard an ExHentai-only igneous
    // cookie (and Cloudflare clearance) while trying to recover. Merge the
    // shared-domain cookies instead, and retain ExHentai-specific cookies.
    await this.evaluate(`(() => {
      if (__source.key !== 'ehentai') return;
      const webLogin = __source.account?.loginWithWebview;
      if (webLogin && typeof webLogin.onLoginSuccess === 'function') {
        const original = webLogin.onLoginSuccess;
        webLogin.onLoginSuccess = async function(...args) {
          await original.apply(this, args);
          // The upstream source starts this cookie write without awaiting it.
          // Join the write here so the host cannot mark login complete before
          // the ExHentai-domain session cookies are actually persisted.
          const cookies = await Network.getCookies('https://forums.e-hentai.org');
          for (const cookie of cookies || []) cookie.domain = '.exhentai.org';
          await Network.setCookies('https://exhentai.org', cookies || []);
        };
      }
      if (typeof __source.onLoadFailed === 'function') {
        __source.onLoadFailed = async function() {
          const [targetCookies, sourceCookies] = await Promise.all([
            Network.getCookies('https://exhentai.org'),
            Network.getCookies('https://e-hentai.org'),
          ]);
          const merged = new Map((targetCookies || []).map(cookie => [cookie.name, cookie]));
          for (const cookie of sourceCookies || []) {
            merged.set(cookie.name, { ...cookie, domain: '.exhentai.org' });
          }
          await Network.setCookies('https://exhentai.org', Array.from(merged.values()));
          throw 'You may not have permission to access this page. Please check your network or try to login again.';
        };
      }
    })()`);
    this.sourceInstanceId = await this.evaluate(
      "__sourceRuntime.identity(__source)",
    );
    const meta = await this.inspect();
    this.key = meta.key;
    // Preserve the declared setting schema before init. Some sources mutate
    // their settings object to keep runtime values such as a refreshed API URL.
    for (const [key, setting] of Object.entries(meta.settings || {}) as [
      string,
      any,
    ][])
      if (setting && typeof setting === "object" && Object.hasOwn(setting, "default"))
        this.settingDefaults[key] = setting.default;
    this.settingSchema = JSON.parse(JSON.stringify(meta.settings || {}));
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(meta.key) ||
      !meta.name ||
      !/^\d+\.\d+\.\d+/.test(meta.version)
    )
      throw new Error("漫画源名称、标识或版本无效");
    if (
      String(meta.minAppVersion || "0")
        .split(".")
        .map(Number)
        .reduce((n: number, v: number) => n * 1000 + v, 0) > 1006003
    )
      throw new Error(`漫画源需要更高兼容版本 ${meta.minAppVersion}`);
    return meta;
  }
  private sync(code: string, resetDeadline = true) {
    if (resetDeadline) this.deadline = Date.now() + 5000;
    const result = this.vm.evalCode(code);
    if (result.error) {
      const e = this.vm.dump(result.error);
      result.error.dispose();
      throw new Error(e?.message || String(e));
    }
    return result.value;
  }
  private valueHandle(value: any): QuickJSHandle {
    if (value == null) return this.vm.null;
    if (typeof value === "string") return this.vm.newString(value);
    if (typeof value === "number") return this.vm.newNumber(value);
    if (typeof value === "boolean") return value ? this.vm.true : this.vm.false;
    if (value instanceof ArrayBuffer) return this.vm.newArrayBuffer(value);
    if (ArrayBuffer.isView(value))
      return this.vm.newArrayBuffer(
        Uint8Array.from(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ).buffer,
      );
    const object = Array.isArray(value)
      ? this.vm.newArray()
      : this.vm.newObject();
    try {
      for (const [key, child] of Object.entries(value)) {
        const handle = this.valueHandle(child);
        try {
          if (key === "__proto__")
            this.vm.defineProp(object, key, {
              value: handle,
              configurable: true,
              enumerable: true,
            });
          else this.vm.setProp(object, key, handle);
        } finally {
          handle.dispose();
        }
      }
      return object;
    } catch (error) {
      object.dispose();
      throw error;
    }
  }
  private pump() {
    if (this.closed) return;
    this.deadline = Date.now() + 5000;
    const result = this.vm.runtime.executePendingJobs(1024);
    if (result.error) {
      this.deadline = Date.now() + 2000;
      try {
        const error = this.vm.dump(result.error);
        this.jobError = new Error(error?.message || String(error));
      } finally {
        result.error.dispose();
      }
    }
    if (result.error || result.value) {
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    }
  }
  async evaluate(expression: string, expires = Date.now() + 180000): Promise<any> {
    if (this.closed) throw new Error("漫画源已释放");
    const handle = this.sync(expression);
    this.handles.add(handle);
    try {
      while (true) {
        if (this.closed) throw new Error("漫画源已释放");
        this.pump();
        if (this.jobError) throw this.jobError;
        const result = this.vm.getPromiseState(handle);
        if (result.type === "rejected") {
          const error = this.vm.dump(result.error);
          result.error.dispose();
          throw new Error(error?.message || String(error));
        }
        if (result.type === "fulfilled") {
          try {
            const fn = this.vm.getProp(this.vm.global, "__wire");
            try {
              const encoded = this.vm.unwrapResult(
                this.vm.callFunction(fn, this.vm.undefined, result.value),
              );
              try {
                return unwire(this.vm.getString(encoded));
              } finally {
                encoded.dispose();
              }
            } finally {
              fn.dispose();
            }
          } finally {
            result.value.dispose();
          }
        }
        const remaining = expires - Date.now();
        if (remaining <= 0) throw new Error("漫画源操作超时");
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            this.timers.delete(timer);
            this.waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, remaining);
          this.timers.add(timer);
          this.waiters.add(wake);
        });
      }
    } finally {
      this.handles.delete(handle);
      if (handle.alive) handle.dispose();
    }
  }

  call(path: string, args: any[] = []) {
    if (!/^[\w.]+$/.test(path)) throw new Error("无效源接口");
    return this.evaluate(
      `(async()=>{let p=${JSON.stringify(path)}.split('.'),o=__source;for(let k of p.slice(0,-1))o=o?.[k];let f=o?.[p[p.length-1]];if(typeof f!=='function')throw Error('源不支持 '+${JSON.stringify(path)});return await f.apply(o,__unpack(${wire(args)}));})()`,
    );
  }
  callback(ref: any, args: any[] = []) {
    if (!ref?.$fn) throw new Error("源回调已失效");
    return this.evaluate(
      `__refs.get(${Number(ref.$fn)})(...__unpack(${wire(args)}))`,
    );
  }
  drop(value: any) {
    const refs: number[] = [];
    const visit = (v: any) => {
      if (!v || typeof v !== "object") return;
      if (v.$fn) refs.push(v.$fn);
      else Object.values(v).forEach(visit);
    };
    visit(value);
    if (!this.closed && refs.length)
      this.sync(
        `${JSON.stringify(refs)}.forEach(id=>__refs.delete(id))`,
      ).dispose();
  }
  async inspect() {
    const meta = await this.evaluate(
      `({key:__source.key,name:__source.name,version:__source.version,minAppVersion:__source.minAppVersion,url:__source.url,enableTagsTranslate:__source.comic?.enableTagsTranslate===true||__source.enableTagsTranslate===true,settings:__source.settings||{},explore:(__source.explore||[]).map(x=>({title:x.title,type:x.type})),categories:__source.category||null,searchOptions:__source.search?.optionList||[],categoryOptions:__source.categoryComics?.optionList||[],rankingOptions:__source.categoryComics?.ranking?.options||[],cookieFields:__source.account?.loginWithCookies?.fields||[], capabilities:{search:!!(__source.search?.load||__source.search?.loadNext),categories:!!__source.categoryComics,favorites:!!__source.favorites,favoriteFolders:!!__source.favorites?.multiFolder,login:[__source.account?.login?'password':null,__source.account?.loginWithWebview?'webview':null,__source.account?.loginWithCookies?'cookies':null].filter(Boolean)}})`,
    );
    if (this.settingSchema) meta.settings = this.settingSchema;
    else this.settingSchema = JSON.parse(JSON.stringify(meta.settings || {}));
    return meta;
  }
  async initialize() {
    if (!(await this.evaluate(`typeof __source.init==='function'`))) return;
    // CopyManga starts API discovery without returning its promise from init.
    // Check after evaluate pumps the VM's jobs, so follow-up requests and the
    // response handlers that update the API URL finish before exposing the
    // instance. All iterations share the normal operation deadline.
    const expires = Date.now() + 180000;
    try {
      await this.evaluate(`(async()=>{
        __initializationRequests=new Set();
        await __source.init();
      })()`, expires);
      while (await this.evaluate("__initializationRequests.size", expires))
        await this.evaluate(
          "Promise.allSettled(Array.from(__initializationRequests)).then(()=>null)",
          expires,
        );
    } finally {
      if (!this.closed) this.sync("__initializationRequests=null").dispose();
    }
  }
  has(path: string) {
    return this.evaluate(`typeof __source.${path}==='function'`);
  }

  private dispatch(m: any): any {
    if (this.closed) throw new Error("源已失效");
    if (
      [
        "load_data",
        "save_data",
        "delete_data",
        "load_setting",
        "isLogged",
      ].includes(m.method) &&
      m.source_id !== undefined &&
      m.source_id !== this.sourceInstanceId
    )
      throw new Error("源实例已被替换或移除");
    if (
      [
        "load_data",
        "save_data",
        "delete_data",
        "load_setting",
        "isLogged",
      ].includes(m.method) &&
      this.key &&
      m.key !== this.key
    )
      throw new Error("不可访问其他源的数据");
    switch (m.method) {
      case "load_data":
        return this.state.data[m.data_key] ?? null;
      case "save_data": {
        if (
          [
            "setting",
            "settings",
            "__proto__",
            "constructor",
            "prototype",
          ].includes(m.data_key)
        )
          throw new Error("保留数据键");
        this.state.data[m.data_key] = m.data;
        void this.host({ method: "persist", state: this.state }).catch(
          () => {},
        );
        return null;
      }
      case "delete_data":
        delete this.state.data[m.data_key];
        void this.host({ method: "persist", state: this.state }).catch(
          () => {},
        );
        return null;
      case "load_setting": {
        if (Object.hasOwn(this.state.settings, m.setting_key))
          return this.state.settings[m.setting_key];
        const h = this.sync(
          `(()=>{const v=globalThis.__source?.settings?.[${JSON.stringify(m.setting_key)}];return v&&typeof v==='object'&&Object.hasOwn(v,'default')?v.default:(v??${JSON.stringify(this.settingDefaults[m.setting_key] ?? null)});})()`,
          false,
        );
        try {
          return this.vm.dump(h);
        } finally {
          h.dispose();
        }
      }
      case "isLogged":
        return this.state.logged;
      case "getLocale":
        return "zh_CN";
      case "getPlatform":
        return "windows";
      case "uuid":
        return crypto.randomUUID();
      case "random":
        return m.type === "int"
          ? Math.floor(Math.random() * (m.max - m.min + 1)) + m.min
          : m.min + Math.random() * (m.max - m.min);
      case "log":
        return null; // Site logs may contain tokens. Never forward raw logs.
      case "convert":
        return this.convert(m);
      case "html":
        return this.html(m);
      case "image":
        return this.image(m);
      case "delay":
        return new Promise((resolve) => {
          const timer = setTimeout(
            () => {
              this.timers.delete(timer);
              resolve(null);
            },
            Math.min(180000, Math.max(0, Number(m.time) || 0)),
          );
          this.timers.add(timer);
        });
      case "http":
        return this.cookieChain
          .then(() => this.host(m))
          .then((result) => {
            if (result.cookies) this.state.cookies = result.cookies;
            return result;
          });
      case "cookie": {
        if (m.function === "get") {
          const url = new URL(m.url);
          return this.state.cookies.filter(
            (c) =>
              (url.hostname === String(c.domain).replace(/^\./, "") ||
                (String(c.domain).startsWith(".") &&
                  url.hostname.endsWith(c.domain))) &&
              url.pathname.startsWith(c.path || "/") &&
              (!c.secure || url.protocol === "https:"),
          );
        }
        this.cookieChain = this.cookieChain
          .then(() => this.host(m))
          .then((cookies) => {
            this.state.cookies = cookies;
          });
        return this.cookieChain;
      }
      case "compute": {
        if (
          typeof m.function !== "string" ||
          m.function.length > 2 * 1024 * 1024
        )
          throw new Error("无效计算脚本");
        return this.compute(m.function, m.args || []);
      }
      case "UI": {
        if (m.function === "showLoading") {
          const id = ++this.loadingSerial;
          void this.host({ ...m, id })
            .then((cancelled) => {
              if (!this.closed && cancelled && m.onCancel?.$fn)
                return this.callback(m.onCancel);
            })
            .catch(() => {})
            .finally(() => this.drop(m));
          return id;
        }
        if (m.function === "cancelLoading") {
          void this.host(m).catch(() => {});
          return null;
        }
        return this.host(m)
          .then(async (result) => {
            if (
              m.function === "showDialog" &&
              Number.isInteger(result) &&
              m.actions?.[result]?.callback
            )
              return this.callback(m.actions[result].callback);
            if (
              m.function === "showInputDialog" &&
              result != null &&
              m.validator?.$fn
            ) {
              const error = await this.callback(m.validator, [result]);
              if (error) {
                await this.host({
                  method: "UI",
                  function: "showMessage",
                  message: String(error),
                });
                return this.dispatch(m);
              }
            }
            return result;
          })
          .finally(() => this.drop(m));
      }
      case "getClipboard":
      case "setClipboard":
        return this.host(m);
      default:
        throw new Error(`未实现的漫画源宿主接口：${m.method}`);
    }
  }
  requestHTTP(message: any) {
    return this.dispatch({ ...message, method: "http" });
  }
  private convert(m: any) {
    const v = bytes(m.value);
    switch (m.type) {
      case "utf8":
        return m.isEncode
          ? Uint8Array.from(Buffer.from(String(m.value))).buffer
          : v.toString("utf8");
      case "gbk":
        return m.isEncode
          ? Uint8Array.from(iconv.encode(String(m.value), "gbk")).buffer
          : iconv.decode(v, "gbk");
      case "base64":
        return m.isEncode
          ? v.toString("base64")
          : Uint8Array.from(Buffer.from(String(m.value), "base64")).buffer;
      case "hex":
        return v.toString("hex");
      case "md5":
      case "sha1":
      case "sha256":
      case "sha512":
        return Uint8Array.from(crypto.createHash(m.type).update(v).digest())
          .buffer;
      case "hmac": {
        const h = crypto.createHmac(m.hash, bytes(m.key)).update(v).digest();
        return m.isString ? h.toString("hex") : Uint8Array.from(h).buffer;
      }
      case "aes-ecb":
      case "aes-cbc":
      case "aes-cfb":
      case "aes-ofb": {
        const key = bytes(m.key);
        const mode = m.type.slice(4);
        const cipher = (
          m.isEncode ? crypto.createCipheriv : crypto.createDecipheriv
        )(
          `aes-${key.length * 8}-${mode}`,
          key,
          mode === "ecb" ? null : bytes(m.iv),
        );
        cipher.setAutoPadding(false);
        return Uint8Array.from(
          Buffer.concat([cipher.update(v), cipher.final()]),
        ).buffer;
      }
      case "rsa":
        return Uint8Array.from(
          crypto.privateDecrypt(
            {
              key: Buffer.from(m.key, "base64"),
              format: "der",
              type: "pkcs8",
              padding: crypto.constants.RSA_PKCS1_PADDING,
            },
            v,
          ),
        ).buffer;
      default:
        throw new Error(`未知转换 ${m.type}`);
    }
  }
  private html(m: any): any {
    if (m.function === "parse") {
      if (String(m.data).length > 16 * 1024 * 1024)
        throw new Error("HTML 过大");
      if (this.docs.size >= 16)
        this.docs.delete(this.docs.keys().next().value!);
      this.docs.set(m.key, { $: load(m.data), nodes: [] });
      return null;
    }
    if (m.function === "dispose") {
      this.docs.delete(m.key);
      return null;
    }
    const doc = this.docs.get(m.doc ?? m.key);
    if (!doc) throw new Error("HTML 文档已释放");
    const $ = doc.$;
    const register = (n: any) => {
      if (!n) return null;
      let id = doc.nodes.indexOf(n);
      if (id < 0) id = doc.nodes.push(n) - 1;
      return id;
    };
    const node = m.doc === undefined ? undefined : doc.nodes[m.key];
    const current = node ? $(node) : $.root();
    switch (m.function) {
      case "querySelector":
        return register($(m.query).get(0));
      case "querySelectorAll":
        return $(m.query).toArray().map(register);
      case "getElementById":
        return register(
          $("*")
            .toArray()
            .find((n) => $(n).attr("id") === m.id),
        );
      case "dom_querySelector":
        return register(current.find(m.query).get(0));
      case "dom_querySelectorAll":
        return current.find(m.query).toArray().map(register);
      case "getText":
      case "node_text":
        return current.text();
      case "getAttributes":
        return node?.attribs || {};
      case "getChildren":
        return current.children().toArray().map(register);
      case "getNodes":
        return current.contents().toArray().map(register);
      case "getInnerHTML":
        return current.html() || "";
      case "getParent":
        return register(current.parent().get(0));
      case "getClassNames":
        return (current.attr("class") || "").split(/\s+/).filter(Boolean);
      case "getId":
        return current.attr("id") ?? null;
      case "getLocalName":
        return node?.name || "";
      case "getPreviousSibling":
        return register(current.prev().get(0));
      case "getNextSibling":
        return register(current.next().get(0));
      case "node_type":
        return node?.type === "text"
          ? "text"
          : node?.type === "comment"
            ? "comment"
            : "element";
      case "node_toElement":
        return ["tag", "script", "style"].includes(node?.type) ? m.key : null;
      default:
        throw new Error(`未知 HTML 操作 ${m.function}`);
    }
  }
  private storePixels(width: number, height: number, data?: Buffer) {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 40_000_000 ||
      [...this.images.values()].reduce((n, i) => n + i.data.length, 0) +
        width * height * 4 >
        256 * 1024 * 1024
    )
      throw new Error("图片处理超过内存限制");
    const id = ++this.imageSerial;
    this.images.set(id, {
      width,
      height,
      data: data ?? Buffer.alloc(width * height * 4),
    });
    return id;
  }
  private image(m: any): any {
    if (m.function === "emptyImage") return this.storePixels(m.width, m.height);
    const image = this.images.get(m.key);
    if (!image) throw new Error("图片已释放");
    if (m.function === "getWidth") return image.width;
    if (m.function === "getHeight") return image.height;
    if (m.function === "copyAndRotate90") {
      const id = this.storePixels(image.height, image.width),
        target = this.images.get(id)!;
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++)
          image.data.copy(
            target.data,
            (x * target.width + image.height - y - 1) * 4,
            (y * image.width + x) * 4,
            (y * image.width + x + 1) * 4,
          );
      return id;
    }
    let source = m.function === "copyRange" ? image : this.images.get(m.image)!;
    if (!source) throw new Error("源图片已释放");
    let target = image;
    let sx = m.srcX ?? 0,
      sy = m.srcY ?? 0,
      dx = m.x ?? 0,
      dy = m.y ?? 0,
      width = m.width ?? source.width,
      height = m.height ?? source.height,
      id: number | undefined;
    if (m.function === "copyRange") {
      sx = dx;
      sy = dy;
      dx = dy = 0;
      id = this.storePixels(width, height);
      target = this.images.get(id)!;
    }
    if (
      ![sx, sy, dx, dy, width, height].every(Number.isSafeInteger) ||
      Math.min(sx, sy, dx, dy, width, height) < 0 ||
      sx + width > source.width ||
      sy + height > source.height ||
      dx + width > target.width ||
      dy + height > target.height
    )
      throw new Error("无效图片范围");
    for (let y = 0; y < height; y++)
      source.data.copy(
        target.data,
        ((dy + y) * target.width + dx) * 4,
        ((sy + y) * source.width + sx) * 4,
        ((sy + y) * source.width + sx + width) * 4,
      );
    return id ?? null;
  }
  private helper<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("漫画源已释放"));
    if (this.helperDepth > 0)
      return Promise.reject(new Error("计算脚本不支持嵌套任务"));
    if (this.helperQueue.length >= 8)
      return Promise.reject(new Error("计算任务过多"));
    return new Promise((resolve, reject) => {
      this.helperQueue.push({ run, resolve, reject });
      this.pumpHelpers();
    });
  }
  private pumpHelpers() {
    while (!this.closed && this.helperActive < 2 && this.helperQueue.length) {
      const task = this.helperQueue.shift()!;
      this.helperActive++;
      void task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.helperActive--;
          this.pumpHelpers();
        });
    }
  }
  compute(code: string, args: any[]) {
    return this.helper(() => this.computeInner(code, args));
  }
  private async computeInner(code: string, args: any[]) {
    const child = new SourceRuntime(
      this.initCode,
      { data: {}, settings: {}, logged: false, cookies: [] },
      async () => {
        throw new Error("计算脚本不提供网络或界面");
      },
      this.helperDepth + 1,
    );
    try {
      await child.open(
        `class ComputeSource extends ComicSource { name='compute';key='compute';version='1.0.0'; }`,
      );
      return await child.evaluate(`(${code})(...__unpack(${wire(args)}))`);
    } finally {
      child.dispose();
    }
  }
  modify(code: string, buffer: Buffer) {
    return this.helper(() => this.modifyInner(code, buffer));
  }
  private async modifyInner(code: string, buffer: Buffer) {
    const child = new SourceRuntime(
      this.initCode,
      { data: {}, settings: {}, logged: false, cookies: [] },
      async () => {
        throw new Error("图片处理脚本不提供网络或界面");
      },
      this.helperDepth + 1,
    );
    try {
      await child.open(
        `class ImageSource extends ComicSource { name='image';key='image';version='1.0.0'; }`,
      );
      const decoded = await sharp(buffer, { limitInputPixels: 40_000_000 })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const id = child.storePixels(
        decoded.info.width,
        decoded.info.height,
        decoded.data,
      );
      const result = await child.evaluate(
        `(()=>{${code}\nreturn modifyImage(new Image(${id}));})()`,
      );
      const image = child.images.get(result.key);
      if (!image) throw new Error("图片处理没有返回有效图片");
      return await sharp(image.data, {
        raw: { width: image.width, height: image.height, channels: 4 },
      })
        .png()
        .toBuffer();
    } finally {
      child.dispose();
    }
  }
  dispose() {
    if (this.closed) return;
    if (this.vm?.alive) {
      for (let n = 0; n < 8 && this.vm.runtime.hasPendingJob(); n++)
        this.pump();
    }
    this.closed = true;
    for (const task of this.helperQueue) task.reject(new Error("漫画源已释放"));
    this.helperQueue = [];
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    for (const handle of this.handles) if (handle.alive) handle.dispose();
    this.handles.clear();
    for (const deferred of this.deferred) deferred.dispose();
    this.deferred.clear();
    this.docs.clear();
    this.images.clear();
    this.vm?.runtime.removeInterruptHandler();
    try {
      this.vm?.dispose();
    } catch (error) {
      // Some native teardown paths retain a context reference.
      // The module is unique to this source: drop the entire WASM arena so a
      // teardown assertion cannot terminate other sources or the worker.
      this.disposalWarning = String(error);
    } finally {
      this.vm = undefined!;
    }
  }
}
