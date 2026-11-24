/**
 * 电脑操作模式 + 三窗外观（evolution-computer-use）设置项。
 *
 * 三块：
 *  1. 导出 Config（schemastery）：插件自身的默认配置，首次运行时写成模式文件。
 *  2. 在 DSH 的 webServer 上注册一组只走本机的小接口（实现都在 lib/routes.js）：
 *       桌面模式：GET /read、POST /set
 *       三窗外观：GET/POST /appearance
 *       字体：    GET/POST/DELETE /fonts
 *       按应用：  GET /apps、GET/POST /policies
 *     路径都在 /api/dsh-evolution-desktop-mode 下，数据文件在 ~/.evolution-computer-use/
 *     （契约见 docs/design/appearance.md）。
 *  3. 挂上 lib/activity.mjs：订阅 DSH 的思考流、回合事件和工具执行，把「正在想什么 /
 *     正在做什么 / 第几步」原子写进 activity.json，
 *     由 evolution-computer-use 的浮窗助手读出来画在桌面上。
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installActivity } from './activity.mjs';
import { createSettingsApi } from './routes.js';

export const name = 'evolution-desktop-mode';

const PREFIX = '/api/dsh-evolution-desktop-mode';

// 配置模型从 DSH profile 里拿（跟 DSH 自己用同一份 schemastery），拿不到会直接抛，
// 和旧实现一致：这是插件加载期就需要的依赖。
const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const require = createRequire(join(profile, 'package.json'));
const Schema = require('@deepseek-ai/schemastery');

export const Config = Schema.object({
  desktopMode: Schema.union([Schema.const('off'), Schema.const('background'), Schema.const('foreground')])
    .default('background')
    .description('电脑操作模式：off=关闭；background=后台（只向目标窗口投递输入，不动用户的鼠标键盘）；foreground=前台（真实鼠标键盘，切过去会弹管理员授权）'),
  overlayEnabled: Schema.boolean().default(true).description('右上角思考/步骤浮窗：显示 Agent 正在想什么、正在做哪一步'),
  overlayPosition: Schema.union([Schema.const('top-right'), Schema.const('top-left'), Schema.const('bottom-right'), Schema.const('bottom-left')])
    .default('top-right').description('浮窗位置'),
  overlayWidth: Schema.number().default(360).description('浮窗宽度（240-1600 像素）'),
  overlayHeight: Schema.number().default(240).description('浮窗高度（160-1600 像素）'),
  overlayOpacity: Schema.number().default(60).description('浮窗不透明度（20-100，%）'),
  overlayLocked: Schema.boolean().default(true).description('锁定浮窗（鼠标可以穿透，不挡住操作）'),
});

// 浮窗文字跟着 DSH 界面语言走：用户在 DSH 里选的语言存在 locale 这条设置里
// （describe() 里 ns === 'locale' 的 value.preference），没选就用系统语言。
let localeCache = '';
let localeReadAt = 0;
function readDshLocale(ctx) {
  if (localeCache && Date.now() - localeReadAt < 5000) return localeCache;
  localeReadAt = Date.now();
  let next = '';
  try {
    const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined;
    const entries = settings && typeof settings.describe === 'function' ? settings.describe() : undefined;
    const entry = Array.isArray(entries) ? entries.find((item) => String(item?.ns) === 'locale') : undefined;
    const preference = entry?.value?.preference;
    if (typeof preference === 'string' && preference.trim()) next = preference.trim();
  } catch {
    /* 拿不到就算了，用系统语言 */
  }
  if (!next) {
    try {
      next = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
    } catch {
      next = 'en';
    }
  }
  localeCache = next;
  return next;
}

function drop(disposer) {
  try {
    if (typeof disposer === 'function') disposer();
    else if (typeof disposer?.dispose === 'function') disposer.dispose();
  } catch {
    /* 忽略 */
  }
}

export function apply(ctx, config) {
  // activity.mjs 要在接口建好之后才能挂；浮窗刷新用闭包兜住，
  // 下面再用 setNotify 换成正式的 publish（写完后立刻刷新桌面浮窗）。
  let activity = null;
  const api = createSettingsApi({
    config: config ?? {},
    onOverlayChanged: () => {
      try {
        if (activity && typeof activity.publish === 'function') activity.publish();
      } catch (error) {
        console.error('[evolution-desktop-mode] 刷新浮窗失败：', error);
      }
    },
  });

  // 首次运行把默认值落盘；已有文件绝不覆盖，别的窗口或旧版本可能正依赖它。
  try {
    api.init();
  } catch (error) {
    console.error('[evolution-desktop-mode] 初始化设置文件失败：', error);
  }

  try {
    activity = installActivity(ctx, api.activityFile, {
      getSettings: () => api.currentOverlay(),
      getLocale: () => readDshLocale(ctx),
    });
  } catch (error) {
    console.error('[evolution-desktop-mode] 浮窗活动采集启动失败：', error);
  }
  if (activity && typeof activity.publish === 'function') {
    api.setNotify(() => {
      try {
        activity.publish();
      } catch (error) {
        console.error('[evolution-desktop-mode] 刷新浮窗失败：', error);
      }
    });
  }

  const register = (sctx) => {
    const server = sctx?.get ? sctx.get('webServer') : undefined;
    if (!server || typeof server.register !== 'function') {
      console.error('[evolution-desktop-mode] webServer 不可用，设置接口没有注册');
      return;
    }
    let disposers = [];
    try {
      disposers = api.routes.map((route) =>
        server.register({ kind: 'exact', path: PREFIX + route.path, handler: route.handler }),
      );
    } catch (error) {
      console.error('[evolution-desktop-mode] 注册设置接口失败：', error);
    }
    if (typeof ctx?.on === 'function') {
      ctx.on('dispose', () => disposers.forEach(drop));
    }
  };

  if (typeof ctx?.inject === 'function') ctx.inject(['webServer'], register);
  else register(ctx);
}
