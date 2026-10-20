# Third-party notices

## FFmpeg

The Windows desktop package includes the FFmpeg 6.1.1 static Windows build distributed by `ffmpeg-static` 5.3.0. The included build identifies itself as GPL v3 and its build configuration enables GPL and version 3 components. Its README and full license are shipped beside `ffmpeg.exe` in `resources/app.asar.unpacked/node_modules/ffmpeg-static/`.

- FFmpeg source revision: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93
- Windows build provider: https://www.gyan.dev/ffmpeg/builds/
- FFmpeg license information: https://www.ffmpeg.org/legal.html
- `ffmpeg-static` package: https://github.com/eugeneware/ffmpeg-static

The packaged binary's `ffmpeg.exe.README` and `ffmpeg.exe.LICENSE` are the authoritative build-specific notices. Review the corresponding source and redistribution terms when publishing installers.

## Folia Major

Music adapters, lyrics, visualizers, audio effects, and backend bridges are derived from Folia Major by chthollyphile and contributors.

- Repository: https://github.com/chthollyphile/folia-major
- Pinned revision: `26c57f9b1b26b402a09e8943171a332215418ce6`
- Upstream version: 0.7.21, as declared by that revision's package.json.
- License: GNU Affero General Public License, version 3 (`vendor/folia/LICENSE`, reproduced as the project's `LICENSE`).
- Yingjian modifications and boundaries: `vendor/folia/ADAPTATIONS.md`.
- This is a modified integration into Yingjian. It is not an official Folia release.
- The matching application and vendored source, dependency lockfiles, and build instructions are included in `Yingjian-Source.zip` alongside each preview package. Upstream copyright and license notices are retained in source files.

Other dependencies retain their respective package license files under node_modules. The source archive contains the lockfile required to reproduce their exact versions.
