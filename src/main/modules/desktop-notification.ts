import fs from 'fs';
import path from 'path';
import { app, nativeImage, Notification } from 'electron';

/**
 * 桌面通知的两个 Windows 细节，缺一个图标就没了：
 *
 * 1. **AppUserModelID**：Windows 用 AUMID 关联"这个通知属于哪个应用"，再据此取应用图标。
 *    未设置时 Electron 用默认的 `electron.app.Electron`，那个 ID 没有对应的快捷方式，
 *    托盘通知就是一个空图标。`src/main/index.ts` 启动时已按 electron-builder 的 appId 设置。
 * 2. **`icon` 选项**：显式给出图片会走 toast 的 `appLogoOverride`，开发模式（没有安装快捷方式）
 *    也只有这条能显示图标。
 *
 * 打包后 `build/` 不会进 asar，所以图标按"应用目录 → 资源目录"两处找，找不到就不传 icon，
 * 由 AUMID 关联的 exe 图标兜底。
 */

export type DesktopNotificationInput = {
  readonly title: string;
  readonly body?: string;
  /** 静音提示（用户脚本场景）。 */
  readonly silent?: boolean;
  /** 点击提示时的回调；内部会先挂好再 show。 */
  readonly onClick?: () => void;
};

let resolvedIcon: Electron.NativeImage | null | undefined;

function desktopNotificationIcon(): Electron.NativeImage | undefined {
  if (resolvedIcon !== undefined) return resolvedIcon ?? undefined;
  const candidates = [
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'build', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'icon.png'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (!fs.existsSync(candidate)) continue;
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        resolvedIcon = image;
        return image;
      }
    } catch { /* 继续试下一个候选路径 */ }
  }
  resolvedIcon = null;
  return undefined;
}

/** 统一入口：所有桌面通知都从这里发出，保证图标与点击行为一致。 */
export function createDesktopNotification(input: DesktopNotificationInput): Notification | null {
  if (!Notification.isSupported()) return null;
  const icon = desktopNotificationIcon();
  const notification = new Notification({
    title: input.title,
    body: input.body ?? '',
    ...(input.silent ? { silent: true } : {}),
    ...(icon ? { icon } : {}),
  });
  if (input.onClick) notification.on('click', input.onClick);
  notification.show();
  return notification;
}
