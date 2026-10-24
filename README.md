# Kaleid

Kaleid 是一款面向 Windows 的本地优先多媒体浏览器，可在同一媒体库中整理和浏览图片、音乐、视频、小说与漫画。当前版本为 **0.4.0-preview.5**，仍处于预览阶段。

[下载与更新说明](https://github.com/Teriss/Kaleid/releases)

## 功能概览

- **媒体库**：按类型建立媒体库并添加一个或多个文件夹。应用索引和监听来源目录，原文件保留在原位置；收藏、阅读进度和浏览状态保存在应用数据中。
- **浏览布局**：可选墙面、空间网格、标准网格和封面流；图片还支持等高与等宽画廊，小说和漫画支持立体书架。收藏、搜索、排序和浏览历史可在库内使用。
- **音乐**：浏览本地音乐、维护队列和歌单、查看歌词，并使用均衡器、音效、桌面歌词及迷你控制。也可连接网易云音乐、QQ 音乐或 YouTube Music；在线内容受平台、地区和账号权限影响。
- **视频**：内置 mpv 播放常见格式，支持音轨与字幕选择、续播、画中画和片段导出；可选启用实时超分。
- **小说**：阅读 TXT、EPUB，支持目录、书签、阅读进度和排版设置；在线书源的可用内容取决于站点访问与账号权限。
- **漫画**：阅读图片目录、CBZ/ZIP、CBR/RAR 和 7z/CB7，支持双页、缩放、书签与连续翻章；也可配置兼容 Venera 的在线来源。

更多功能、来源和已知限制见[文档目录](docs/)。

## 安装与使用

1. 从 [Releases](https://github.com/Teriss/Kaleid/releases) 下载 `Kaleid-...-Setup.exe` 并运行安装程序。
2. 启动后创建媒体库，选择媒体类型并添加已有文件夹。
3. 在线音乐、小说、漫画及 AI 主题等功能，可按需在应用内登录或配置服务。

安装包面向 **Windows x64**。目前安装程序未签名，Windows 可能显示发布者无法验证的提示。升级时请使用相同的应用安装包；应用数据与媒体源目录分开保存。

## 从源码运行

构建环境：Windows x64、Node.js 24 或兼容版本，以及 .NET 10 SDK。

```powershell
git clone https://github.com/Teriss/Kaleid.git
cd Kaleid
npm ci
npm run dev
```

常用命令：

```powershell
npm run build   # 类型检查与生产构建
npm run preview # 预览生产构建
npm run dist    # 构建 Windows x64 安装包及源码归档
```

开发和打包首次运行时会下载并准备视频、漫画所需的固定版本运行组件，因此需要网络连接。`npm run dist` 生成的安装程序保存在 `release/` 目录。

## 已知限制

- 当前为预览版，仅针对 Windows x64 打包和验收；macOS 与 Linux 尚未验收。
- 暂不支持 DRM 保护的 EPUB、PDF，以及加密或分卷漫画压缩包。
- 在线服务依赖第三方站点，功能、登录方式与内容可用性可能随站点变化。
- 音乐服务仍有部分上游功能处于移植中，详情见[音乐移植说明](docs/music-port-status.md)。
- 视频超分效果与兼容性取决于显卡、驱动和媒体编码。

各功能的详细行为与测试边界见：[视频播放](docs/video-playback.md)、[漫画阅读](docs/comic-reader.md)、[在线小说](docs/online-novels.md)、[在线漫画](docs/online-comics.md)、[导航与音乐墙面](docs/navigation-and-music-wall.md)。

## 数据与许可

媒体文件留在用户选择的来源目录。索引数据库、缓存、阅读进度及应用设置保存在 Electron 用户数据目录中；升级不会把这些数据写入媒体文件夹。

### 许可证与上游项目

Kaleid 自有代码按 GNU Affero General Public License v3.0 only（**AGPL-3.0-only**）发布，见 [LICENSE](LICENSE)。项目也包含按各自许可证保留的上游代码或适配：

- [Folia Major](https://github.com/chthollyphile/folia-major)：音乐、歌词、可视化及相关服务代码，采用 AGPL-3.0；集成版本和改动见 [`vendor/folia/ADAPTATIONS.md`](vendor/folia/ADAPTATIONS.md)。
- [Wenku8 Flutter](https://github.com/mikufoxxx/Wenku8_Flutter)：立体书架几何与运动算法的适配及参考源码。适配部分采用 GPL-3.0-only，上游声明和许可证文本保留在 `vendor/wenku8/`；详情见 [`vendor/wenku8/ADAPTATIONS.md`](vendor/wenku8/ADAPTATIONS.md)。
- [Venera-Next](https://github.com/CyrilPeng/Venera-Next)：随附的 `vendor/venera/init.js` 来自其固定版本，采用 GPL-3.0。Kaleid 自行实现兼容宿主；本项目不是 Venera 或 Venera-Next 的官方发行版。

上游代码仍受各自许可证和版权声明约束，本项目不代表获得上述项目的官方背书。固定版本、修改记录、完整许可证及其他发行组件的声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `vendor/` 下的说明文件。每个 Release 同时提供 Kaleid 源码归档。
