import { useEffect, useMemo, useState } from "react";

// 导航与懒加载的宿主无关实现。
// Next 构建默认用 lib/navigation.ts；Vite 静态构建通过别名指向本文件（history API）。

function currentLocation(): { pathname: string; search: string } {
  return { pathname: window.location.pathname, search: window.location.search };
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export interface AppRouter {
  push: (href: string) => void;
  replace: (href: string) => void;
}

export function useRouter(): AppRouter {
  return useMemo(() => ({
    push(href: string) {
      if (href === `${currentLocation().pathname}${currentLocation().search}`) return;
      window.history.pushState(null, "", href);
      notify();
    },
    replace(href: string) {
      window.history.replaceState(null, "", href);
      notify();
    },
  }), []);
}

export function useSearchParams(): URLSearchParams {
  const [params, setParams] = useState(() => new URLSearchParams(currentLocation().search));

  useEffect(() => {
    const update = () => setParams(new URLSearchParams(currentLocation().search));
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  return params;
}
