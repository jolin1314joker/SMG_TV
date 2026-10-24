# SMG_TV
打开网页即可收看SMGTV，并解除试看倒计时与切页暂停等限制（修复 403 无限转圈 + 频道Token隔离 + Safari/Stay 兼容 + 回放与进度条拖动）

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

> 脚本 v0.21.0，详见 [`smg_fivestar.user.js`](./smg_fivestar.user.js)。更新时替换旧脚本内容并刷新页面，避免同时启用多份脚本。

---

### ② Console 粘贴

不想装插件？直接在浏览器 Console 里粘贴代码。

1. 打开 [看看新闻](https://live.kankanews.com/huikan?id=10)，等页面加载完成
2. 按 **F12** → **Console** → 粘贴代码 → 回车
3. 看到 `✅ 已就绪` 即可使用

---

🌟 核心特性

破解接口空流限制（Token 自举体系）：针对官方接口不再返回受限频道（如五星体育）播放地址的问题，通过逆向官方 API 签名并本地 RSA 解密合法供体切片，主动组装火山引擎 CDN 播放流。

全频道独立流隔离（彻底修复串台）：重构 Token 与 Stream 缓存机制，实现频道 ID（Channel ID）级严格隔离，杜绝五星体育自动串流至东方卫视。

播放地址自动续期：JWT 的 `exp` 与 CDN 签名的 `volcTime` 可能分别有效 12 小时和 10 分钟。脚本每 15 秒检查一次，以两者中较早的到期时间为准，提前约两分钟重新获取整套地址。网络或播放器报错后自动重试，失败时逐步延长重试间隔，最长两分钟；回放在 HLS 进度跟踪器中续期并保留当前位置。

完整节目回放与随意拖动寻道：解除时移切片锁死限制，支持节目单内往期节目的回放、动态计算 startTime，并支持进度条自由拖拽寻道（Seek）。

解除页面限制：解除试看倒计时、后台切页/失焦自动暂停、免除版权提示遮罩。

移动端与 Safari 深度优化：

自动纠正移动端跳转错误路由（/huikan/10 自动修复为 /huikan?id=10，避免 404 循环）。

支持 Safari (macOS / iOS / iPadOS)、Stay 扩展及 Userscripts App。

适配 iOS 原生全屏及刘海屏安全区（safe-area-inset / dvh）。

---

## 版本演进（从旧版到新版）

| 功能 | 旧版 | 新版 |
|------|------|------|
| 流地址获取 | 等待接口返回 | 逆向签名 + RSA解密 + Token自举生成 |
| 不同品类直播处理 | 未隔离 | Channel ID隔离 |
| Token续期 | 无 | 看门狗自动续期 |
| 回放寻道 | 无 | start/end 时间窗 + xgplayer |
| 解密 | 无 | Hook Webpack |

### v0.21.0：修复打开 `?id=10` 一直转圈

现象：页面加载完成但播放器一直显示 loading，控制台里所有 `index.m3u8` 请求都是 `403`（响应体为空）。

根因有两层，缺一不可：

1. **Token 版本门槛**：CDN 会校验 JWT 里的 `version` 声明，低于站点当前版本（实测 `< 2.45.0`）的 Token 一律 403。脚本原先硬编码 `2.42.23`，站点升到 `2.45.2` 后全部失效。现改为从页面 `runtime.vX.Y.Z.js` 自动识别站点版本。
2. **设备 ID 缓存**：接口按 `M-Uuid` 缓存 Token。旧版脚本用过的 UUID 会被永久绑定在旧版本 Token 上，即使脚本升级，接口仍返回 `2.42.23` 的 Token。因此新增：拿到 Token 后本地校验 `version` 声明，不合格则轮换一次设备 UUID 并重试供体队列（最多 3 次，不发额外探测请求）。

同时修复的关联问题：

- 回放地址改用 CDN 真正识别的 `start` / `end` 时间窗；旧的 `startTime=` 参数只会返回一个冻结的 3 段伪直播列表，表现为"能加载但进度不动"。
- 播放地址不再硬编码 `volc-stream.kksmg.com`，改用接口返回的 CDN 主机（魔都眼/新纪实走 `tencent-stream.kksmg.com`，路径形如 `/live/<stream>.m3u8`，原先的解析会直接失败）。
- `document.head` / `document.documentElement` 在 `document-start` 可能为 `null`，原先会抛异常导致整个脚本中断；现改为延迟注入。
- `MutationObserver.observe()` 在根节点为 `null` 时抛异常，现加空值保护。

---

## 兼容性

| 平台 | 直播 | 回放 | 备注 |
|------|------|------|------|
| **Windows** Edge / Chrome | ✅ | ✅ | 已测试 |
| **macOS** Safari（Stay） | ✅ | ✅ | 已测试，需开启"请求桌面网站" |
| **iOS** Safari（Stay） | ✅ | ✅ | 已测试，必须开启"请求桌面网站" |
| **Android** Kiwi Browser + Tampermonkey | ✅ | ✅ | 理论兼容 |

---

# 脚本来源
 基于https://github.com/Nolan180940/smg-f1-unlock/tree/master 提供的解决思路修复BUG二改完成
 
 ---

📄 免责声明

本脚本仅用于前端技术交流、学习探讨及个人无障碍观影研究，请勿用于非法用途。视频音视频源版权均归上海广播电视台（SMG）及看看新闻所有。

---

## 开发验证

使用 Node.js 20 或更高版本，无需安装依赖：

```sh
node --check smg_fivestar.user.js
node --test tests/renewal.test.cjs
```

测试通过模拟时钟、API 与播放器，覆盖连续播放 35 分钟内的多次 CDN 续期、错误重试、并发请求、频道切换、重复初始化、回放进度和暂停状态，并校验 Token 版本门槛、设备 ID 轮换与 start/end 时间窗构造。这些测试不等同于真实网站的长时间播放验证。

## License

[MIT](./LICENSE)
