"use client";

import { useEffect, useRef, type ImgHTMLAttributes } from "react";
import { useResourceUrl } from "@/hooks/useResourceUrl";

type Props = ImgHTMLAttributes<HTMLImageElement> & { filePath: string; sessionId?: string | null };

/** Markdown 中的本地图片与文件预览共用资源通道，不改外部图片的 URL。 */
export function ResourceImage({ filePath, sessionId, alt = "", onError, ...props }: Props) {
  const resource = useResourceUrl({ filePath, kind: "read", sessionId });
  const retried = useRef(false);
  useEffect(() => { retried.current = false; }, [filePath, sessionId]);
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} alt={alt} src={resource.url} referrerPolicy="no-referrer"
    title={resource.error ?? props.title}
    onError={(event) => {
      if (!retried.current) { retried.current = true; resource.refresh(); return; }
      onError?.(event);
    }} />;
}
