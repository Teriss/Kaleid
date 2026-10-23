export type OnlineComicErrorKind =
  | "authentication"
  | "challenge"
  | "access-denied"
  | "site-html"
  | "upstream-error"
  | "rate-limited"
  | "network"
  | "source";

export function onlineComicErrorText(error: unknown) {
  const raw =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return raw
    .replace(/Error invoking remote method 'comic:call':\s*/g, "")
    .replace(/^(?:Error:\s*)+/, "")
    .trim();
}

export function classifyOnlineComicError(error: unknown): OnlineComicErrorKind {
  const message = onlineComicErrorText(error);
  if (
    /challenge_required|cf-mitigated:\s*challenge|cloudflare|captcha|访问验证/i.test(
      message,
    )
  )
    return "challenge";
  if (/unexpected token:\s*['"]</i.test(message)) return "site-html";
  if (/\b401\b|unauthorized|未授权|需要登录|请先登录/i.test(message))
    return "authentication";
  if (/\b403\b|forbidden|拒绝访问/i.test(message)) return "access-denied";
  if (/\b5\d\d\b/.test(message)) return "upstream-error";
  if (/\b(?:210|429)\b|rate.?limit|请求受限|限流/i.test(message))
    return "rate-limited";
  if (
    /ERR_NAME_NOT_RESOLVED|ETIMEDOUT|TimeoutError|fetch failed|ECONN|network|网络/i.test(
      message,
    )
  )
    return "network";
  return "source";
}

export function formatOnlineComicError(error: unknown) {
  // Keep the source/runtime's actual error visible. The UI used to replace
  // HTTP statuses, network errors, and source exceptions with generic advice,
  // which hid the detail needed to diagnose a broken source.
  return onlineComicErrorText(error) || "未知错误";
}
