import type { SourceRuntime } from "./runtime";

export async function sourceImage(runtime: SourceRuntime, input: any) {
  const path = input.thumbnail ? "comic.onThumbnailLoad" : "comic.onImageLoad";
  let config = (await runtime.has(path))
    ? await runtime.call(path, [input.url, input.comicId, input.chapterId])
    : {};
  const configs: any[] = [];
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      config ||= {};
      configs.push(config);
      try {
        const response = await runtime.requestHTTP({
          method: "http",
          url: config.url || input.url,
          http_method: config.method || "GET",
          headers: config.headers || {},
          extra: input.refresh ? { cacheTime: "no" } : undefined,
          data: config.data,
          bytes: true,
          priority: input.priority,
          requestTag: input.jobId,
          image: true,
        });
        if (response.status < 200 || response.status >= 300 || !response.body)
          throw new Error(`图片请求失败 (${response.status})`);
        let buffer = response.body;
        if (config.onResponse?.$fn)
          buffer = await runtime.callback(config.onResponse, [buffer]);
        let result = Buffer.from(buffer);
        if (!input.thumbnail && config.modifyImage)
          result = await runtime.modify(config.modifyImage, result);
        return result;
      } catch (error) {
        if (!config.onLoadFailed?.$fn || input.thumbnail) throw error;
        config = await runtime.callback(config.onLoadFailed);
        if (!config) throw error;
      }
    }
    throw new Error("图片回退次数超过限制");
  } finally {
    configs.forEach((config) => runtime.drop(config));
  }
}
