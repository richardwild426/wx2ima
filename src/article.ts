import { AppError } from "./types";
export function normalizeArticleUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError("请输入有效的微信公众号文章链接。");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "mp.weixin.qq.com" ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/s(?:\/[^/]+)?$/.test(url.pathname)
  )
    throw new AppError("仅支持 HTTPS 格式的微信公众号文章链接。");
  url.hash = "";
  if (url.pathname === "/s") {
    const stable = new URLSearchParams();
    for (const field of ["__biz", "mid", "idx", "sn"]) {
      const value = url.searchParams.get(field);
      if (!value) throw new AppError("文章链接不完整，请从微信复制完整链接。");
      stable.set(field, value);
    }
    url.search = stable.toString();
  } else {
    url.search = "";
  }
  return url.href;
}
export function articleIdentity(url: string) {
  const u = new URL(url),
    biz = u.searchParams.get("__biz"),
    mid = u.searchParams.get("mid"),
    idx = u.searchParams.get("idx");
  return biz && mid && idx ? `wx:${biz}:${mid}:${idx}` : null;
}
export function fileName(
  title: string,
  date = new Date().toISOString().slice(0, 10),
  copy = 1,
) {
  const clean =
    [...title]
      .filter((char) => (char.codePointAt(0) ?? 0) >= 32)
      .join("")
      .replace(/[<>:"/\\|?*]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "微信公众号文章";
  let clipped = "";
  for (const char of clean) {
    if (new TextEncoder().encode(clipped + char).length > 160) break;
    clipped += char;
  }
  return `${date}_${clipped}${copy > 1 ? `（${copy}）` : ""}.pdf`;
}
export function assertPublicDownload(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === "changfengbox.top" ||
      url.hostname.endsWith(".changfengbox.top")
    )
  )
    throw new AppError("下载服务返回的文件地址不受支持。", 502);
  return url;
}
