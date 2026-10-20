# Third-party notices

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
