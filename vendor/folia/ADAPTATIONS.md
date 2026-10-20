# Kaleid integration notes

Upstream is fixed at `26c57f9b1b26b402a09e8943171a332215418ce6`, version 0.7.21. This folder is not a moving Git submodule. Keep its original license and comments. The original application entry points are retained as source references but are never started by Kaleid.

Local changes to upstream:

- `src/services/yingjianTransport.ts`: NetEase/QQ HTTP is routed to the restricted main-process MusicAPI. Ports 1 and 2 in the renderer facade are transport selectors, not listening servers.
- `src/services/yingjianProxy.ts`: QQ/KuGou auxiliary lyrics/search requests use an explicit main-process host allowlist.
- `src/services/onlineMusic/{netease/netease.ts,qq/qqTransport.ts,kugou/kugouTransport.ts,kugou/kugouLyricProvider.ts,qq/qqLyricProvider.ts}` import those transports; normalization and platform behavior otherwise stay upstream.
- `src/services/onlineMusic/providerStorage.ts`: session markers are memory-only. Reusable NetEase/QQ cookies live encrypted in the host; Bodian/KuGou/YTM/Spotify retain their upstream encrypted session repositories.
- `electron/qq/qqApiStartup.cjs`: while the package synchronously creates its HTTP server, the selected port is bound to `127.0.0.1` rather than every network interface. The temporary listen override is always restored.
- `electron/yingjianThemePrompt.cjs`: unchanged theme prompt/schema functions extracted from pinned `electron/main.cjs` so the upstream application main process is not executed.

Host adapters live in `src/main/music.ts`, `src/shared/music.ts`, and `src/renderer/src/music/`. Bundled dependencies are locked by the root package-lock.json. Renderer JavaScript facades intentionally isolate the vendored TypeScript compiler configuration; Vite still bundles the imported source and its lazy renderer/worker modules.

Only features actually connected to the host should be described as ported. See `docs/music-port-status.md` for current wiring and validation gaps, including the unported dual-deck engine and Folium host. An upstream source file being present here does not mean it is enabled.

Preview 3 UI adapters also import the pinned wall flip/wave and seam planners, hex geometry/falloff, ArtistPicture and grid morph flight/fly-in/scatter functions through `src/renderer/src/layouts/foliaGeometry.js`. The host supplies its own media identity, paged sources, slot metrics and independent navigation journals; upstream account, playback and application stores are not started by these geometry adapters. The host tile face handover follows the pinned BravaisTile two-phase WAAPI lifecycle. Source page semantics map to carousel/collection/artist/explore scenes; this is not a second embedded Folia UI.

The wall-engine reconstruction additionally imports pinned block templates/reflows, wall slots, wrap-period/start-offset rules, device-pixel transform formatting, seam planning, and wheel classification/smoothing through `src/renderer/src/layouts/foliaWall.js`. The host input hook adapts Folia's gesture latch and inertia rules to its world-centre camera and button-based media posters. The two world halves, culled React display, unified face animation plan, and seam levels remain host adapters. No upstream source changes are needed for this reconstruction; implementation and validation are documented in `docs/wall-engine.md`.
