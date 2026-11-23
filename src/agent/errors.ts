/** Agent API 对外版本与错误类型（独立成模块，避免 api.ts ↔ api-review.ts 运行时循环依赖）。 */

/** 对外 Agent API 版本；兼容策略见 README「Agent 接入」。 */
export const AGENT_API_VERSION = 1;

/** 带机器可读错误码的 API 异常，HTTP 层据此返回 4xx。 */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
