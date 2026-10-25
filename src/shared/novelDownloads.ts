import type { NovelDownloadTask } from "./onlineNovels";

const textOrder = new Intl.Collator("zh-CN");

/** Compare decimal values without rounding long integers or fractional parts. */
function compareDecimal(a: string, b: string) {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const left = ai.replace(/^0+/, "") || "0";
  const right = bi.replace(/^0+/, "") || "0";
  if (left.length !== right.length) return left.length - right.length;
  if (left !== right) return left < right ? -1 : 1;
  const length = Math.max(af.length, bf.length);
  const fractionA = af.padEnd(length, "0");
  const fractionB = bf.padEnd(length, "0");
  return fractionA === fractionB ? 0 : fractionA < fractionB ? -1 : 1;
}

export function compareNovelTitles(a: string, b: string) {
  const tokenize = (title: string) =>
    title.normalize("NFKC").match(/\d+(?:\.\d+)?|[^\d]+/g) || [];
  const left = tokenize(a);
  const right = tokenize(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = left[index];
    const y = right[index];
    const order =
      /^\d/.test(x) && /^\d/.test(y)
        ? compareDecimal(x, y)
        : textOrder.compare(x, y);
    if (order) return order;
  }
  return left.length - right.length;
}

export function novelDownloadLabel(task?: NovelDownloadTask) {
  switch (task?.state) {
    case "completed":
      return "已下载";
    case "downloading":
      return "下载中";
    case "queued":
      return task.retryAt && task.error ? "等待重试" : "排队中";
    case "paused":
      return "已暂停";
    case "failed":
      return "下载失败";
    default:
      return undefined;
  }
}

export function canEnqueueNovelChapter(task?: NovelDownloadTask) {
  return !task || task.state === "failed";
}
