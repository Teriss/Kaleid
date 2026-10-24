# 第三方版权与许可说明

Kaleid 自有代码按 [GNU AGPL v3.0 only](LICENSE) 发布（SPDX：`AGPL-3.0-only`）。本文记录实际引入或适配的代码、数据和发行组件；它不替代各组件的完整许可证，也不将第三方作品重新授权为 Kaleid 自有代码。

## 代码许可与发行

Folia 的 AGPLv3 代码已与应用集成，Kaleid 继续使用现有 AGPL-3.0-only 主体许可。Wenku8 和 Venera 相关 GPLv3 部分保留其许可证，组合按 GPLv3 / AGPLv3 第 13 条处理。

分发修改版本或安装包时，需要保留上游版权、许可、修改说明，并按相应许可提供匹配的完整源代码与构建材料。AGPL 对修改版本的网络交互另有第 13 条要求。仅写“参考了某项目”或添加致谢，不能代替实际复制、适配代码时的许可义务；AGPL 本身也不能附加“禁止商用”等额外限制。

项目通过 `npm run source:bundle` 生成 `artifacts/Kaleid-Source.zip`。发布者应核对其中的源码、固定依赖和构建输入，并与安装包一起提供；外部二进制组件还应提供其相应构建的源代码获取方式和许可材料。生成归档本身不等于已经完成全部发行义务。

## Folia Major

- 项目：[chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)，作者 chthollyphile 及贡献者。
- 固定提交：`26c57f9b1b26b402a09e8943171a332215418ce6`，该提交版本 0.7.21。
- 许可：GNU AGPL v3，完整文本保留在 [vendor/folia/LICENSE](vendor/folia/LICENSE)。
- 实际用途：音乐适配、歌词、可视化、音效、后台桥接及部分墙面与网格几何算法。
- 修改与边界：[vendor/folia/ADAPTATIONS.md](vendor/folia/ADAPTATIONS.md)，来源记录：[UPSTREAM.json](vendor/folia/UPSTREAM.json)。

Kaleid 使用自己的应用外壳和播放整合。保留的上游文件不表示所有 Folia 功能均已启用；当前不提供其双音轨混音引擎和 Folium 插件宿主。

## Wenku8 Flutter

