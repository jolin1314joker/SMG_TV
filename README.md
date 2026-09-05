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

> 脚本 v0.20，详见 [`smg_fivestar.user.js`](./smg_fivestar.user.js)

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

直播保活看门狗（防 403 中断）：针对官方将鉴权 Token 缩短至约 6 分钟寿命的机制，内置 30 秒周期巡检看门狗，在失效前提前静默无缝切流，支持长时间稳定播放。

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
| 回放寻道 | 无 | starttime + xgplayer |
| 解密 | 无 | Hook Webpack |

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

## License

[MIT](./LICENSE)
