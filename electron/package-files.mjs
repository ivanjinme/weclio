import { cp, lstat } from "node:fs/promises";
import { basename } from "node:path";

// 仅排除明确的源码映射后缀，保留其他 .map 资源。
export function shouldCopyDependencyFile(sourcePath) {
  return !/\.(?:js|cjs|mjs|jsx|ts|cts|mts|tsx|css)\.map$/.test(sourcePath);
}

/** 本地环境变量文件属于开发机秘密，不能随依赖闭包进入安装包或 npm 产物。 */
export function isForbiddenDependencyFile(name) {
  return /^\.env(?:\.|$)/i.test(name);
}

export async function copyProductionDependency(source, destination) {
  await cp(source, destination, {
    recursive: true,
    // 拒绝链接而不是展开：链接可能指向仓库外的凭证或用户目录。
    filter: async (sourcePath) => {
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) throw new Error(`依赖闭包含符号链接，拒绝打包: ${sourcePath}`);
      if (isForbiddenDependencyFile(basename(sourcePath))) throw new Error(`依赖闭包含环境变量文件，拒绝打包: ${sourcePath}`);
      return shouldCopyDependencyFile(sourcePath) || info.isDirectory();
    },
  });
}
