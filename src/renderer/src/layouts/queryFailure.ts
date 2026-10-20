export type QueryErrorCode = "auth-required" | "network" | "unknown";
export class QueryFailure extends Error {
  constructor(
    public readonly code: QueryErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export function queryFailure(error: unknown): QueryFailure {
  if (error instanceof QueryFailure) return error;
  const value = error as any;
  const message = error instanceof Error ? error.message : String(error);
  const code = value?.code ?? value?.status ?? value?.response?.status;
  if (
    [401, "401", "UNAUTHORIZED", "AUTH_REQUIRED", "LOGIN_REQUIRED"].includes(
      code,
    ) ||
    /(?:请先|请|需要|尚未|未)登录|登录(?:过期|已失效)|login required|need login|not logged in|unauthenticated|unauthorized|session expired/i.test(
      message,
    )
  )
    return new QueryFailure("auth-required", message);
  return new QueryFailure("unknown", message);
}
