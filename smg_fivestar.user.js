// ==UserScript==
// @name             收看SMGTV电视节目
// @namespace        https://github.com/jolin1314joker/SMG_TV
// @version          0.20.1
// @description      SMGTV 直播与回放；修复 CDN 签名提前到期导致的断流、重复初始化，支持自动续期和网络错误重试。
// @author           https://github.com/jolin1314joker
// @match            https://live.kankanews.com/*
// @match            https://m.kankanews.com/*
// @match            http://live.kankanews.com/*
// @match            http://m.kankanews.com/*
// @icon             https://live.kankanews.com/favicon.ico
// @grant            none
// @run-at           document-body
// @compatible       safari
// @compatible       stay
// ==/UserScript==

(function() {
    "use strict";

    console.log("[SMGTV] ========== v0.20.1 (CDN expiry fix) ==========");
    console.log("[SMGTV] URL:", location.href);
    console.log("[SMGTV] UA:", navigator.userAgent);

    // ===== 1. CSS: hide copyright mask =====
    var style = document.createElement("style");
    style.textContent = ".image-mask{display:none!important}.video-tip{display:none!important}";
    (document.head || document.documentElement).appendChild(style);
    console.log("[SMGTV] CSS injected");

    // ===== 2. Patch webpack module 560 (E.a URL decryption bypass) =====
    var _module560Patched = false;
    function patchModule560() {
        if (_module560Patched) return;
        try {
            window.webpackJsonp.push([[], {
                '__smg_m560_probe': function(module, exports, __webpack_require__) {
                    try {
                        var mod560 = __webpack_require__(560);
                        if (mod560 && typeof mod560.a === 'function') {
                            var origEa = mod560.a;
                            mod560.a = function(t) {
                                if (typeof t === 'string' && t.indexOf('http') === 0) {
                                    console.log("[SMGTV] [Replay] E.a bypass — plain URL passthrough:", t.substring(0, 80));
                                    return t;
                                }
                                return origEa.apply(this, arguments);
                            };
                            _module560Patched = true;
                            console.log("[SMGTV] Module 560 (E.a) patched successfully");
                        }
                    } catch(e) {
                        console.warn("[SMGTV] Module 560 patch failed:", e.message);
                    }
                }
            }, ['__smg_m560_probe']]);
        } catch(e) {
            console.warn("[SMGTV] webpack chunk push failed:", e.message);
        }
    }
    patchModule560();

    // ===== 3. Intercept API responses =====
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        var urlStr = String(url);
        if (urlStr.indexOf("/content/pc/tv/") !== -1) {
            var xhr = this;
            xhr.addEventListener("readystatechange", function() {
                if (xhr.readyState === 4 && xhr.status === 200) {
                    console.log("[SMGTV] XHR response received for:", urlStr.substring(0, 80));
                    setTimeout(tryPatch, 30);
                }
            });
        }
        return origOpen.apply(this, arguments);
    };

    var origFetch = window.fetch;
    window.fetch = function(input, init) {
        var urlStr = typeof input === "string" ? input : (input && input.url) || "";
        if (urlStr.indexOf("/content/pc/tv/") !== -1) {
            return origFetch.apply(this, arguments).then(function(resp) {
                console.log("[SMGTV] fetch response received, re-patching Vue...");
                setTimeout(tryPatch, 50);
                return resp;
            });
        }
        return origFetch.apply(this, arguments);
    };

    console.log("[SMGTV] API interceptors ready");

    // ===== 4. Patch Vue component =====
    function findComponent(root, name) {
        if (!root) return null;
        if (root.$options && root.$options.name === name) return root;
        for (var i = 0; root.$children && i < root.$children.length; i++) {
            var found = findComponent(root.$children[i], name);
            if (found) return found;
        }
        return null;
    }

    function findVue() {
        var el = document.querySelector(".huikan");
        if (el && el.__vue__ && typeof el.__vue__.initPlayer === "function") {
            return el.__vue__;
        }

        var root = document.querySelector("#__nuxt");
        if (root && root.__vue__) {
            var comp = findComponent(root.__vue__, "HuikanIndex");
            if (comp && typeof comp.initPlayer === "function") {
                return comp;
            }
        }

        var all = document.querySelectorAll("[class*=huikan], [id*=huikan], .live-player, .video-wrap");
        for (var i = 0; i < all.length; i++) {
            var v = all[i].__vue__;
            if (v && typeof v.initPlayer === "function") {
                return v;
            }
        }

        var any = document.querySelectorAll("*");
        for (var j = 0; j < any.length && j < 500; j++) {
            var vw = any[j].__vue__;
            if (vw && vw.$options && vw.$options.name === "HuikanIndex") {
                return vw;
            }
        }

        return null;
    }

    // Helper: Determine currently targeted channel ID reliably
    function getCurChannelId(vue) {
        try {
            if (vue && vue.programObj && vue.programObj.channel_id != null) {
                return String(vue.programObj.channel_id);
            }
            var urlParams = new URLSearchParams(location.search);
            var qId = urlParams.get("id");
            if (qId) return String(qId);
            var pathMatch = location.pathname.match(/\/huikan\/(\d+)/);
            if (pathMatch) return String(pathMatch[1]);
            if (vue) {
                if (vue.currChannel && vue.currChannel.id != null) return String(vue.currChannel.id);
                if (vue.currChannelDetail && vue.currChannelDetail.id != null) return String(vue.currChannelDetail.id);
                if (vue.programDetail && vue.programDetail.channel_info && vue.programDetail.channel_info.id != null) {
                    return String(vue.programDetail.channel_info.id);
                }
            }
        } catch(e) {}
        return "10"; // Default: 10 (Five Star Sports)
    }

    // ===== 4b. Token bootstrap (Channel-Isolated) =====
    var SMG_PUBKEY = "-----BEGIN PUBLIC KEY-----\n" +
        "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI\n" +
        "Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt\n" +
        "wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E\n" +
        "tSqSgXDcJ7yDj5rc7wIDAQAB\n" +
        "-----END PUBLIC KEY-----";
    var SMG_API_SECRET = "28c8edde3d61a0411511d3b1866f0636";
    var SMG_API_VERSION = "2.42.23";
    // Known donor IDs specifically belonging to Channel 10 (Five Star Sports)
    var SMG_DONOR_IDS = [2215494, 2215102, 2213967];
    var SMG_DONOR_SCAN_DAYS = 7;
    // Map of channelId -> token object
    var _smgTokenCache = {};
    var _smgTokenRequests = {};

    function smgMd5(str) {
        function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
        function add(x, y) {
            var l = (x & 0xffff) + (y & 0xffff);
            var m = (x >> 16) + (y >> 16) + (l >> 16);
            return (m << 16) | (l & 0xffff);
        }
        function cmn(q, a, b, x, s, t) {
            a = add(add(a, q), add(x, t));
            return add(rl(a, s), b);
        }
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
            if (typeof JSEncrypt === "undefined") return "";
            var hex = window.atob(enc).split("").map(function(ch) {
                return ("0" + ch.charCodeAt(0).toString(16)).slice(-2);
            }).join("").toUpperCase();
            if (!hex) return "";
            var crypt = new JSEncrypt();
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
            console.warn("[SMGTV] smgRsaDecrypt failed:", e && e.message);
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
        var k;
        for (k in params) merged[k] = params[k];
        for (k in n) merged[k] = n[k];
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
        var hk;
        for (hk in signed) headers[hk] = signed[hk];
        headers["M-Uuid"] = localStorage.getItem("uuid") || "";
        // Internal requests must not trigger our own Vue/initPlayer interceptor.
        return new Promise(function(resolve, reject) {
            var controller = typeof AbortController === "function" ? new AbortController() : null;
            var timer = setTimeout(function() {
                reject(new Error("API request timed out"));
                if (controller) controller.abort();
            }, 15000);
            var options = { headers: headers, cache: "no-store" };
            if (controller) options.signal = controller.signal;
            Promise.resolve().then(function() {
                return origFetch.call(window, "https://kapi.kankanews.com" + path + (q ? "?" + q : ""), options);
            }).then(function(resp) {
                if (!resp.ok) throw new Error("API HTTP " + resp.status);
                return resp.json();
            }).then(function(data) {
                clearTimeout(timer);
                resolve(data);
            }, function(error) {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    function smgTokenFromUrl(url) {
        try {
            var u = new URL(url);
            var token = u.searchParams.get("token");
            if (!token) return null;
            var match = u.pathname.match(/\/live\/([^/]+)\//);
            if (!match) return null;
            var encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
            while (encoded.length % 4) encoded += "=";
            var payload = JSON.parse(atob(encoded));
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
    function smgTokenExpiresAt(t) {
        if (!t || !t.token || !t.volcSecret) return 0;
        var jwtExp = Number(t.exp);
        var cdnExp = Number(t.volcTime);
        if (!isFinite(jwtExp) || jwtExp <= 0 || !isFinite(cdnExp) || cdnExp <= 0) return 0;
        // The JWT can last 12 hours while the CDN signature lasts only 10 minutes.
        return Math.min(jwtExp, cdnExp) * 1000;
    }
    function smgTokenValid(t) {
        return smgTokenMsLeft(t) > SMG_TOKEN_REFRESH_MARGIN;
    }
    function smgTokenMsLeft(t) {
        var expiresAt = smgTokenExpiresAt(t);
        return expiresAt ? expiresAt - Date.now() : 0;
    }

    // Precise donor finder: must belong to target channel
    function smgFindDonorId(vue, chId) {
        try {
            var targetChId = String(chId || getCurChannelId(vue));
            var lists = [vue.programList, vue.currentProgramList, vue.playingProgramList];
            for (var i = 0; i < lists.length; i++) {
                var arr = lists[i];
                if (!Array.isArray(arr)) continue;
                for (var j = 0; j < arr.length; j++) {
                    var p = arr[j];
                    if (!p || !p.id || p.is_review !== 1) continue;

                    var pChId = p.channel_id != null ? String(p.channel_id) : null;
                    if (pChId && pChId !== targetChId) {
                        continue; // Strictly filter out other channels (e.g. Dragon TV ch 1)
                    }

                    if (targetChId === "10") {
                        if (p.name && p.name.indexOf("体育") !== -1) {
                            return p.id;
                        }
                    } else {
                        return p.id;
                    }
                }
            }
        } catch (e) {}

        if (String(chId) === "10") {
            return SMG_DONOR_IDS[0];
        }
        return null;
    }

    function smgDateStr(offsetDays) {
        var d = new Date(Date.now() - offsetDays * 86400000);
        var mm = ("0" + (d.getMonth() + 1)).slice(-2);
        var dd = ("0" + d.getDate()).slice(-2);
        return d.getFullYear() + "-" + mm + "-" + dd;
    }

    function smgEnsureToken(vue, cb, forceRefresh) {
        var curChId = getCurChannelId(vue);
        if (_smgTokenRequests[curChId]) {
            _smgTokenRequests[curChId].push(cb);
            return;
        }
        var cached = _smgTokenCache[curChId];
        if (!forceRefresh && smgTokenValid(cached)) {
            cb(cached);
            return;
        }
        _smgTokenRequests[curChId] = [cb];
        function finish(t) {
            var callbacks = _smgTokenRequests[curChId] || [];
            delete _smgTokenRequests[curChId];
            callbacks.forEach(function(callback) {
                try { callback(t); }
                catch (error) { console.error("[SMGTV] Token callback failed:", error && error.message); }
            });
        }

        var tried = {};
        var queue = [];
        function enqueue(id) {
            if (id && !tried[id] && queue.indexOf(id) === -1) queue.push(id);
        }

        var localDonor = smgFindDonorId(vue, curChId);
        if (localDonor) enqueue(localDonor);

        if (String(curChId) === "10") {
            for (var i = 0; i < SMG_DONOR_IDS.length; i++) enqueue(SMG_DONOR_IDS[i]);
        }

        console.log("[SMGTV] [Token] channel:", curChId, "donor queue:", queue.join(","));

        var scanOffset = 0;
        function scanDay(offset, done) {
            if (offset >= SMG_DONOR_SCAN_DAYS) {
                done();
                return;
            }
            var dateStr = smgDateStr(offset);
            console.log("[SMGTV] [Token] scanning programs for donor (ch " + curChId + "):", dateStr);
            smgApiGet("/content/pc/tv/programs", { channel_id: curChId, date: dateStr }).then(function(data) {
                var list = (data && data.result && data.result.programs) || [];
                var added = 0;
                for (var j = 0; j < list.length; j++) {
                    var p = list[j];
                    if (p && p.is_review === 1 && p.id &&
                        tried[p.id] === undefined && queue.indexOf(p.id) === -1) {
                        if (String(curChId) === "10") {
                            if (p.name && p.name.indexOf("体育") !== -1) {
                                queue.unshift(p.id); // Priority for sports news
                                added++;
                            } else {
                                queue.push(p.id);
                                added++;
                            }
                        } else {
                            queue.push(p.id);
                            added++;
                        }
                    }
                }
                console.log("[SMGTV] [Token] scan " + dateStr + ": +" + added + " donors");
                done();
            }).catch(function(e) {
                console.warn("[SMGTV] [Token] scan failed for " + dateStr + ":", e && e.message);
                done();
            });
        }

        function tryNext() {
            if (!queue.length) {
                scanDay(scanOffset, function() {
                    scanOffset++;
                    if (!queue.length && scanOffset >= SMG_DONOR_SCAN_DAYS) {
                        console.error("[SMGTV] [Token] bootstrap failed: all donors empty for ch " + curChId);
                        finish(null);
                        return;
                    }
                    tryNext();
                });
                return;
            }
            var donorId = queue.shift();
            if (tried[donorId]) {
                tryNext();
                return;
            }
            tried[donorId] = true;
            console.log("[SMGTV] [Token] fetching donor program/detail:", donorId);
            smgApiGet("/content/pc/tv/program/detail", { channel_program_id: donorId }).then(function(data) {
                var res = (data && data.result) || {};
                var enc = res.channel_info && res.channel_info.shift_address;
                if (!enc && res.channel_info && res.channel_info.live_address) {
                    enc = res.channel_info.live_address;
                }
                if (!enc) {
                    console.warn("[SMGTV] [Token] donor empty, trying next (id=" + donorId + ")");
                    tryNext();
                    return;
                }
                var plain = smgRsaDecrypt(enc);
                if (!plain) throw new Error("donor decrypt failed (id=" + donorId + ")");
                var t = smgTokenFromUrl(plain);
                if (!t) throw new Error("donor URL parse failed (id=" + donorId + ")");
                if (!smgTokenValid(t)) throw new Error("donor URL expired or expires too soon (id=" + donorId + ")");

                // Store isolated by channel ID
                _smgTokenCache[curChId] = t;
                if (String(curChId) === "10" && SMG_DONOR_IDS[0] !== donorId) {
                    SMG_DONOR_IDS.unshift(donorId);
                }
                console.log("[SMGTV] [Token] ready for ch " + curChId + " via donor " + donorId + ", stream=" + t.stream,
                    "expires=" + new Date(smgTokenExpiresAt(t)).toLocaleString());
                finish(t);
            }).catch(function(e) {
                console.warn("[SMGTV] [Token] donor error, trying next:", e && e.message);
                tryNext();
            });
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

    // Renew the credentials used by this player, not merely the shared cache.
    var _smgWatchdogCleanup = null;
    function smgStartPlaybackWatchdog(vue, player, switchSource) {
        smgStopPlaybackWatchdog();
        var channelId = getCurChannelId(vue);
        var activeToken = _smgTokenCache[channelId];
        var stopped = false;
        var refreshing = false;
        var needsRecovery = false;
        var errorGeneration = 0;
        var failures = 0;
        var retryAt = 0;
        var lastPosition = Number(player.currentTime) || 0;
        var lastProgressAt = Date.now();

        function isCurrent() {
            return !stopped && !vue._isDestroyed && vue.player === player &&
                getCurChannelId(vue) === channelId;
        }
        function failed(error) {
            if (!isCurrent()) return;
            refreshing = false;
            needsRecovery = true;
            failures++;
            retryAt = Date.now() + Math.min(120000, 15000 * Math.pow(2, Math.min(failures - 1, 3)));
            console.warn("[SMGTV] [Playback] renewal failed; retry in " +
                Math.round((retryAt - Date.now()) / 1000) + "s:", error && error.message);
        }
        function tick() {
            if (stopped) return;
            if (!isCurrent()) { cleanup(); return; }
            var now = Date.now();
            var video = player.video;
            var position = Number(player.currentTime) || 0;
            if (position !== lastPosition || player.paused || (video && (video.seeking || video.ended))) {
                lastProgressAt = now;
            } else if (now - lastProgressAt >= 60000) {
                needsRecovery = true;
            }
            lastPosition = position;
            if (video && video.error && video.error.code !== 1) needsRecovery = true;
            if (refreshing || now < retryAt) return;
            if (!needsRecovery && smgTokenMsLeft(activeToken) > SMG_TOKEN_REFRESH_MARGIN) return;

            refreshing = true;
            var generation = errorGeneration;
            var resume = needsRecovery || !player.paused;
            console.log("[SMGTV] [Playback] renewing ch " + channelId +
                ", seconds left=" + Math.round(smgTokenMsLeft(activeToken) / 1000));
            smgEnsureToken(vue, function(t) {
                if (!isCurrent()) return;
                if (!t) { failed(new Error("no usable playback credentials")); return; }
                Promise.resolve().then(function() {
                    if (isCurrent()) return switchSource(t);
                }).then(function() {
                    if (!isCurrent()) return;
                    if (generation !== errorGeneration) {
                        failed(new Error("playback error during source switch"));
                        return;
                    }
                    activeToken = t;
                    refreshing = false;
                    needsRecovery = false;
                    failures = 0;
                    retryAt = Date.now() + 15000;
                    lastPosition = Number(player.currentTime) || 0;
                    lastProgressAt = Date.now();
                    // HLS switchURL can start playback itself; restore an intentional pause.
                    if (!resume) player.pause();
                    if (resume && player.paused) {
                        try {
                            Promise.resolve(player.play()).catch(function(error) {
                                console.warn("[SMGTV] [Playback] click play to resume:", error && error.message);
                            });
                        } catch (error) {
                            console.warn("[SMGTV] [Playback] play failed:", error && error.message);
                        }
                    }
                    console.log("[SMGTV] [Playback] renewed; expires=" +
                        new Date(smgTokenExpiresAt(t)).toLocaleString());
                }).catch(failed);
            }, true);
        }
        function onError() {
            if (!isCurrent()) return;
            errorGeneration++;
            needsRecovery = true;
            tick();
        }
        function cleanup() {
            stopped = true;
            clearInterval(timer);
            if (typeof player.off === "function") player.off("error", onError);
            if (player.video) player.video.removeEventListener("error", onError);
        }
        var timer = setInterval(tick, 15000);
        if (typeof player.on === "function") player.on("error", onError);
        if (player.video) player.video.addEventListener("error", onError);
        _smgWatchdogCleanup = cleanup;
        console.log("[SMGTV] [Playback] watchdog started (15s tick)");
    }
    function smgStopPlaybackWatchdog() {
        if (_smgWatchdogCleanup) {
            _smgWatchdogCleanup();
            _smgWatchdogCleanup = null;
        }
    }

    // ===== 4c. Replay: dynamic startTime + real source-switch seeking =====
    function patchInitPlayer(vue) {
        if (!vue || typeof vue.initPlayer !== "function") return;
        if (vue.__smgInitPlayerPatched) return;

        var origInitPlayer = vue.initPlayer;
        vue.initPlayer = function() {
            try {
                var pObj = vue.programObj;
                if (pObj && pObj.start_time) {
                    var channelId = getCurChannelId(vue);
                    var requestKey = channelId + ":" + pObj.id + ":" + pObj.play;
                    if (vue.__smgPendingInit === requestKey) return;
                    vue.__smgPendingInit = requestKey;
                    var generation = (vue.__smgInitGeneration || 0) + 1;
                    vue.__smgInitGeneration = generation;
                    var self = this;
                    var args = arguments;
                    var isLiveEdge = pObj.play !== 0;
                    var wantStart = isLiveEdge ? 0 : pObj.start_time;
                    smgEnsureToken(vue, function(t) {
                        if (vue.__smgInitGeneration !== generation) return;
                        vue.__smgPendingInit = null;
                        if (vue._isDestroyed || getCurChannelId(vue) !== channelId ||
                            !vue.programObj || String(vue.programObj.id) !== String(pObj.id) ||
                            (vue.programObj.play !== 0) !== isLiveEdge) return;
                        if (!t) {
                            console.error("[SMGTV] [Replay] no token, falling back to orig initPlayer");
                            return origInitPlayer.apply(self, args);
                        }
                        var shiftUrl = isLiveEdge ? smgBuildLiveUrl(t) : smgBuildShiftUrl(t, wantStart);
                        if (shiftUrl) {
                            pObj.is_shield = 0;
                            pObj.is_review = 1;
                            vue.isCopyright = true;
                            smgStopPlaybackWatchdog();
                            vue.destroyPlayer();

                            var volume = localStorage.getItem("playerVolume");
                            volume = volume ? Number(volume) : 0.5;

                            var programStartTime = isLiveEdge ? Math.floor(Date.now() / 1000) : pObj.start_time;
                            var programEndTime = pObj.end_time || (programStartTime + 7200);

                            vue.player = new vue.$xgplayer({
                                el: vue.$refs.livePlayer,
                                url: shiftUrl,
                                isLive: isLiveEdge,
                                fluid: true,
                                crossOrigin: true,
                                controls: true,
                                volume: volume,
                                playbackRate: [2, 1.5, 1.25, 1, 0.75, 0.5],
                                ignores: ["cssFullscreen"],
                                keyShortcut: true,
                                lang: "zh-cn",
                                closeVideoClick: true,
                                plugins: [vue.$hlsPlayer]
                            });
                            vue.player.muted = vue.isMuted;
                            var createdPlayer = vue.player;

                            function hookManifestLoader(player) {
                                var attempts = 0;
                                var hookTimer = setInterval(function() {
                                    if (vue.player !== player || vue._isDestroyed) {
                                        clearInterval(hookTimer);
                                        return;
                                    }
                                    attempts++;
                                    var hlsPlugin = player.plugins && player.plugins.hls;
                                    var hls = hlsPlugin && hlsPlugin.hls;
                                    if (!hls || !hls._manifestLoader) {
                                        if (attempts > 20) { clearInterval(hookTimer); }
                                        return;
                                    }
                                    clearInterval(hookTimer);

                                    var manifestLoader = hls._manifestLoader;
                                    var origMlLoad = manifestLoader.load.bind(manifestLoader);

                                    var _virtualPos = 0;
                                    var _virtualPosTs = Date.now();
                                    var _isSeeking = false;
                                    var _hasUserSeek = false;
                                    var _seekGeneration = 0;
                                    var _seekDebounceTimer = null;
                                    var _seekSwitchQueue = Promise.resolve();

                                    try {
                                        Object.defineProperty(player, "offsetCurrentTime", {
                                            get: function() { return _virtualPos; },
                                            set: function() {},
                                            configurable: true,
                                            enumerable: true
                                        });
                                    } catch (e) {
                                        console.warn("[SMGTV] [Replay] Could not lock offsetCurrentTime:", e);
                                    }

                                    function clampVirtualPos(pos) {
                                        pos = Number(pos);
                                        if (!isFinite(pos)) return 0;
                                        return Math.max(0, Math.min(
                                            programEndTime - programStartTime, pos));
                                    }

                                    function publishVirtualPos() {
                                        player.offsetCurrentTime = _virtualPos;
                                    }

                                    var positionTimer = setInterval(function() {
                                        if (vue.player !== player) { clearInterval(positionTimer); return; }
                                        if (!player.paused && !_isSeeking) {
                                            var now = Date.now();
                                            _virtualPos += (now - _virtualPosTs) / 1000;
                                            _virtualPosTs = now;
                                            _virtualPos = clampVirtualPos(_virtualPos);
                                            publishVirtualPos();
                                        } else {
                                            _virtualPosTs = Date.now();
                                        }
                                    }, 500);

                                    var syncTimer = setInterval(function() {
                                        if (vue.player !== player) { clearInterval(syncTimer); return; }
                                        if (!player.paused && !_isSeeking && !_hasUserSeek) {
                                            _virtualPos = clampVirtualPos(player.currentTime);
                                            _virtualPosTs = Date.now();
                                            publishVirtualPos();
                                        }
                                    }, 1000);
                                    publishVirtualPos();

                                    player.seek = function(time) {
                                        var target = clampVirtualPos(time);
                                        var seekTs = Math.floor(programStartTime + target);
                                        ++_seekGeneration;
                                        var wasPaused = player.paused;
                                        _hasUserSeek = true;
                                        _virtualPos = target;
                                        _virtualPosTs = Date.now();
                                        _isSeeking = true;
                                        publishVirtualPos();

                                        if (_seekDebounceTimer) {
                                            clearTimeout(_seekDebounceTimer);
                                        }

                                        console.log("[SMGTV] [Replay] Seek target → pos=" +
                                            target.toFixed(1) + "s", "seekTime=" + seekTs);

                                        _seekDebounceTimer = setTimeout(function() {
                                            var finalTarget = _virtualPos;
                                            var finalTs = Math.floor(programStartTime + finalTarget);
                                            var finalGeneration = _seekGeneration;
                                            var finalWasPaused = player.paused;

                                            _seekSwitchQueue = _seekSwitchQueue.catch(function() {}).then(function() {
                                                if (finalGeneration !== _seekGeneration || vue.player !== player) return;

                                                var activeChId = getCurChannelId(vue);
                                                var seekUrl = smgBuildShiftUrl(_smgTokenCache[activeChId], finalTs);
                                                if (!seekUrl || typeof player.switchURL !== "function") {
                                                    console.error("[SMGTV] [Replay] switchURL unavailable; seek cancelled");
                                                    _isSeeking = false;
                                                    return;
                                                }

                                                console.log("[SMGTV] [Replay] Switching source:",
                                                    "vPos=" + finalTarget.toFixed(1) + "s",
                                                    "seekTime=" + finalTs);

                                                var switchPromise;
                                                try {
                                                    switchPromise = player.switchURL(seekUrl, {
                                                        seamless: false,
                                                        currentTime: 0
                                                    });
                                                } catch (error) {
                                                    _isSeeking = false;
                                                    console.error("[SMGTV] [Replay] Seek source switch failed:", error);
                                                    return;
                                                }

                                                return Promise.resolve(switchPromise).then(function() {
                                                    if (finalGeneration !== _seekGeneration) return;
                                                    _isSeeking = false;
                                                    _virtualPosTs = Date.now();
                                                    publishVirtualPos();
                                                    if (finalWasPaused) player.pause();
                                                    else player.play();
                                                    console.log("[SMGTV] [Replay] Seek source switched:",
                                                        "vPos=" + _virtualPos.toFixed(1) + "s");
                                                }).catch(function(error) {
                                                    if (finalGeneration !== _seekGeneration) return;
                                                    _isSeeking = false;
                                                    console.error("[SMGTV] [Replay] Seek source switch failed:", error);
                                                });
                                            });
                                        }, 150);

                                        return undefined;
                                    };

                                    manifestLoader.load = function(url) {
                                        if (typeof url === "string" && url.indexOf("startTime=") !== -1) {
                                            var newStartTime = Math.floor(programStartTime + _virtualPos);
                                            var newUrl = url.replace(/startTime=\d+/, "startTime=" + newStartTime);
                                            if (newUrl !== url) {
                                                console.log("[SMGTV] [Replay] startTime→",
                                                    "vPos=" + _virtualPos.toFixed(1) + "s",
                                                    "→ ts=" + newStartTime);
                                            }
                                            return origMlLoad(newUrl);
                                        }
                                        return origMlLoad.apply(this, arguments);
                                    };

                                    console.log("[SMGTV] [Replay] Manifest loader hooked (virtual pos tracker)");
                                    var dur = programEndTime - programStartTime;
                                    Object.defineProperty(player.video, "duration", {
                                        get: function() { return dur; },
                                        configurable: true
                                    });
                                    player._duration = dur;

                                    // Share the seek queue so renewal cannot race a user seek.
                                    smgStartPlaybackWatchdog(vue, player, function(t) {
                                        _seekSwitchQueue = _seekSwitchQueue.catch(function() {}).then(function() {
                                            if (vue.player !== player) return;
                                            _hasUserSeek = true;
                                            _isSeeking = true;
                                            var url = smgBuildShiftUrl(t, Math.floor(programStartTime + _virtualPos));
                                            return Promise.resolve().then(function() {
                                                return player.switchURL(url, { seamless: false, currentTime: 0 });
                                            }).then(function() {
                                                _isSeeking = false;
                                                _virtualPosTs = Date.now();
                                                publishVirtualPos();
                                            }, function(error) {
                                                _isSeeking = false;
                                                throw error;
                                            });
                                        });
                                        return _seekSwitchQueue;
                                    });

                                    console.log("[SMGTV] [Replay] Program duration set:",
                                        dur + "s (" + (dur / 60).toFixed(1) + " min)");
                                }, 200);
                            }

                            if (!isLiveEdge) {
                                hookManifestLoader(vue.player);
                            } else {
                                smgStartPlaybackWatchdog(vue, createdPlayer, function(tok) {
                                    return createdPlayer.switchURL(smgBuildLiveUrl(tok), { seamless: false, currentTime: 0 });
                                });
                            }

                            vue.player.on("canplay", function() {
                                vue.isLoading = false;
                                if (!isLiveEdge) vue.player.video.dispatchEvent(new Event("loadedmetadata"));
                            });
                            vue.player.on("ended", function() {
                                if (vue.programObj.play === 0 && typeof vue.playNextProgram === "function") {
                                    vue.playNextProgram();
                                }
                            });
                            setTimeout(function() {
                                if (vue.player === createdPlayer) {
                                    Promise.resolve(createdPlayer.play()).catch(function() {});
                                }
                            }, 200);
                            vue.player.video.addEventListener("click", function() {
                                if (vue.player.paused) vue.player.play();
                                else vue.player.pause();
                            });

                            console.log("[SMGTV] [Player] Created for:", pObj.name,
                                "channel:", getCurChannelId(vue),
                                "startTime:", programStartTime,
                                "duration:", (programEndTime - programStartTime) + "s",
                                "url:", shiftUrl.substring(0, 80));
                            return;
                        }
                        console.warn("[SMGTV] [Replay] shift URL build failed, falling back to orig initPlayer");
                        return origInitPlayer.apply(self, args);
                    });
                    return;
                }
            } catch(e) {
                vue.__smgPendingInit = null;
                console.error("[SMGTV] [Replay] initPlayer intercept error:", e);
            }
            return origInitPlayer.apply(this, arguments);
        };
        vue.__smgInitPlayerPatched = true;
        console.log("[SMGTV] [Replay] initPlayer patched");
    }

    function tryPatch() {
        var vue = findVue();
        if (!vue) return false;

        console.log("[SMGTV] Vue component found, patching...");
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

        if (vue.currChannelDetail) {
            vue.currChannelDetail.copyright_image = "";
        }
        if (vue.currChannel) {
            vue.currChannel.copyright_image = "";
        }

        if (vue.currChannelDetail && vue.currChannelDetail.live_address) {
            if (!vue.programDetail) vue.programDetail = {};
            if (!vue.programDetail.channel_info) vue.programDetail.channel_info = {};
            if (!vue.programDetail.channel_info.live_address) {
                vue.programDetail.channel_info.live_address = vue.currChannelDetail.live_address;
            }
        }

        vue.isCopyright = false;

        if (typeof vue.countdown === "number") vue.countdown = 99999999;
        vue.showOpenApp = false;
        vue.showFlag = false;
        if (typeof vue.startCountdown === "function") vue.startCountdown = function() {};
        if (vue.liveTimer) { clearTimeout(vue.liveTimer); vue.liveTimer = null; }

        if (typeof vue.pageVisibilityChange === "function") {
            document.removeEventListener("visibilitychange", vue.pageVisibilityChange);
            vue.pageVisibilityChange = function() {};
            document.addEventListener("visibilitychange", vue.pageVisibilityChange);
        }

        if (!vue.player && vue.programObj && vue.programObj.id) {
            console.log("[SMGTV] Calling initPlayer()...");
            try { vue.initPlayer(); } catch(e) { console.error("[SMGTV] initPlayer error:", e); }
        }

        vue.$forceUpdate();
        vue.__smgPatched = true;
        console.log("[SMGTV] Patch applied!");
        return true;
    }

    if (tryPatch()) {
        console.log("[SMGTV] Patched immediately");
    } else {
        console.log("[SMGTV] Waiting for component...");
        var observer = new MutationObserver(function() {
            if (tryPatch()) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        var count = 0;
        var timer = setInterval(function() {
            count++;
            if (tryPatch()) {
                clearInterval(timer);
                observer.disconnect();
                console.log("[SMGTV] Patched after " + count + " polls");
            } else if (count >= 120) {
                clearInterval(timer);
                observer.disconnect();
                console.warn("[SMGTV] Timeout after 60s — check Console [SMGTV] logs for diagnostics");
            }
        }, 500);
    }

    // ===== 5. SPA route change: re-patch when user switches channels =====
    var lastHref = location.href;
    setInterval(function() {
        var mask = document.querySelector(".image-mask");
        if (mask && mask.style.display !== "none") mask.style.display = "none";

        if (location.href !== lastHref) {
            lastHref = location.href;
            console.log("[SMGTV] Route changed, re-patching in 2s...");
            setTimeout(tryPatch, 2000);
        }
    }, 1000);

})();

/*
MIT License

Copyright (c) 2026 roies

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
