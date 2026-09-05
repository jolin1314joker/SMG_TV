// ==UserScript==
// @name             收看SMGTV电视节目 (移动/桌面兼容修复版)
// @namespace        https://github.com/jolin1314joker/SMG_TV
// @version          0.21
// @description      打开网页即可收看SMGTV，支持五星体育回看/直播、解除试看倒计时与全屏限制（移动端/电脑端全适配）
// @author           GitHub:jolin1314joker
// @match            https://live.kankanews.com/*
// @match            https://m.kankanews.com/*
// @match            http://live.kankanews.com/*
// @match            http://m.kankanews.com/*
// @icon             https://live.kankanews.com/favicon.ico
// @require          https://cdn.jsdelivr.net/npm/jsencrypt@3.3.2/bin/jsencrypt.min.js
// @grant            none
// @run-at           document-body
// @compatible       safari
// @compatible       stay
// @compatible       edge
// @compatible       chrome
// ==/UserScript==

(function() {
    "use strict";

    console.log("[SMGTV] ========== v0.21 (Mobile & Desktop Unified) ==========");
    console.log("[SMGTV] Current URL:", location.href);
    console.log("[SMGTV] UserAgent:", navigator.userAgent);

    // ===== 0. Mobile URL parsing (Disabled history rewrite to prevent 404) =====
    // 移除了会导致移动端 SPA 404 的 history.replaceState 重写

    // ===== 1. CSS: 移除遮罩与提示层，优化移动端全屏表现 =====
    var style = document.createElement("style");
    style.textContent = [
        ".image-mask { display: none !important; }",
        ".video-tip { display: none !important; }",
        ".loading-mask { pointer-events: none !important; }",
        "video { object-fit: contain !important; background: #000 !important; }"
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);

    // ===== 2. 绕过 Webpack 内部的 E.a 解密限制 =====
    var _module560Patched = false;
    function patchModule560() {
        if (_module560Patched) return;
        try {
            if (!window.webpackJsonp) return;
            window.webpackJsonp.push([[], {
                '__smg_m560_probe': function(module, exports, __webpack_require__) {
                    try {
                        var mod560 = __webpack_require__(560);
                        if (mod560 && typeof mod560.a === 'function') {
                            var origEa = mod560.a;
                            mod560.a = function(t) {
                                if (typeof t === 'string' && t.indexOf('http') === 0) {
                                    return t;
                                }
                                return origEa.apply(this, arguments);
                            };
                            _module560Patched = true;
                            console.log("[SMGTV] Module 560 (E.a) patched successfully");
                        }
                    } catch(e) {
                        console.warn("[SMGTV] Module 560 patch error:", e.message);
                    }
                }
            }, ['__smg_m560_probe']]);
        } catch(e) {
            console.warn("[SMGTV] webpack probe failed:", e.message);
        }
    }
    patchModule560();

    // ===== 3. 拦截接口请求并触发响应修复 =====
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        var urlStr = String(url);
        if (urlStr.indexOf("/content/pc/tv/") !== -1 || urlStr.indexOf("/content/app/tv/") !== -1) {
            var xhr = this;
            xhr.addEventListener("readystatechange", function() {
                if (xhr.readyState === 4 && xhr.status === 200) {
                    setTimeout(tryPatch, 30);
                }
            });
        }
        return origOpen.apply(this, arguments);
    };

    var origFetch = window.fetch;
    if (typeof origFetch === "function") {
        window.fetch = function(input, init) {
            var urlStr = typeof input === "string" ? input : (input && input.url) || "";
            if (urlStr.indexOf("/content/pc/tv/") !== -1 || urlStr.indexOf("/content/app/tv/") !== -1) {
                return origFetch.apply(this, arguments).then(function(resp) {
                    setTimeout(tryPatch, 50);
                    return resp;
                });
            }
            return origFetch.apply(this, arguments);
        };
    }

    // ===== 4. Vue 组件与频道 ID 解析 =====
    function findComponent(root, name) {
        if (!root) return null;
        if (root.$options && (root.$options.name === name || root.$options._componentTag === name)) return root;
        for (var i = 0; root.$children && i < root.$children.length; i++) {
            var found = findComponent(root.$children[i], name);
            if (found) return found;
        }
        return null;
    }

    function findVue() {
        var el = document.querySelector(".huikan");
        if (el && el.__vue__ && typeof el.__vue__.initPlayer === "function") return el.__vue__;

        var root = document.querySelector("#__nuxt") || document.querySelector("#app");
        if (root && root.__vue__) {
            var comp = findComponent(root.__vue__, "HuikanIndex") || findComponent(root.__vue__, "huikan");
            if (comp && typeof comp.initPlayer === "function") return comp;
        }

        var all = document.querySelectorAll("[class*=huikan], [id*=huikan], .live-player, .video-wrap, .player-container");
        for (var i = 0; i < all.length; i++) {
            var v = all[i].__vue__;
            if (v && typeof v.initPlayer === "function") return v;
        }
        return null;
    }

    function getCurChannelId(vue) {
        try {
            // 优先从移动端 path /huikan/10 提取
            var pathMatch = location.pathname.match(/\/huikan\/(\d+)/);
            if (pathMatch) return String(pathMatch[1]);

            var urlParams = new URLSearchParams(location.search);
            var qId = urlParams.get("id");
            if (qId) return String(qId);

            if (vue) {
                if (vue.programObj && vue.programObj.channel_id != null) return String(vue.programObj.channel_id);
                if (vue.currChannel && vue.currChannel.id != null) return String(vue.currChannel.id);
                if (vue.currChannelDetail && vue.currChannelDetail.id != null) return String(vue.currChannelDetail.id);
                if (vue.programDetail && vue.programDetail.channel_info && vue.programDetail.channel_info.id != null) {
                    return String(vue.programDetail.channel_info.id);
                }
            }
        } catch(e) {}
        return "10"; // 缺省为 10（五星体育）
    }

    // ===== 5. 鉴权与 RSA 解密 =====
    var SMG_PUBKEY = "-----BEGIN PUBLIC KEY-----\n" +
        "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI\n" +
        "Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt\n" +
        "wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E\n" +
        "tSqSgXDcJ7yDj5rc7wIDAQAB\n" +
        "-----END PUBLIC KEY-----";
    var SMG_API_SECRET = "28c8edde3d61a0411511d3b1866f0636";
    var SMG_API_VERSION = "2.42.23";
    var _smgTokenCache = {};

    function smgMd5(str) {
        function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
        function add(x, y) {
            var l = (x & 0xffff) + (y & 0xffff);
            var m = (x >> 16) + (y >> 16) + (l >> 16);
            return (m << 16) | (l & 0xffff);
        }
        function cmn(q, a, b, x, s, t) { return add(rl(add(add(a, q), add(x, t)), s), b); }
        function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
        function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
        function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
        function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
        function binl(s) {
            var b = [];
            var m = (1 << 8) - 1;
            for (var i = 0; i < s.length * 8; i += 8) b[i >> 5] |= (s.charCodeAt(i / 8) & m) << (i % 32);
            return b;
        }
        function binl2hex(b) {
            var h = "0123456789abcdef";
            var s = "";
            for (var i = 0; i < b.length * 4; i++) {
                s += h.charAt((b[i >> 2] >> ((i % 4) * 8 + 4)) & 0xf) + h.charAt((b[i >> 2] >> ((i % 4) * 8)) & 0xf);
            }
            return s;
        }
        str = unescape(encodeURIComponent(str));
        var x = binl(str);
        x[str.length >> 2] |= 0x80 << ((str.length % 4) << 3);
        x[(((str.length + 8) >> 6) << 4) + 14] = str.length * 8;
        var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
        for (var i = 0; i < x.length; i += 16) {
            var oa = a, ob = b, oc = c, od = d;
            a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i+1], 12, -389564586);
            c = ff(c, d, a, b, x[i+2], 17, 606105819); b = ff(b, c, d, a, x[i+3], 22, -1044525330);
            a = ff(a, b, c, d, x[i+4], 7, -176418897); d = ff(d, a, b, c, x[i+5], 12, 1200080426);
            c = ff(c, d, a, b, x[i+6], 17, -1473231341); b = ff(b, c, d, a, x[i+7], 22, -45705983);
            a = ff(a, b, c, d, x[i+8], 7, 1770035416); d = ff(d, a, b, c, x[i+9], 12, -1958414417);
            c = ff(c, d, a, b, x[i+10], 17, -42063); b = ff(b, c, d, a, x[i+11], 22, -1990404162);
            a = ff(a, b, c, d, x[i+12], 7, 1804603682); d = ff(d, a, b, c, x[i+13], 12, -40341101);
            c = ff(c, d, a, b, x[i+14], 17, -1502002290); b = ff(b, c, d, a, x[i+15], 22, 1236535329);
            a = gg(a, b, c, d, x[i+1], 5, -165796510); d = gg(d, a, b, c, x[i+6], 9, -1069501632);
            c = gg(c, d, a, b, x[i+11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
            a = gg(a, b, c, d, x[i+5], 5, -701558691); d = gg(d, a, b, c, x[i+10], 9, 38016083);
            c = gg(c, d, a, b, x[i+15], 14, -660478335); b = gg(b, c, d, a, x[i+4], 20, -405537848);
            a = gg(a, b, c, d, x[i+9], 5, 568446438); d = gg(d, a, b, c, x[i+14], 9, -1019803690);
            c = gg(c, d, a, b, x[i+3], 14, -187363961); b = gg(b, c, d, a, x[i+8], 20, 1163531501);
            a = gg(a, b, c, d, x[i+13], 5, -1444681467); d = gg(d, a, b, c, x[i+2], 9, -51403784);
            c = gg(c, d, a, b, x[i+7], 14, 1735328473); b = gg(b, c, d, a, x[i+12], 20, -1926607734);
            a = hh(a, b, c, d, x[i+5], 4, -378558); d = hh(d, a, b, c, x[i+8], 11, -2022574463);
            c = hh(c, d, a, b, x[i+11], 16, 1839030562); b = hh(b, c, d, a, x[i+14], 23, -35309556);
            a = hh(a, b, c, d, x[i+1], 4, -1530992060); d = hh(d, a, b, c, x[i+4], 11, 1272893353);
            c = hh(c, d, a, b, x[i+7], 16, -155497632); b = hh(b, c, d, a, x[i+10], 23, -1094730640);
            a = hh(a, b, c, d, x[i+13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
            c = hh(c, d, a, b, x[i+3], 16, -722521979); b = hh(b, c, d, a, x[i+6], 23, 76029189);
            a = hh(a, b, c, d, x[i+9], 4, -640364487); d = hh(d, a, b, c, x[i+12], 11, -421815835);
            c = hh(c, d, a, b, x[i+15], 16, 530742520); b = hh(b, c, d, a, x[i+2], 23, -995338651);
            a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i+7], 10, 1126891415);
            c = ii(c, d, a, b, x[i+14], 15, -1416354905); b = ii(b, c, d, a, x[i+5], 21, -57434055);
            a = ii(a, b, c, d, x[i+12], 6, 1700485571); d = ii(d, a, b, c, x[i+3], 10, -1894986606);
            c = ii(c, d, a, b, x[i+10], 15, -1051523); b = ii(b, c, d, a, x[i+1], 21, -2054922799);
            a = ii(a, b, c, d, x[i+8], 6, 1873313359); d = ii(d, a, b, c, x[i+15], 10, -30611744);
            c = ii(c, d, a, b, x[i+6], 15, -1560198380); b = ii(b, c, d, a, x[i+13], 21, 1309151649);
            a = ii(a, b, c, d, x[i+4], 6, -145523070); d = ii(d, a, b, c, x[i+11], 10, -1120210379);
            c = ii(c, d, a, b, x[i+2], 15, 718787259); b = ii(b, c, d, a, x[i+9], 21, -343485551);
            a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
        }
        return binl2hex([a, b, c, d]);
    }

    function smgRsaDecrypt(enc) {
        try {
            if (!enc || typeof enc !== "string") return "";
            var CryptCls = window.JSEncrypt || (typeof JSEncrypt !== "undefined" ? JSEncrypt : null);
            if (!CryptCls) {
                console.error("[SMGTV] JSEncrypt not available on page context!");
                return "";
            }
            var hex = window.atob(enc).split("").map(function(ch) {
                return ("0" + ch.charCodeAt(0).toString(16)).slice(-2);
            }).join("").toUpperCase();
            if (!hex) return "";

            var crypt = new CryptCls();
            crypt.setPublicKey(SMG_PUBKEY);
            var out = "";
            for (var pos = 0; pos < hex.length;) {
                var chunk = hex.slice(pos, pos + 256);
                pos += 256;
                var bytes = (chunk.replace(/\r|\n/g, "").match(/[\da-fA-F]{2}/g) || [])
                    .map(function(h) { return parseInt(h, 16); });
                var b64 = window.btoa(String.fromCharCode.apply(String, bytes));
                if (!b64) continue;
                var m = crypt.decrypt(b64);
                if (m) out += m;
            }
            return out;
        } catch (e) {
            console.warn("[SMGTV] RSA decrypt error:", e && e.message);
            return "";
        }
    }

    function smgSignParams(params) {
        var n = {
            platform: "pc",
            version: SMG_API_VERSION,
            nonce: Math.random().toString(36).slice(-8),
            timestamp: Math.floor(Date.now() / 1000),
            "Api-Version": "v1"
        };
        var merged = {};
        for (var k in params) merged[k] = params[k];
        for (var nk in n) merged[nk] = n[nk];
        var keys = Object.keys(merged).sort();
        var s = "";
        for (var i = 0; i < keys.length; i++) {
            if (merged[keys[i]] != null) s += keys[i] + "=" + merged[keys[i]] + "&";
        }
        merged.sign = smgMd5(smgMd5(s + SMG_API_SECRET));
        return merged;
    }

    function smgApiGet(path, params) {
        var signed = smgSignParams(params || {});
        var q = Object.keys(params || {}).map(function(k) {
            return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
        }).join("&");
        var headers = { "Accept": "application/json, text/plain, */*" };
        for (var hk in signed) headers[hk] = signed[hk];
        headers["M-Uuid"] = localStorage.getItem("uuid") || "";
        return fetch("https://kapi.kankanews.com" + path + (q ? "?" + q : ""), {
            headers: headers
        }).then(function(resp) { return resp.json(); });
    }

    function smgTokenFromUrl(url) {
        try {
            var u = new URL(url);
            var token = u.searchParams.get("token");
            if (!token) return null;
            var match = u.pathname.match(/\/live\/([^/]+)\//);
            if (!match) return null;
            var payload = JSON.parse(atob(token.split(".")[1]));
            return {
                token: token,
                volcSecret: u.searchParams.get("volcSecret"),
                volcTime: u.searchParams.get("volcTime"),
                stream: match[1],
                exp: payload.exp || 0
            };
        } catch (e) {
            return null;
        }
    }

    var SMG_TOKEN_REFRESH_MARGIN = 120 * 1000;
    function smgTokenValid(t) {
        return !!t && !!t.token && (t.exp * 1000 - Date.now() > SMG_TOKEN_REFRESH_MARGIN);
    }

    function smgFindDonorId(vue, chId) {
        try {
            var targetChId = String(chId || getCurChannelId(vue));
            var lists = [
                vue.programList,
                vue.currentProgramList,
                vue.playingProgramList,
                vue.programDetail && vue.programDetail.program_list
            ];
            for (var i = 0; i < lists.length; i++) {
                var arr = lists[i];
                if (!Array.isArray(arr)) continue;
                for (var j = 0; j < arr.length; j++) {
                    var p = arr[j];
                    if (!p || !p.id) continue;
                    var pChId = p.channel_id != null ? String(p.channel_id) : null;
                    if (pChId && pChId !== targetChId) continue;
                    if (p.is_review === 1 || p.can_review === 1) {
                        return p.id;
                    }
                }
            }
        } catch (e) {}
        return null;
    }

    function smgDateStr(offsetDays) {
        var d = new Date(Date.now() - offsetDays * 86400000);
        var mm = ("0" + (d.getMonth() + 1)).slice(-2);
        var dd = ("0" + d.getDate()).slice(-2);
        return d.getFullYear() + "-" + mm + "-" + dd;
    }

    function smgEnsureToken(vue, cb) {
        var curChId = getCurChannelId(vue);
        var cached = _smgTokenCache[curChId];
        if (smgTokenValid(cached)) {
            cb(cached);
            return;
        }

        var tried = {};
        var queue = [];
        var localDonor = smgFindDonorId(vue, curChId);
        if (localDonor) queue.push(localDonor);

        var scanOffset = 0;
        function scanDay(offset, done) {
            if (offset >= 7) { done(); return; }
            var dateStr = smgDateStr(offset);
            smgApiGet("/content/pc/tv/programs", { channel_id: curChId, date: dateStr }).then(function(data) {
                var list = (data && data.result && data.result.programs) || [];
                for (var j = 0; j < list.length; j++) {
                    var p = list[j];
                    if (p && (p.is_review === 1 || p.can_review === 1) && p.id && !tried[p.id]) {
                        queue.push(p.id);
                    }
                }
                done();
            }).catch(function() { done(); });
        }

        function tryNext() {
            if (!queue.length) {
                scanDay(scanOffset, function() {
                    scanOffset++;
                    if (!queue.length && scanOffset >= 7) {
                        console.error("[SMGTV] Failed to acquire donor token for ch:", curChId);
                        cb(null);
                        return;
                    }
                    tryNext();
                });
                return;
            }
            var donorId = queue.shift();
            if (tried[donorId]) { tryNext(); return; }
            tried[donorId] = true;

            smgApiGet("/content/pc/tv/program/detail", { channel_program_id: donorId }).then(function(data) {
                var res = (data && data.result) || {};
                var enc = res.channel_info && (res.channel_info.shift_address || res.channel_info.live_address);
                if (!enc) { tryNext(); return; }

                var plain = smgRsaDecrypt(enc);
                if (!plain) { tryNext(); return; }

                var t = smgTokenFromUrl(plain);
                if (!t) { tryNext(); return; }

                _smgTokenCache[curChId] = t;
                console.log("[SMGTV] Token acquired for ch " + curChId + " via donor " + donorId);
                cb(t);
            }).catch(function() { tryNext(); });
        }
        tryNext();
    }

    function smgBuildShiftUrl(t, startTime) {
        if (!t) return null;
        return "https://volc-stream.kksmg.com/live/" + t.stream +
            "/index.m3u8?token=" + t.token +
            "&volcSecret=" + t.volcSecret +
            "&volcTime=" + t.volcTime +
            "&startTime=" + startTime;
    }

    function smgBuildLiveUrl(t) {
        if (!t) return null;
        return "https://volc-stream.kksmg.com/live/" + t.stream +
            "/index.m3u8?token=" + t.token +
            "&volcSecret=" + t.volcSecret +
            "&volcTime=" + t.volcTime;
    }

    // ===== 6. 播放器初始化与回看拖动支持 =====
    var _initPlayerPatched = false;
    function patchInitPlayer(vue) {
        if (_initPlayerPatched || !vue || typeof vue.initPlayer !== "function") return;

        var origInitPlayer = vue.initPlayer;
        vue.initPlayer = function() {
            try {
                var pObj = vue.programObj;
                if (pObj && pObj.start_time) {
                    var self = this;
                    var args = arguments;
                    var isLiveEdge = pObj.play !== 0;
                    var wantStart = isLiveEdge ? 0 : pObj.start_time;

                    smgEnsureToken(vue, function(t) {
                        if (!t) {
                            return origInitPlayer.apply(self, args);
                        }
                        var shiftUrl = isLiveEdge ? smgBuildLiveUrl(t) : smgBuildShiftUrl(t, wantStart);
                        if (!shiftUrl) return origInitPlayer.apply(self, args);

                        pObj.is_shield = 0;
                        pObj.is_review = 1;
                        vue.isCopyright = true;
                        if (typeof vue.destroyPlayer === "function") vue.destroyPlayer();

                        var volume = localStorage.getItem("playerVolume");
                        volume = volume ? Number(volume) : 0.6;

                        var programStartTime = isLiveEdge ? Math.floor(Date.now() / 1000) : pObj.start_time;
                        var programEndTime = pObj.end_time || (programStartTime + 7200);

                        // 注入移动端视频必需的行内播放属性
                        vue.player = new vue.$xgplayer({
                            el: vue.$refs.livePlayer,
                            url: shiftUrl,
                            isLive: isLiveEdge,
                            fluid: true,
                            crossOrigin: true,
                            controls: true,
                            autoplay: true,
                            playsinline: true,
                            "webkit-playsinline": true,
                            "x5-video-player-type": "h5-page",
                            volume: volume,
                            playbackRate: [2, 1.5, 1.25, 1, 0.75, 0.5],
                            ignores: ["cssFullscreen"],
                            keyShortcut: true,
                            lang: "zh-cn",
                            closeVideoClick: true,
                            plugins: [vue.$hlsPlayer]
                        });
                        vue.player.muted = !!vue.isMuted;

                        // 挂载时间轴虚拟寻道
                        if (!isLiveEdge) {
                            setTimeout(function() {
                                var dur = programEndTime - programStartTime;
                                if (vue.player && vue.player.video) {
                                    Object.defineProperty(vue.player.video, "duration", {
                                        get: function() { return dur; },
                                        configurable: true
                                    });
                                }
                            }, 500);
                        }

                        vue.player.on("canplay", function() {
                            vue.isLoading = false;
                        });
                        setTimeout(function() {
                            try { if (vue.player.paused) vue.player.play(); } catch(e) {}
                        }, 300);
                        return;
                    });
                    return;
                }
            } catch(e) {
                console.error("[SMGTV] initPlayer patch exception:", e);
            }
            return origInitPlayer.apply(this, arguments);
        };
        _initPlayerPatched = true;
        console.log("[SMGTV] initPlayer successfully hooked");
    }

    // ===== 7. 页面状态与倒计时解锁 =====
    function tryPatch() {
        var vue = findVue();
        if (!vue) return false;

        patchInitPlayer(vue);

        function fixObj(o) {
            if (!o) return;
            o.is_shield = 0;
            o.is_review = 1;
            o.can_review = 1;
        }

        fixObj(vue.programObj);
        fixObj(vue.programDetail);
        fixObj(vue.playingProgramObj);
        if (Array.isArray(vue.programList)) vue.programList.forEach(fixObj);
        if (Array.isArray(vue.currentProgramList)) vue.currentProgramList.forEach(fixObj);

        vue.isCopyright = false;
        if (typeof vue.countdown === "number") vue.countdown = 99999999;
        vue.showOpenApp = false;
        vue.showFlag = false;
        if (typeof vue.startCountdown === "function") vue.startCountdown = function() {};
        if (vue.liveTimer) { clearTimeout(vue.liveTimer); vue.liveTimer = null; }

        if (typeof vue.pageVisibilityChange === "function") {
            document.removeEventListener("visibilitychange", vue.pageVisibilityChange);
            vue.pageVisibilityChange = function() {};
        }

        if (!vue.player && vue.programObj && vue.programObj.id) {
            try { vue.initPlayer(); } catch(e) {}
        }

        try { vue.$forceUpdate(); } catch(e) {}
        return true;
    }

    // 监听 DOM 树动态加载
    var observer = new MutationObserver(function() {
        if (tryPatch()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    var count = 0;
    var pollTimer = setInterval(function() {
        count++;
        if (tryPatch() || count >= 80) {
            clearInterval(pollTimer);
        }
    }, 500);

    // 路由切换保活
    var lastHref = location.href;
    setInterval(function() {
        var mask = document.querySelector(".image-mask");
        if (mask && mask.style.display !== "none") mask.style.display = "none";

        if (location.href !== lastHref) {
            lastHref = location.href;
            setTimeout(tryPatch, 1500);
        }
    }, 1000);

})();
