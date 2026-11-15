// 通用执行准入：跨宿主复用（Next、独立 Service），不依赖 IPC/Desktop。
// 语义：reserve() 在首个 await 前占位；锁定后拒绝新任务；inspect/lock 只读当前状态。

export class Admission {
  private pending = 0;
  private locked = false;

  constructor(private readonly lockedMessage = "Service maintenance in progress; please try again later") {}

  /** 占位一次受管任务；已锁定时抛错。返回释放函数（幂等）。 */
  reserve(): () => void {
    if (this.locked) throw new Error(this.lockedMessage);
    this.pending++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending--;
    };
  }

  isBusy(runtimeBusy: () => boolean = () => false): boolean {
    return this.pending > 0 || runtimeBusy();
  }

  /** 仅在空闲时真正加锁，返回是否已锁定。 */
  tryLock(runtimeBusy: () => boolean = () => false): boolean {
    if (this.isBusy(runtimeBusy)) return false;
    this.locked = true;
    return true;
  }

  unlock(): void {
    this.locked = false;
  }

  isLocked(): boolean {
    return this.locked;
  }

  pendingCount(): number {
    return this.pending;
  }
}

declare global {
  var __weclioAdmission: Admission | undefined;
}

// Next 热更新会重新求值模块；默认实例挂在 globalThis 上以免出现第二个准入。
export function getDefaultAdmission(): Admission {
  return globalThis.__weclioAdmission ??= new Admission("Desktop update in progress; please try again after updating");
}
