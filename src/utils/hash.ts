/** 内容哈希：用于 confirm 档「人工审批的预览」与「实际落盘内容」的绑定校验。 */
import { sha256Digest } from "./node";

/** 把文本转成稳定的 SHA-256 十六进制串；同一内容在任何时候都得到同一值。 */
export function contentHash(text: string): string {
  const bytes = sha256Digest(text);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
