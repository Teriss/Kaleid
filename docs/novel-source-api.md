# Kaleid 小说源 JS 接口 v1

小说源是普通 JavaScript 文件，由应用内的 QuickJS 实例运行。每个安装来源都有独立实例、会话和持久化数据。脚本文件最大 4 MiB；单次脚本计算受内存、栈和执行时限约束。脚本没有 Node.js、Electron、文件系统或 `require`，网络和应用能力只能经由下文的 `host` 接口调用。

## 源类与元数据

脚本声明名为 `NovelSourceEntry` 的类，并继承全局基类 `NovelSource`。源码可以使用普通脚本语法，也可以在文件开头使用 `export` 或 `export default` 修饰声明。安装时应用创建类实例并读取 `meta`。

```js
class NovelSourceEntry extends NovelSource {
  constructor() {
    super({
      apiVersion: 1,
      id: "example-novels",
      name: "示例小说源",
      version: "1.0.0",
      url: "https://example.com/",
      updateUrl: "https://example.com/kaleid-source.js",
      assetReferer: "https://example.com/",
      capabilities: {
        search: true,
        latest: true,
        popular: false,
        login: [],
        exportEpub: false,
      },
      settings: {
        server: {
          title: "服务节点",
          type: "select",
          default: "https://api.example.com",
          options: [
            { value: "https://api.example.com", label: "默认节点" },
          ],
        },
      },
    });
  }

  // Implement search, discover, details and chapter as needed.
}
```

`id` 只能使用小写字母、数字、点、下划线和连字符，且必须以字母或数字开头；安装后保持稳定。`version` 使用数字点分版本。`updateUrl` 可省略；远程安装时应用也会使用安装的 JS 地址作为更新地址。本地文件没有可自动检查的更新地址。声明的功能必须实现对应方法：`search`、`discover`、`details`、`chapter`；`login` 中的 `password` 对应 `login(email, password)`，`exportEpub: true` 对应 `downloadEpub(novelId)`。

`assetReferer` 可选，用于设置应用下载封面和章节图片、字体等资源时发送的 `Referer` 请求头；未设置时使用 `url`。

支持的动态设置类型为 `input`、`select` 和 `switch`。每项可以提供 `title`、`default`；`select` 还需要 `options`，选项可写成字符串或 `{ value, label }`。`input` 可提供 `validator` 正则字符串。设置通过 `this.setting(key)` 读取，修改后实例会重新创建。

## 必需方法与数据结构

搜索和发现方法都返回 `{ novels, page, hasMore }`。每本作品至少有 `{ sourceId, novelId, title }`；也可带 `author`、`cover`、`description`、`updatedAt`。应用会将来源 ID 设为当前安装来源，并为封面建立本地缓存地址。

```js
async search(keyword, page) {
  return {
    novels: [{ sourceId: this.meta.id, novelId: "123", title: "作品" }],
    page,
    hasMore: false,
  };
}

async discover(kind, page) {
  return { novels: [], page, hasMore: false };
}

async details(novelId) {
  return {
    sourceId: this.meta.id,
    novelId,
    title: "作品",
    chapters: [{ id: "c1", title: "第一章", volume: "正文", order: 1 }],
  };
}

async chapter(novelId, chapter) {
  return { title: chapter.title, html: "<p>正文</p>", base: this.meta.url };
}
```

`discover(kind, page)` 的 `kind` 为 `latest` 或 `popular`。章节至少提供稳定的 `id`、`title` 和 `volume`，可选 `order`、`url`、`revision`。正文返回 `{ title, html, base, font? }`；应用清理不安全内容并把图片、字体资源打包进章节 EPUB。章节分页应在源方法内读取并合并，防止章节页链接被误认为下一章。详情可返回 `canExport` 和 `exportCost`，供源站原生 EPUB 的二次报价确认流程使用。

支持密码登录的源实现 `async login(email, password)` 和可选 `async isLogged()`。网页登录源在元数据声明 `login: ["webview"]`，并可提供同域 `loginUrl`；源站会在共享会话的沙箱窗口中打开。原生 EPUB 下载方法返回 `ArrayBuffer` 或 `Uint8Array`。不要把密码、令牌或 Cookie 写入源文件。

## 基类与宿主接口

`NovelSource` 提供：`this.meta`、`this.setting(key)`、`this.credentials`、`this.saveCredentials(object)`、`this.data`、`this.saveData()`、`this.isLogged()`、`this.cookieStatus(url, pattern?)` 和 `this.metadata()`。凭据通过 Electron `safeStorage` 加密后保存在本机；普通源数据保存在来源专属记录中。

全局 `host` 提供以下异步接口：

- `host.request(url, options?)`：通过当前来源的持久 Electron Session 发起请求，返回 `{ status, statusText, headers, body }`。默认 `body` 为按响应字符集解码的文本；指定 `responseType: "bytes"` 后返回字节数组。可传标准请求 `method`、`headers` 和 `body`。
- `host.query(html, selectors, remove?)`：用 Cheerio 查询 HTML，返回以选择器为键的结果数组；每项包含 `text`、`html`、`tag` 和 `attrs`。`remove` 可列出查询前需要移除的选择器。
- `host.browser({ url, keyword, page, inputSelectors, submitSelector, resultSelector, nextSelector })`：在来源会话的隐藏沙箱窗口中打开站点页面、填写搜索框并依次翻页，返回目标页 HTML。窗口只允许跳转到初始页面同源地址。
- `host.signalr({ url, accessToken, method, params, invokeOptions })`：通过 SignalR Long Polling 和 MessagePack 调用来源服务。
- `host.digest(value)`：返回 UTF-8 字符串的 SHA-256 小写十六进制摘要。
- `host.gunzip(bytes)`、`host.gunzipJson(bytes)`：解压 gzip 字节，后者再解析 UTF-8 JSON。
- `host.visitor()`：返回应用为匿名访问生成并持久保存的随机标识。
- `host.cookieStatus(url, pattern?)`：检查当前来源会话中指定网址是否存在匹配名称的 Cookie。
- `host.delay(milliseconds)`：等待指定时长，最大 60 秒。

网络、验证、权限和解析异常应使用清晰的错误文字；可用 `[auth-required]`、`[permission]`、`[verification]`、`[rate-limit]`、`[network]` 和 `[parse]` 前缀区分错误类型。浏览器验证由用户完成，来源脚本不应试图绕过验证码或访问控制。

## 仓库索引

仓库 URL 返回 JSON 数组，或对象中的 `sources` 数组。JSON 只提供脚本定位和预览信息，不实现小说源功能。`url`、`fileName` 或 `filename` 至少提供一个；相对路径相对于索引文件 URL 解析。应用支持 GitHub `blob` 文件链接并转换为 raw 文件地址。

```json
{
  "format": "kaleid-novel-index",
  "version": 1,
  "sources": [
    {
      "name": "示例小说源",
      "id": "example-novels",
      "version": "1.0.0",
      "description": "示例来源",
      "fileName": "example-novels.js"
    }
  ]
}
```

读取索引后，用户可预览并勾选来源。安装和更新时，应用会先在隔离的校验阶段解析脚本元数据，再保存脚本正文；校验阶段禁止调用宿主接口。