- 项目：[mikufoxxx/Wenku8_Flutter](https://github.com/mikufoxxx/Wenku8_Flutter)，作者 mikufoxxx、MewX 及上游贡献者。
- 固定提交：`689e8979002c69aaff60930fa45a9468998c51ab`。
- 其原始 [LICENSE](vendor/wenku8/LICENSE) 保留 GPL-2.0-or-later 声明；固定版本的 [NOTICE](vendor/wenku8/NOTICE) 声明 Flutter 组合发行使用 GPLv3，完整文本保留在 [GPL-3.0.txt](vendor/wenku8/GPL-3.0.txt)。
- Kaleid 将书架几何、连续抽取波和惯性吸附算法适配到 TypeScript；适配部分保留 GPL-3.0-only 许可。
- 2026-10-22 的修改记录及未修改的 Dart 参考源码见 [vendor/wenku8/ADAPTATIONS.md](vendor/wenku8/ADAPTATIONS.md) 和 `vendor/wenku8/lib/`。

未复制其小说内容、封面、插图、品牌或字体资源。

## Venera 与 Venera-Next

- 接口原始项目：[venera-app/venera](https://github.com/venera-app/venera)，GNU GPL v3。
- 直接来源：[CyrilPeng/Venera-Next](https://github.com/CyrilPeng/Venera-Next)，固定提交 `4ac4a4e68644dc51ecee5144dd9398d071692e25`，版本 `1.18.0+234`。
- `vendor/venera/init.js` 基于该提交的 `assets/init.js`，GPLv3 完整文本见 [vendor/venera/LICENSE](vendor/venera/LICENSE)。
- Kaleid 修改了 `Network.setCookies` 和 `Network.deleteCookies`，使其返回宿主操作结果，支持调用者等待 Cookie 写入或删除完成；不能将本地文件描述为“未经修改的上游文件”。
- 上游与本地校验值见 [UPSTREAM.json](vendor/venera/UPSTREAM.json)，集成与修改记录见 [ADAPTATIONS.md](vendor/venera/ADAPTATIONS.md)。

Kaleid 自行实现 QuickJS 宿主、网络会话和阅读、下载整合。站点脚本由用户单独安装，不随应用、源码包发布，也不提供默认仓库。Kaleid 不是 Venera 或 Venera-Next 的官方发行版。

## EhTagTranslation 标签数据

`vendor/venera/tags.json` 是独立数据集，原始数据来自 [EhTagTranslation/Database](https://github.com/EhTagTranslation/Database)，当前文件直接取自 Venera-Prime 提交 `04ff27009d8379c3e0368a31ee08efe02d241d0c` 的 `assets/tags.json`，未修改数据内容。

- 许可：[CC BY-NC-SA 3.0 中国大陆](https://creativecommons.org/licenses/by-nc-sa/3.0/cn/)。
- 本地完整文本：[TAGS_LICENSE.md](vendor/venera/TAGS_LICENSE.md)。
- 来源、固定提交和校验值：[TAGS_UPSTREAM.json](vendor/venera/TAGS_UPSTREAM.json)。

该数据不按 AGPL 重新授权。使用和分发时应署名、保留许可、遵守非商业性使用与相同方式共享条件。不能据此宣称软件代码也“禁止商用”，也不能把整套发行物描述为全部仅受 AGPL 约束。计划提供可商业再分发的完整发行物时，需要移除或替换这份数据，或取得相应额外授权。

## 小说源传输依赖

Microsoft SignalR JavaScript 客户端和 MessagePack 协议包固定为 10.0.11，按 MIT 许可使用，原始声明保留在依赖包中。

`host.signalr` 供用户安装的小说源按需调用。小说源脚本、小说正文、账号凭据和站点品牌资源不随应用发布。源脚本自身及站点内容的权利归属与访问条件由对应作者和服务提供方决定。

## 视频与漫画运行组件

### FFmpeg

- 随 `ffmpeg-static` 5.3.0 提供 Windows FFmpeg 6.1.1 静态构建，该二进制报告启用了 GPLv3 组件。
- 源码提交：[e38092ef93](https://github.com/FFmpeg/FFmpeg/commit/e38092ef93)，构建提供者：[Gyan](https://www.gyan.dev/ffmpeg/builds/)。
- 构建专用 `ffmpeg.exe.README` 和 `ffmpeg.exe.LICENSE` 随二进制保留，位置为 `resources/app.asar.unpacked/node_modules/ffmpeg-static/`。
- 许可与源代码义务以相应构建为准，参见 [FFmpeg 法律说明](https://www.ffmpeg.org/legal.html)。

### mpv、FFprobe 与视频宿主

- Windows mpv 固定为 [mpv-winbuild-cmake 20261020](https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20261020) 构建，mpv 源码提交 `6a262d11f6`，其 FFmpeg 源码提交 `38ac3a923`。
- FFprobe 来自 `@ffprobe-installer/win32-x64` 5.1.0，源码提交 `2296078397`，构建报告 GPLv3-or-later。
- 精确下载地址、文件大小、哈希及组件版本在 `scripts/video-runtime.json` 固定，并随包保存为 `resources/video-runtime/runtime-lock.json`。
- 未修改的发行说明和 COPYING 材料保留在 `resources/video-runtime/` 及 `licenses/`。构建和依赖来源见 [mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake) 与 [mpv Copyright](https://github.com/mpv-player/mpv/blob/6a262d11f6/Copyright)。

这些二进制包含 GPL 组件，发布者需要核对并提供对应构建的源代码材料。Kaleid 的 C# 视频窗口宿主属于本项目 AGPL 源码；其随附 .NET 运行时保留 MIT 许可及运行时第三方声明。

### FSRCNNX 超分着色器

保留 igv 的 [FSRCNNX 1.1](https://github.com/igv/FSRCNN-TensorFlow/releases/tag/1.1) 原始 `FSRCNNX_x2_8-0-4-1.glsl`，版权属于 igv（2017–2021），按文件头的 LGPL-3.0-or-later 许可。

完整可编辑着色器在 `scripts/video-shaders/` 和发行资源中保留；LGPLv3 与 GPLv3 文本随运行组件提供。来源和校验值见 `scripts/video-runtime.json`。NVIDIA RTX 处理通过 mpv 与用户驱动调用，没有另行附带 NVIDIA RTX SDK 再发行包。

### 7-Zip

使用 Igor Pavlov 的官方 [7-Zip 26.04](https://github.com/ip7z/7zip/releases/tag/26.04) Windows x64 `7z.exe` 与 `7z.dll`，二进制未经修改。固定版本与校验值见 `scripts/comic-runtime.json`。

Copyright (C) 1999–2026 Igor Pavlov。主要代码使用 LGPL，部分使用 BSD 条款，RAR 解压部分另有 unRAR 限制；完整 `License.txt` 随 `resources/comic-runtime/` 提供。7-Zip 作为独立控制台进程处理本地归档，用户可用兼容版本替换该目录中的二进制。

## 其他依赖

QuickJS / quickjs-emscripten、Cheerio、iconv-lite、Sharp 及其他依赖保留各自包内的版权和许可证。精确依赖版本由 `package-lock.json` 固定；本项目的主体许可不覆盖或取消这些独立声明。
