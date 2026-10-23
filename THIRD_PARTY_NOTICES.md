# Third-party notices

## Wenku8 Flutter archive shelf

The archive shelf geometry, continuous extraction wave and inertial snapping are adapted from Wenku8 Flutter by mikufoxxx, MewX and contributors.

- Repository: https://github.com/mikufoxxx/Wenku8_Flutter
- Pinned revision: `689e8979002c69aaff60930fa45a9468998c51ab`.
- The Flutter distribution is GPL version 3 according to its NOTICE; the original GPL-2.0-or-later LICENSE is retained upstream. Both notices and the full GPL v3 text are preserved in `vendor/wenku8/`.
- The TypeScript adaptation in `archiveShelfModel.ts` remains GPL-3.0-only. The GPLv3/AGPLv3 combination uses the section 13 permission in those licenses; existing AGPL portions retain their license.
- Modifications dated 2026-10-22, provenance and unmodified reference Dart sources: `vendor/wenku8/ADAPTATIONS.md` and `vendor/wenku8/lib/`.
- Editable source, original reference sources and license notices are included in Kaleid-Source.zip; notices are also included in the desktop package. No novel files, cover images, illustrations, fonts, or Wenku8 branding are copied from that project.

## FFmpeg

The Windows desktop package includes the FFmpeg 6.1.1 static Windows build distributed by `ffmpeg-static` 5.3.0. The included build identifies itself as GPL v3 and its build configuration enables GPL and version 3 components. Its README and full license are shipped beside `ffmpeg.exe` in `resources/app.asar.unpacked/node_modules/ffmpeg-static/`.

- FFmpeg source revision: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93
- Windows build provider: https://www.gyan.dev/ffmpeg/builds/
- FFmpeg license information: https://www.ffmpeg.org/legal.html
- `ffmpeg-static` package: https://github.com/eugeneware/ffmpeg-static

The packaged binary's `ffmpeg.exe.README` and `ffmpeg.exe.LICENSE` are the authoritative build-specific notices. Review the corresponding source and redistribution terms when publishing installers.

## Native video playback components

The Windows x64 package includes mpv from the shinchiro mpv-winbuild-cmake `20261020` release, and FFprobe from `@ffprobe-installer/win32-x64` version `5.1.0`. Exact archive names, asset IDs or registry URLs, sizes and SHA-256 checksums are pinned in `scripts/video-runtime.json`, also shipped as `resources/video-runtime/runtime-lock.json`. Unmodified distribution documentation is retained beside the executables; copying files are included in `resources/video-runtime/licenses/`.

- mpv source revision: `6a262d11f6`, https://github.com/mpv-player/mpv/tree/6a262d11f6
- mpv's linked FFmpeg source revision: `38ac3a923`, https://github.com/FFmpeg/FFmpeg/tree/38ac3a923
- FFprobe source revision: `2296078397`, https://github.com/FFmpeg/FFmpeg/tree/2296078397 (Gyan essentials build dated 2023-02-13; GPL v3 or later as reported by `ffprobe -L`)
- FFprobe binary package: https://www.npmjs.com/package/@ffprobe-installer/win32-x64/v/5.1.0
- Windows build scripts and dependency source recipes: https://github.com/shinchiro/mpv-winbuild-cmake
- Pinned binary release: https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20261020
- mpv copying information: https://github.com/mpv-player/mpv/blob/6a262d11f6/Copyright
- FFmpeg licensing: https://ffmpeg.org/legal.html

These builds include GPL components. Their copyright, copying files and build recipes govern redistribution; include the corresponding source for the distributed build when publishing binaries. The Kaleid C# window host is part of this project's AGPL-3.0 source archive. Its self-contained .NET runtime is distributed under the .NET MIT license and runtime third-party notices shipped in `resources/video-runtime/host/`.

## FSRCNNX real-time upscaling shader

