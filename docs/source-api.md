# 漫画、小说源配置与 API

Kaleid 提供漫画和小说源的 JavaScript 运行环境。应用不内置站点源，不预填或推荐源仓库；需要使用在线内容时，由用户导入兼容脚本。漫画源使用 Venera 兼容接口，小说源使用 Kaleid NovelSource API v1，两种脚本不能互换。

[配置与导入](#configuration) · [漫画源 API](#comic) · [小说源 API](#novel) · [常见问题](#faq)

<a id="configuration"></a>

## 配置与导入

### 漫画源

1. 切换到漫画，在首页的漫画源区域进入“管理漫画源”，点击“添加漫画源”。
2. 在空白地址框中粘贴仓库索引 JSON 或单个 JS 脚本的原始文件地址，然后点击“读取／导入”；也可点击“导入文件”选择本地 `.js`。
3. 仓库索引会显示源列表，未安装的源默认勾选。按需取消选择，再批量导入；直接提供脚本地址时会安装该脚本。
4. 在源管理页面启用所需来源，打开源设置调整域名、节点等脚本声明的选项；有账号功能的来源可按其能力使用密码、Cookie 或网页登录。
5. 在“设置 → 漫画搜索”中，可为每个来源设置自动添加的语言筛选标签。

已有来源可检查更新、更新、禁用或卸载。域名和节点是否可改，由脚本的设置声明决定。

### 小说源

1. 切换到小说，进入来源管理，在“添加小说源”中提供脚本或仓库地址。
2. 读取仓库后选择来源并导入，或直接导入本地 `.js`。小说还支持导入本地 JSON 索引和它引用的同目录脚本。
3. 在来源设置中调整脚本声明的 API 节点或其他选项；按来源能力进行密码登录或网页登录。
4. 启用来源后可搜索、查看最新或热门列表、打开详情与目录，并阅读或下载章节。

源站原生 EPUB 导出由脚本提供；只有支持此能力的来源才显示对应入口，费用确认与阅读权限由源站决定。

### 私有来源与地址

自己编写的源可以只作为本地 JS 文件保存和导入，无须公开仓库。项目的 `local-sources/` 用于本地存档，不进入 Git 提交或源码发行包。

脚本链接需要直接返回 JS，仓库链接需要直接返回 JSON，不能返回登录页或普通网页。支持 GitHub 的 `blob` 文件链接转换为原始文件地址；读取仓库不会使用浏览器的 GitHub 登录状态。私有仓库无法直接读取时，可先将脚本下载到本地再导入。

源站首页、业务 API 地址和源脚本地址用途不同：只有 JS 脚本或索引 JSON 能用于安装，业务 API 节点应填到该来源提供的设置项中。

<a id="comic"></a>

## 漫画源 API

### 最小源脚本

保存为 `example-comic.js`。这个示例演示源的结构和返回值，图片地址为占位地址；实际使用时应替换为自己的服务和图片。

```js
class ExampleComicSource extends ComicSource {
  name = "示例漫画源";
  key = "example_comic";
  version = "1.0.0";
  url = "https://example.com/sources/example-comic.js";

  settings = {
    apiBase: {
      title: "API 地址",
      type: "input",
      default: "https://example.com/api",
    },
  };

  search = {
    load: async (keyword, options, page) => ({
      comics: page === 1 ? [new Comic({
        id: "book-1",
        title: "示例漫画",
        cover: "https://example.com/cover.jpg",
      })] : [],
      maxPage: 1,
    }),
  };

  comic = {
    loadInfo: async (comicId) => new ComicDetails({
      title: "示例漫画",
      cover: "https://example.com/cover.jpg",
      description: "将这里替换为详情 API 的返回数据。",
      chapters: { "chapter-1": "第一章" },
    }),
    loadEp: async (comicId, chapterId) => [
      "https://example.com/pages/1.jpg",
      "https://example.com/pages/2.jpg",
    ],
  };
}
```

脚本必须声明一个继承 `ComicSource` 的入口类。`key` 是稳定的来源标识，只能包含英文字母、数字和下划线，并以字母或下划线开头；更新时不要改变。`name` 用于显示，`version` 使用数字点分版本。`url` 是脚本更新地址，可与业务服务的域名不同；从远程安装时，安装地址也会用于后续更新。

### 搜索、详情与章节

- `search.load(keyword, options, page)`：页码从 1 开始，返回 `{ comics, maxPage? }`。`comics` 中的作品应包含稳定的 `id` 和 `title`，可带 `cover`、`subtitle`、`description`、`tags` 等。
- 使用游标分页时，可实现 `search.loadNext(keyword, options, next)`，返回 `{ comics, next }`；首次调用的 `next` 为 `null`。同时提供两种方法时，宿主优先使用 `load`。
- `comic.loadInfo(comicId)`：返回 `ComicDetails` 或结构相同的对象。章节用 `{ "章节ID": "章节名称" }` 表示，也可用嵌套对象表示章节分组。所有分组中的章节 ID 必须唯一。
- 无分章作品可将 `chapters` 设为 `null`；宿主会以 `chapterId = null` 请求正文。
- `comic.loadEp(comicId, chapterId)`：按阅读顺序返回图片 URL 数组。不要在这个数组中混入章节页地址。
- 封面、预览图和章节图片应返回绝对 URL；需要请求头、响应转换或图片处理时，使用相应图片加载钩子。

阅读方向、双页、缩放、翻章、进度和下载队列由 Kaleid 负责，源脚本提供作品、章节和图片数据。

### 网络、设置与存储

脚本通过 `Network` 请求站点，不依赖 Node.js 或浏览器原生 `fetch`。例如，将下面的函数加入源类，再由搜索、详情或章节方法调用：

```js
async requestJson(path) {
  const base = this.loadSetting("apiBase").replace(/\/$/, "");
  const response = await Network.get(base + path, {
    Accept: "application/json",
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("接口请求失败：HTTP " + response.status);
  }
  return JSON.parse(response.body);
}
```

- `Network.get(url, headers?, extra?)`、`Network.post(url, headers?, data?, extra?)` 和 `Network.sendRequest(method, url, headers?, data?, extra?)` 返回 `{ status, headers, body }`，文本响应的 `body` 是字符串。
- `Network.fetchBytes(method, url, headers?, data?, extra?)` 返回二进制响应；不要把二进制正文当作 JSON 解析。
- `Network.getCookies(url)`、`Network.setCookies(url, cookies)`、`Network.deleteCookies(url)` 管理当前源会话的 Cookie。
- `HtmlDocument` 提供 HTML 查询，`Convert` 提供编码、摘要等工具；具体参数以随项目保留的兼容库 [init.js](../vendor/venera/init.js) 为准。
- `this.loadSetting(key)` 读取用户设置或默认值。常用设置类型为 `input`、`select`、`switch`；`select.options` 可使用字符串或 `{ value, text }`。`callback` 类型用于来源自定义操作。
- `this.loadData(key)`、`this.saveData(key, value)`、`this.deleteData(key)` 访问来源专属持久数据；`this.isLogged` 读取登录状态。不要自行构造宿主的来源身份字段。

例如，域名切换可声明为：

```js
settings = {
  apiBase: {
    title: "API 地址",
    type: "select",
    default: "https://example.com/api",
    options: [
      { value: "https://example.com/api", text: "主节点" },
      { value: "https://mirror.example.com/api", text: "备用节点" },
    ],
  },
};
```

按需实现 `explore`、`category` / `categoryComics`、`favorites`、`account`、预览图和图片加载钩子；界面会按来源声明显示相应入口。使用上游扩展文档时，应同时核对本项目的兼容库及实际宿主实现，不能假定其他 Venera 分支的新增接口已经接通。

### 漫画仓库索引

漫画仓库必须是 JSON 数组。把 `index.json` 和脚本放到自己的 HTTP(S) 服务，读取索引地址后即可选择安装：

```json
[
  {
    "name": "示例漫画源",
    "key": "example_comic",
    "version": "1.0.0",
    "description": "自行维护的漫画服务",
    "fileName": "example-comic.js"
  }
]
```

`url`、`fileName` 或 `filename` 至少提供一个，支持相对于索引 URL 的脚本路径。索引只列出脚本，不承载搜索、登录和解析逻辑。本地漫画导入请选择 JS；把本地索引和脚本放在同一目录不会自动批量安装。

<a id="novel"></a>

## 小说源 API v1

### 最小源脚本

保存为 `example-novel.js`。示例使用静态目录和正文，可用于理解导入与阅读流程；对接实际网站时替换方法内部的数据获取逻辑。

```js
class NovelSourceEntry extends NovelSource {
  constructor() {
    super({
      apiVersion: 1,
      id: "example-novel",
      name: "示例小说源",
      version: "1.0.0",
      url: "https://example.com/",
      capabilities: {
        search: true,
        latest: false,
        popular: false,
        login: [],
        exportEpub: false,
      },
      settings: {
        apiBase: {
          title: "API 地址",
          type: "input",
          default: "https://example.com/api",
        },
      },
    });
  }

  async search(keyword, page) {
    return {
      novels: page === 1 ? [{
        sourceId: this.meta.id,
        novelId: "book-1",
        title: "示例小说",
      }] : [],
      page,
      hasMore: false,
    };
  }

  async details(novelId) {
    return {
      sourceId: this.meta.id,
      novelId,
      title: "示例小说",
      chapters: [{ id: "chapter-1", title: "第一章", volume: "正文" }],
    };
  }

  async chapter(novelId, chapter) {
    return {
      title: chapter.title,
      html: "<p>这里是示例正文。</p>",
      base: this.meta.url,
    };
  }
}
```

### 元信息与动态设置

入口类名固定为 `NovelSourceEntry`，基类为 `NovelSource`。`apiVersion` 当前为 `1`；`id` 最长 64 字符，仅含小写字母、数字、点、下划线、连字符，并以字母或数字开头。更新时保持 ID 不变。

`url` 是源站主页，`updateUrl` 可单独指定 JS 更新地址，`assetReferer` 可指定封面、图片和字体请求的 Referer；未指定时使用主页。远程安装地址可作为更新地址；本地脚本若没有 `updateUrl`，需手动重新导入更新。

`capabilities` 中的 `search`、`latest`、`popular`、`exportEpub` 必须是布尔值，`login` 必须是数组；`settings` 即使为空也必须提供。只有声明并实现对应能力，应用才会显示相应入口。构造函数和元信息读取阶段不要请求网络或调用 `host`，安装校验阶段会拒绝宿主调用。

设置支持 `input`、`select`、`switch`，通过 `this.setting(key)` 读取。选项对象使用 `{ value, label }`，与漫画源的 `text` 字段不同。`input` 可提供正则字符串 `validator`。设置改变后宿主会重建源实例。

```js
settings: {
  apiBase: {
    title: "API 节点",
    type: "select",
    default: "https://example.com/api",
    options: [
      { value: "https://example.com/api", label: "主节点" },
      { value: "https://mirror.example.com/api", label: "备用节点" }
    ]
  },
  useImages: { title: "显示插图", type: "switch", default: true }
}
```

### 方法与返回值

- `search(keyword, page)`：声明 `search: true` 时实现，返回 `{ novels, page, hasMore }`，页码从 1 开始。
- `discover(kind, page)`：声明 `latest` 或 `popular` 时实现，`kind` 为 `"latest"` 或 `"popular"`，返回结构与搜索相同。
- `details(novelId)`：必须实现，返回作品信息和 `chapters`。作品最少提供 `novelId`、`title`，可带 `author`、`cover`、`description`、`updatedAt`；宿主会使用当前来源身份。
- `chapter(novelId, chapter)`：必须实现，返回 `{ title, html, base, font? }`。`chapter` 是目录中的章节对象，至少包含稳定的 `id`、`title`、`volume`，可提供 `url`、`order`、`revision`。
- 正文由应用清理并将相关图片、字体处理为章节阅读资源。`base` 用于解析相对资源地址，章节分页需要在源方法内获取并合并。
- `login(email, password)`：声明 `login: ["password"]` 时必须实现。可重写 `isLogged()` 检查有效登录状态。
- 网页登录声明 `login: ["webview"]`，可指定与主页同源的 `loginUrl`；登录窗口与源网络请求共享会话。
- `downloadEpub(novelId)`：声明 `exportEpub: true` 时必须实现，返回 `ArrayBuffer` 或 `Uint8Array`；详情可提供 `canExport`、`exportCost` 供导出确认使用。

### 网络与宿主能力

在源方法内部通过 `host` 请求网络。例如：

```js
const base = this.setting("apiBase").replace(/\/$/, "");
const response = await host.request(base + "/search?q=" + encodeURIComponent(keyword), {
  method: "GET",
  headers: { Accept: "application/json" },
});
if (response.status < 200 || response.status >= 300) {
  throw new Error("[network] HTTP " + response.status);
}
const data = JSON.parse(response.body);
```

- `host.request(url, options?)`：返回 `{ status, statusText, headers, body }`。请求可设置 `method`、`headers`、`body`；默认正文为文本，`responseType: "bytes"` 时返回字节数组。
- `host.query(html, selectors, remove?)`：`selectors` 为 CSS 选择器数组，返回以选择器为键的数组；元素包含 `text`、`html`、`tag`、`attrs`。`remove` 为查询前移除的选择器数组。
- `host.browser({ url, keyword, page, inputSelectors, submitSelector, resultSelector, nextSelector })`：在隐藏窗口中搜索和翻页，返回目标 HTML；导航限于初始页面同源。
- `host.signalr({ url, accessToken, method, params, invokeOptions })`：通过 Long Polling 和 MessagePack 调用 SignalR 服务。
- `host.digest(value)`：UTF-8 字符串的 SHA-256 摘要；`host.gunzip(bytes)`、`host.gunzipJson(bytes)`：gzip 解压及解压后 JSON 解析。
- `host.cookieStatus(url, pattern?)`：检查当前来源会话 Cookie；`host.visitor()`：读取持久匿名标识；`host.delay(ms)`：等待，最多 60 秒。

基类提供 `this.credentials`、`this.saveCredentials(object)`、`this.data`、`this.saveData()`、`this.cookieStatus(url, pattern?)` 等接口。凭据会加密存储，普通数据通过来源专属记录保存。脚本运行于受限 QuickJS 实例中，没有 Node.js、Electron、`require` 或直接文件系统权限；单个操作最多等待约 30 秒，不能用长轮询或无限重试维持任务。

### 小说仓库索引

小说索引支持 JSON 数组，也支持带 `sources` 数组的对象。例如：

```json
{
  "format": "kaleid-novel-index",
  "version": 1,
  "sources": [
    {
      "name": "示例小说源",
      "id": "example-novel",
      "version": "1.0.0",
      "fileName": "example-novel.js"
    }
  ]
}
```

在线条目至少提供 `url`、`fileName` 或 `filename`，相对路径按索引 URL 解析。本地 JSON 导入只读取索引目录内的相对 JS 文件：使用 `fileName` 或 `filename`，并将脚本一起保存；本地索引不能用远程 `url` 代替文件名。

<a id="faq"></a>

## 常见问题

- **只填站点 API 地址可以用吗？** 需要对应脚本把站点数据映射到以上接口；在源管理的安装框填 API 地址不会自动生成脚本。
- **地址返回网页或 GitHub 登录页？** 改用原始 JS / JSON 地址，或下载脚本后本地导入。
- **仓库读取成功但源无法使用？** 读取索引只证明文件可访问；继续检查脚本兼容性、启用状态、节点、网络及账号权限。
- **封面或正文资源失败？** 检查实际资源 URL、Cookie、Referer 与服务返回状态；区分 JSON 接口和图片、字体二进制响应。
- **HTTP 401 / 403 或验证页面？** 在来源支持的登录入口完成登录或验证；软件不自动解决站点验证码和访问限制。
- **修改源后怎样更新？** 保持 `key` / `id` 稳定，提高 `version` 后检查更新，或重新导入同标识 JS；不要把账号凭据写进脚本或仓库。

源脚本可提供清晰的错误信息。小说源支持以 `[auth-required]`、`[permission]`、`[verification]`、`[rate-limit]`、`[network]`、`[parse]` 标注错误类别，便于区分登录、访问和解析问题。

返回 [项目首页](../README.md)。
