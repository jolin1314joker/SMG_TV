# SMG_TV
打开网页即可收看SMGTV，并解除试看倒计时与切页暂停等限制（修复五星体育串台至东方卫视 + 频道Token隔离 + Safari/Stay 兼容 + 回放与进度条拖动）

## 使用方法

### ① Tampermonkey 脚本（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器插件
2. 点击图标 → **创建新脚本** → 粘贴 [`smg_fivestar.user.js`](./smg_fivestar.user.js) 全部内容 → **Ctrl+S** 保存
3. 打开 [看看新闻](https://live.kankanews.com/huikan?id=10) 即可自动生效

**功能：**
- ✅ 绕过版权限制（`is_shield` / `is_review` / `copyright_image`）
- ✅ 直播 + 回放（点击左侧历史节目即可回看，支持进度条拖动）
- ✅ 拦截试看倒计时、标签页切换暂停
- ✅ SPA 路由切换自动重新打补丁
- ✅ Safari / Stay 兼容

> 脚本 v0.20，详见 [`smg_fivestar.user.js`](./smg_fivestar.user.js)

---
基于https://github.com/Nolan180940/smg-f1-unlock/tree/master提供的解决思路修复BUG二改完成

### ② Console 粘贴

不想装插件？直接在浏览器 Console 里粘贴代码。

1. 打开 [看看新闻](https://live.kankanews.com/huikan?id=10)，等页面加载完成
2. 按 **F12** → **Console** → 粘贴代码 → 回车
3. 看到 `✅ 已就绪` 即可使用

**两个模式：**

| 模式 | 功能 | 代码 |
|------|------|------|
| **A. 直播 + 回放**（推荐） | 绕过版权 + 点击历史节目回放 + 进度条拖动 | [`CONSOLE.md` 模式 A](./CONSOLE.md#模式-a直播--回放v017推荐) |
| **B. 仅直播** | 仅绕过版权限制看直播 | [`CONSOLE.md` 模式 B](./CONSOLE.md#模式-b仅直播精简版不含回放) |

> ⚠️ 刷新页面后需要重新粘贴。详见 [`CONSOLE.md`](./CONSOLE.md)

---

### ③ PowerShell 自动化（未更新，仅直播）

双击 [`run.bat`](./run.bat)，脚本会自动打开 Edge 并通过 CDP 注入 JS 绕过版权限制。

> ⚠️ **暂不支持回放**，仅直播。回放请使用上方两种方式。

---

🌟 核心特性

破解接口空流限制（Token 自举体系）：针对官方接口不再返回受限频道（如五星体育）播放地址的问题，通过逆向官方 API 签名并本地 RSA 解密合法供体切片，主动组装火山引擎 CDN 播放流。

全频道独立流隔离（彻底修复串台）：重构 Token 与 Stream 缓存机制，实现频道 ID（Channel ID）级严格隔离，杜绝五星体育自动串流至东方卫视。

直播保活看门狗（防 403 中断）：针对官方将鉴权 Token 缩短至约 6 分钟寿命的机制，内置 30 秒周期巡检看门狗，在失效前提前静默无缝切流，支持长时间稳定播放。

完整节目回放与随意拖动寻道：解除时移切片锁死限制，支持节目单内往期节目的回放、动态计算 startTime，并支持进度条自由拖拽寻道（Seek）。

解除页面限制：解除试看倒计时、后台切页/失焦自动暂停、免除版权提示遮罩。

移动端与 Safari 深度优化：

自动纠正移动端跳转错误路由（/huikan/10 自动修复为 /huikan?id=10，避免 404 循环）。

支持 Safari (macOS / iOS / iPadOS)、Stay 扩展及 Userscripts App。

适配 iOS 原生全屏及刘海屏安全区（safe-area-inset / dvh）。

---

## 常见问题

| 问题 | 现象 | 解决方案 |
|------|------|---------|
| **iOS 跳转手机版** | 访问后跳到 `m.kankanews.com`，页面 404 或者依旧有版权限制 | Safari 地址栏 → 点 `aA` → **"请求桌面网站"**（这是最需要注意的，因为手机版和桌面版网页架构不一样，这是你最有可能遇到的问题）。或 iPhone 设置 → Safari → 请求桌面网站 → 加入 `kankanews.com` |
| **手机端无限跳转** | 页面在 `m.` 和 `live.` 之间疯狂闪烁 | v0.15 已用 `replaceState` 修复。配合"请求桌面网站"效果最佳 |
| **回放加载慢/无画面** | 点击回放后转圈但无画面 | 回放支持 一周 内的节目 |
| **Tampermonkey 不生效** | 脚本已安装但页面无变化 | 检查：① 脚本开关是否打开 ② 是否被当前站点禁用 ③ Console 有无 `[SMGTV]` 日志 |
| **`initPlayer()` 报错** | 控制台 "Cannot read property of undefined" | 等页面完全加载后再运行。Console 方式看 `[SMGTV] Vue found` 日志；Tampermonkey 方式会自动重试 |
| **版权遮罩图仍显示** | `.image-mask` 未被隐藏 | 网站可能改了 class 名。DevTools → Elements → 搜索 `copyright`，找到新 class 加入 CSS |
| **Stay 注入无效** | 无 `[SMGTV]` 日志 | Stay 脚本设置 → 注入方式 → 改为 **Page**（非 Auto / Content） |
| **回放 30 秒冻结** | 播放 30 秒后卡住 | v0.17 已修复。动态 `startTime` + `switchURL` 切源 |
| **E.a 解密空 URL** | `live_address` 解密后为空 | v0.13+ 回放已绕过此问题，直接从直播流提取 token 构建偏移 URL |

---

## 兼容性

| 平台 | 直播 | 回放 | 备注 |
|------|------|------|------|
| **Windows** Edge / Chrome | ✅ | ✅ | 已测试 |
| **macOS** Safari（Stay） | ✅ | ✅ | 已测试，需开启"请求桌面网站" |
| **iOS** Safari（Stay） | ✅ | ✅ | 已测试，必须开启"请求桌面网站" |
| **Android** Kiwi Browser + Tampermonkey | ✅ | ✅ | 理论兼容 |
| **Firefox** | ⚠️ | ⚠️ | 未测试 |
| **PowerShell (run.bat)** | ✅ | ❌ | 仅直播，未更新回放功能 |

---

## License

[MIT](./LICENSE)
