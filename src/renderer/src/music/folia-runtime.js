// Type isolation at the vendored boundary; upstream remains pinned, locally
// patched only at the transport/session seams documented in ADAPTATIONS.md.
let loading;
export function runtime() {
  if (!loading) {
    window.electron = {
      fetchLyricProxy: async (url, init) => {
        const answer = await window.music.proxy(url, init);
        return {
          ...answer,
          ok: answer.status >= 200 && answer.status < 300,
          statusText: "",
        };
      },
      getNeteasePort: async () => 1,
      getQqPort: async () => 2,
      getNeteaseApiStatus: async () => ({ status: "running", port: 1 }),
      getQqApiStatus: async () => ({ status: "running", port: 2 }),
      kugouRequest: (op, params) => window.music.request("kugou", op, params),
      bodianRequest: (op, params) => window.music.request("bodian", op, params),
      ytmRequest: (op, params) => window.music.request("ytm", op, params),
      spotifyRequest: (op, params) =>
        window.music.request("spotify", op, params),
      getKugouApiStatus: async () => ({ status: "running" }),
    };
    loading =
      import("../../../../vendor/folia/src/services/onlineMusic/providerRegistry").then(
        (registry) => ({
          list: registry.listOnlineMusicProviders,
          provider: registry.requireOnlineMusicProvider,
          register: registry.registerOnlineMusicProvider,
          unregister: registry.unregisterOnlineMusicProvider,
        }),
      );
  }
  return loading;
}