The package includes the unmodified `FSRCNNX_x2_8-0-4-1.glsl` shader from igv's FSRCNNX 1.1 release. Copyright (C) 2017–2021 igv. The shader's own header licenses it under LGPL-3.0-or-later; retain that header. Its full editable source is shipped in `resources/video-runtime/shaders/` and in the application source archive. LGPL-3.0 and the accompanying GPL-3.0 text are shipped in `resources/video-runtime/licenses/`.

- Release and corresponding source: https://github.com/igv/FSRCNN-TensorFlow/releases/tag/1.1
- Exact upstream shader URL and SHA-256: `scripts/video-runtime.json` (`shader` entry).
- Preparation verifies the bundled source checksum before copying it. No TensorFlow, Python, or separate model runtime is distributed for this feature.
- NVIDIA RTX processing uses the existing mpv Direct3D 11 interface and the user's installed NVIDIA driver. No NVIDIA RTX SDK redistributable is added.

## Folia Major

Music adapters, lyrics, visualizers, audio effects, and backend bridges are derived from Folia Major by chthollyphile and contributors.

- Repository: https://github.com/chthollyphile/folia-major
- Pinned revision: `26c57f9b1b26b402a09e8943171a332215418ce6`
- Upstream version: 0.7.21, as declared by that revision's package.json.
- License: GNU Affero General Public License, version 3 (`vendor/folia/LICENSE`, reproduced as the project's `LICENSE`).
- Kaleid modifications and boundaries: `vendor/folia/ADAPTATIONS.md`.
- This is a modified integration into Kaleid. It is not an official Folia release.
- The matching application and vendored source, dependency lockfiles, and build instructions are included in `Kaleid-Source.zip` alongside each preview package. Upstream copyright and license notices are retained in source files.

Other dependencies retain their respective package license files under node_modules. The source archive contains the lockfile required to reproduce their exact versions.

## 7-Zip comic archive runtime

Comic archive reading bundles the unmodified Windows x64 `7z.exe` and `7z.dll` from Igor Pavlov's official 7-Zip 26.04 distribution. The exact release URL, archive SHA-256 and individual file hashes are pinned in `scripts/comic-runtime.json`. `scripts/prepare-comic.mjs` verifies all hashes. The installer is unpacked into build artifacts; it is not run or installed on the user's computer.

- Upstream release and corresponding source: https://github.com/ip7z/7zip/releases/tag/26.04
- Copyright (C) 1999–2026 Igor Pavlov. Most code is GNU LGPL; other portions use BSD terms, and RAR decompression portions carry the unRAR restriction. The complete upstream `License.txt` is shipped beside the binaries in `resources/comic-runtime/`.
- This component is distributed separately from application code and is only invoked as a console process for local archive reading. No changes have been made to its binaries. Users may replace both binaries with compatible versions in that resource directory.
- Reader behaviour was researched using Venera, Mihon, OpenComic, Komga and Kavita. The local archive implementation incorporates no source files or assets from those applications. The separate online compatibility layer incorporates Venera init.js as described below.

## Venera online comic compatibility library

- Repository: https://github.com/CyrilPeng/Venera-Next
- Fixed revision: `4ac4a4e68644dc51ecee5144dd9398d071692e25`, upstream version `1.18.0+234`.
- `vendor/venera/init.js` is the unmodified `assets/init.js` from that revision, distributed under GPL-3.0. Its checksum and license checksum are recorded in `vendor/venera/UPSTREAM.json`; the GPL-3.0 license text is preserved in `vendor/venera/LICENSE`.
- Kaleid implements its own QuickJS host bridges, per-source Electron Session networking and reader/download integration. This integration is not an official Venera-Next release. The matching source and build inputs are included in `Kaleid-Source.zip`; integration changes and boundaries are documented in `vendor/venera/ADAPTATIONS.md`.
- Site scripts are installed separately at the user's request. The preset index is https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/index.json. Their licenses and notices remain governed by their upstream authors; the installer does not bundle these scripts. `scripts/comic-sources-baseline.json` records the tested script identities and hashes.
- QuickJS/quickjs-emscripten, Cheerio, iconv-lite and Sharp retain their upstream dependency licenses in the distributed node_modules. The checked QuickJS WASM variant is pinned to quickjs-emscripten 0.32.0.
