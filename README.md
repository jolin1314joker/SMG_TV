# SMG_TV · 看东方直播解锁

解除 [看看新闻 / 看东方](https://live.kankanews.com/huikan?id=10) 网页端的观看限制：**直播直连、往期节目回看、自动续期、403 自愈**。

脚本不依赖站点打包模块号，也不依赖 `window.JSEncrypt`；地址来自官方 API，签名与解密都在脚本内独立实现。站点前端改版后通常无需改脚本，只有服务端轮换签名密钥或加密公钥时才需要更新常量。

---

## 安装

### Tampermonkey（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox / Safari 均可）。
2. 打开 Tampermonkey 面板 → **添加新脚本**。
3. 清空模板，粘贴 [`smg_fivestar.user.js`](./smg_fivestar.user.js) 全文 → **Ctrl+S** 保存。
4. 打开 <https://live.kankanews.com/huikan?id=10>，页面会自动生效。

更新时**用新内容整体覆盖旧脚本**，不要同时启用两份同名脚本。

### 控制台粘贴（临时使用）

打开频道页，等页面加载完，`F12` → Console → 粘贴脚本全文 → 回车。仅当前标签页有效，刷新即失效。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 直播解锁 | 8 个频道直播直连播放，不再卡在 loading 或 403 |
| 往期回看 | 点节目单里的历史节目即可回看，支持进度条拖动寻道 |
| 自动续期 | Token 到期前 2 分钟自动换新地址，长时间挂机不断流 |
| 故障自愈 | 播放报错 / 卡死自动换源，指数退避重试，最长间隔 2 分钟 |
| 解除页面限制 | 去掉试看倒计时、版权遮罩、切后台自动暂停 |
| 换台跟随 | 页面内切频道后重新接管播放器，不串台、不漏旧监听 |

支持的频道：东方卫视、新闻综合、魔都眼、第一财经、新纪实、五星体育、都市频道、哈哈炫动。

> 魔都眼、新纪实没有排期数据，只有直播；其余 6 个频道可以回看，回看窗口约 **6 天**。

---

## 工作原理

### 1. 地址从哪来

站点自己播放回放时读的是 `programDetail.channel_info.shift_address`，而公开的 `pc` 接口对受限频道**不再下发地址**（长久以来基于"抓一条历史节目地址当供体"的思路已整体失效）。脚本改走另外两条通道：

| 用途 | 接口 | 取什么 |
| --- | --- | --- |
| 节目单 | `/content/pc/tv/programs` | `result.programs`（只能用 pc 前缀） |
| 直播地址 | `/content/app/tv/channel/detail` | `live_address`（app 前缀，8 个频道都有） |
| 回看地址 | `/content/app/tv/program/detail` | `channel_info.shift_address` |

地址是 RSA 密文，脚本用内置公钥分块解密（每 128 字节一块，PKCS#1 v1.5），得到真正的 m3u8 地址。

### 2. 三种 CDN，一套模型

解密后的地址有三种形态，脚本统一解析成 `{url, family, token, stream, origin, exp, version}`：

- **火山云** `volc-stream.kksmg.com/live/<stream>/index.m3u8?token=…&volcSecret=…&volcTime=…`
- **腾讯云** `tencent-stream.kksmg.com/live/<stream>.m3u8?token=…&txSecret=…&txTime=<hex>`
- **自建** `ws-channels.kksmg.com/…`（都市频道，返回带 `wsSession` 的二级清单）

回看地址则可能是 `…/timeshift.m3u8?starttime=…&endtime=…`（腾讯）或 `?wsStart=…&wsEnd=…`（自建）。`smgRetimeUrl()` 会按地址形态改写对应的时间参数（时间戳是 **上海本地时间** 格式 `YYYYMMDDHHMMSS`），火山云地址则改写 `start` / `end` 秒级时间窗。

### 3. 服务的三个硬约束（脚本因此必须做什么）

- **UA 绑定**：JWT 里有 `ua_hash`，取地址时的 UA 必须与播放时一致，否则 403。脚本用同一个 `fetch` 上下文取地址并播放，不做任何 UA 伪装。
- **版本门槛**：token 的 `version` 声明必须 ≥ `2.45.0`。脚本从 `window.__NUXT__` / `runtime.vX.Y.Z.js` 读出当前站点版本，探测不到时退回下限；版本号也可以手动覆盖：`localStorage.smg_version = '2.45.2'`。
- **设备 ID 会毒化 token**：接口按 `M-Uuid` 缓存首次下发的版本。若某个 UUID 曾用旧版本取过地址，之后即使声明新版本也会拿回旧 token 并 403。脚本在收到低于下限的 token 时**轮换 UUID 并重取**（最多 3 次），同时清空缓存。

### 4. 回看为什么能拖进度条

回看地址是一段"以 `start` 为起点的 VOD 清单"，媒体自身时间从 0 开始，直接播进度条就只有节目开头那几个小时。脚本为播放器建立虚拟时间轴：

- 定时把真实播放时长累加到 `player.offsetCurrentTime`（xgplayer 的时间/进度插件都读这个属性）；
- 把 `video.duration` 重定义为节目总时长；
- 重写 `player.seek(t)`：把虚拟位置换算成绝对时间，用新的 `start`/`end` 重新开一个时间窗，从该点开始拉流（`switchURL` 串行化 + 150 ms 防抖，避免连续拖动打爆 CDN）。

### 5. 续期与自愈

看门狗每 15 秒检查一次：

- 用 JWT `exp` 与 CDN 签名时间取**较早**者作为到期时间，提前 2 分钟换新；
- 60 秒没有进度判定为卡死，`video.error` 直接触发，两种情况都走换源；
- 换源失败按 15s → 30s → 60s → 120s 指数退避，成功即重置；
- 每次换源前校验 `vue.player === player`、频道 ID 与代数，切台/切节目后旧监听自动作废，不会串台。

### 6. 解除页面限制

站点用 `is_shield` / `is_review` / `can_review` / `isOutDate` 控制能不能看，其中 `isCopyright` 是 computed（由 `programObj` 推导），所以脚本改的是数据而非 DOM：

- 直播：`programObj.is_shield = 0`；
- 回看：`programObj.is_review = 1`；
- 节目单：包装站点的 `handleProgramList`，对**入参**逐项放开，历史节目因此能正常点开（站点原生的 `changeProgram` 门禁就在这一步重新写回字段，只改返回值无效）；
- 另清掉 `copyright_image`，停掉试看 `liveTimer`，把 `pageVisibilityChange` 置空（保留事件、函数体为空）。
- CSS 兜底隐藏 `.image-mask` / `.video-tip` / `.copyright-mask`。

---

## 排查

控制台执行：

```js
SMGTV.status()
// { version, apiVersion, uuid, channel, liveToken, replaySources, patched }
```

- `apiVersion` 低于站点当前版本 → 执行 `localStorage.smg_version = '2.45.2'` 后刷新（版本探测失败时的兜底）。
- 想看详细日志 → 用 `?smg_debug=1` 打开页面，或 `localStorage.smg_debug = '1'`。
- 画面黑屏/不刷新 → 先 `SMGTV.refresh()`；仍旧异常就刷新整页。
- 一直 403 → 多半是 UUID 被毒化，执行 `localStorage.removeItem('uuid')` 后刷新，脚本会重新生成并取新 token。

常见现象对照：

| 现象 | 原因 |
| --- | --- |
| 播放器一直转圈，`index.m3u8` 全 403 | token 版本低于 `2.45.0`，或 UUID 被旧版本毒化 |
| 能出画面但进度不动 | 火山云地址用了 `startTime=` 旧参数，而非 `start` / `end` |
| 回看进度条只有很短一段 | 虚拟时间轴未接管（`video.duration` 被站点重写），执行 `SMGTV.refresh()` |
| 换台后没声音/不播放 | 旧看门狗未清理，`SMGTV.refresh()` 或刷新页面 |

---

## 兼容性

| 平台 | 直播 | 回看 | 说明 |
| --- | --- | --- | --- |
| Windows Edge / Chrome | ✅ | ✅ | 主要验证环境 |
| macOS Safari（Stay / Userscripts） | ✅ | ✅ | 需开启"请求桌面网站" |
| iOS Safari（Stay / Userscripts） | ✅ | ✅ | 需开启"请求桌面网站" |
| Android Kiwi + Tampermonkey | ✅ | ✅ | 同为 Chromium 内核 |
| `m.kankanews.com`（移动版页面） | — | — | 脚本不注入：移动端组件结构与调用签名不同，且本身不限制观看 |

脚本 `@run-at document-start`，不需要 `@grant`，不发任何第三方请求，只访问 `kapi.kankanews.com` 与站点自身的 CDN 域名。

---

## 目录

```
SMG_TV/
├─ smg_fivestar.user.js     # 用户脚本（单文件，无依赖）
├─ tests/renewal.test.cjs   # Node 测试：续期 / 重试 / 并发 / 时间窗
├─ README.md
└─ LICENSE                  # MIT
```

## 开发与测试

需要 Node.js 20+，无需安装依赖：

```sh
node --check smg_fivestar.user.js
node --test tests/renewal.test.cjs
```

测试用 `vm` 加载脚本中除启动段以外的全部代码，注入假时钟、假 API 与假播放器，覆盖 14 个场景：最早到期时间、35 分钟内多次续期、并发请求合并、API 错误与超时、媒体/HLS 错误重试、退避序列、换源不可重叠、切台清理、重复初始化、回看续期保留绝对位置、暂停态保持、旧版本 token 触发 UUID 轮换、地址构造保留 CDN 主机与时间窗、版本号按数值比较。这些测试不替代真实站点的长时间播放验证。

脚本内的调试开关：`SMG_DEBUG`（`localStorage.smg_debug === '1'` 或 URL 带 `smg_debug=1`）；`SMGTV.status()` / `SMGTV.refresh()` 是内置诊断入口。

---

## 说明

- 本脚本仅用于前端技术研究与个人观看便利，视频内容版权归上海广播电视台（SMG）及看看新闻所有。
- 脚本不破解 DRM，不绕过登录与付费，只调整网页端自行下发的播放参数。
- 接口、签名密钥与公钥均属服务端，若服务端轮换，需同步更新脚本顶部 `SMG_API_SECRET` / `SMG_PUBKEY`。

## License

[MIT](./LICENSE) © 2026 roies
