> 历史记录：门禁与私有控制管道结论仍然有效；文中 "bundled Node" 已改为系统 Node.js。更新交接顺序随后调整为"窗口关闭后加锁→确认 Service 退出→安装器"。

# P5：更新准入与安全交接

## 已实现

**准入查询走自有子进程的私有管道，不走 HTTP。**

- Service 侧 `lib/agent/service/maintenance-control.ts` 只接受 `{id, action}`，`id` 必须是正安全整数；`inspect`/`lock` 在同一个同步调用里检查并加锁，`unlock` 释放。状态只有 `ready`/`busy`/`unlocked`；未知 action 回 `error`，不回显任何请求内容。
- 准入判定复用既有 `Admission` 与 `runtime.hasBusyTasks()`：待处理任务、SDK 异步尾巴、会话启动、排队消息、压缩、bash、标题生成、插件/技能安装都会阻止加锁。
- 只有 `WECLIO_AGENT_PARENT_STDIN=1`（Home 主动管理）才开放 JSON 控制；独立部署即使打开 stdin 也拿不到管理面。原有 `shutdown` 行、托管 EOF 退出、独立 EOF 无害全部保留。
- 输入用 `readline` 逐行解析，跨 chunk 的半条 JSON 不会被误判；输出以 `WECLIO_AGENT_CONTROL` 前缀单独成行，不与 READY/日志混淆。
- Host 侧 `electron/service-control.mjs` 按 id 关联请求，按 action 校验允许的状态，超时/断开/协议错误都拒绝而不是返回假 `ready`；迟到的响应不能推进后续请求。
- `local-service.mjs` 在 READY 前就开始分流控制行，返回 `control` 句柄；`main.mjs` 的更新门禁 `getGate()` 直接接该句柄，开发态没有自有 Service 因此为 `undefined`，安装器按既有逻辑拒绝安装。
- 退出顺序：`before-quit` 先否决一次，等自有 Service 真正停止后再放行 `app.quit()`，避免安装器替换文件时仍有写入者；`will-quit` 保留幂等兜底。
- 失败恢复：安装失败且 Service 已停止时，`restoreWindow` 会先重新拉起自有 Service 再重建窗口，不留下「窗口在、后端没了」的状态。

## 真实进程验证

bundled Node + P4 产物 + 隔离 HOME/state/workspace，本机 fake model，无真实 provider 提示：

| 步骤 | 结果 |
| --- | --- |
| 空闲 `inspect` | `ready` |
| `lock` | `ready`，准入已锁 |
| 锁定后新建任务 | 拒绝，返回 `Service maintenance in progress`，没有创建会话 |
| 锁定后读取会话状态 | `200`，只读不受影响 |
| `unlock` | `unlocked` |
| 解锁后新建任务 | `200` |
| 再次 `inspect` | `ready` |
| 关停 | Service 退出，`owner.json` 已清除 |

证据：`build/regression/p5-gate-proof.json`、`p5-gate.log`。

## 仍未完成

- 安装失败恢复只在结构层面约束（先重启 Service 再重开窗口），没有再跑一次真实「关窗→安装器失败→恢复」的进程级回归；这属于 P6 的真实安装验证。
- 忙碌拒绝沿用既有 `command_failed` → HTTP 500；若要让 UI 显示更准确的状态，需要单独调整错误映射，本轮未改。
- 真实 NSIS 安装、A→B 升级、旧会话/凭据保留未验证；签名与发布未执行。
