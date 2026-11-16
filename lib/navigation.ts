// 导航接口的唯一入口：Next 构建用 next/navigation，Vite 静态构建由 vite.config 别名指向
// lib/navigation.static.ts（history API）。组件只 import 本模块。
export { useRouter, useSearchParams } from "next/navigation";
