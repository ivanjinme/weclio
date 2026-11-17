import { APP_HOST, APP_SCHEME } from "./protocol.mjs";

// 可信来源只有静态 UI 本身。Node 对自定义 scheme 的 origin 为 null，必须逐项验证入口。
export function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST &&
      !url.username && !url.password && !url.port &&
      ["", "/", "/index.html"].includes(url.pathname);
  } catch {
    return false;
  }
}

// 仅允许可信应用写入剪贴板；读取剪贴板及其他权限继续拒绝。
export function isPermissionAllowed(permission, requestingUrl) {
  return permission === "clipboard-sanitized-write" && isAppUrl(requestingUrl);
}

export function isExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !isAppUrl(value);
  } catch {
    return false;
  }
}
