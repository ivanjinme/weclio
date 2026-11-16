"use client";

import { lazy, Suspense, type ComponentType } from "react";

// Next 构建用 next/dynamic；Vite 静态构建由别名指向本文件（React.lazy + Suspense）。
// 兼容本项目用到的两种形态：默认导出与「组件或 fallback 组件」的裸返回值。
type Loader<P> = () => Promise<ComponentType<P> | { default: ComponentType<P> }>;

export default function dynamic<P extends object>(
  loader: Loader<P>,
  /** ssr 仅为兼容 Next 侧调用方；静态构建本身没有服务端渲染。 */
  options?: { loading?: ComponentType; ssr?: boolean },
): ComponentType<P> {
  const Lazy = lazy(async () => {
    const loaded = await loader();
    const component = typeof loaded === "function" ? loaded : loaded.default;
    return { default: component };
  });
  const Loading = options?.loading;
  return function DynamicComponent(props: P) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}
