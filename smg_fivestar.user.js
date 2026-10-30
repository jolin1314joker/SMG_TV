// ==UserScript==
// @name             看东方直播解锁（SMG TV）
// @namespace        https://github.com/jolin1314joker/SMG_TV
// @version          1.0.0
// @description      解除 live.kankanews.com 的网页观看限制：直播直连、节目回看、自动续期、CDN 403 自愈。不依赖站点打包模块号，站点改版后仍可用。
// @author           https://github.com/jolin1314joker
// @match            https://live.kankanews.com/*
// @match            http://live.kankanews.com/*
// @icon             https://live.kankanews.com/favicon.ico
// @grant            none
// @run-at           document-start
// @compatible       chrome
// @compatible       edge
// @compatible       firefox
// @compatible       safari
// ==/UserScript==

(function () {
    'use strict';

    /* =========================================================================
     * 0. 配置
     * ====================================================================== */

    var SMG_VERSION = '1.0.0';
    var SMG_API_ORIGIN = 'https://kapi.kankanews.com';
    // 站点签名密钥与频道地址的 RSA 公钥。两者都是服务端与网页共享的常量，
    // 不随前端打包模块号变化；只有服务端主动轮换时才需要更新。
    var SMG_API_SECRET = '28c8edde3d61a0411511d3b1866f0636';
    var SMG_PUBKEY = '-----BEGIN PUBLIC KEY-----\n' +
        'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI\n' +
        'Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt\n' +
        'wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E\n' +
        'tSqSgXDcJ7yDj5rc7wIDAQAB\n' +
        '-----END PUBLIC KEY-----';
    // CDN 只认版本声明 >= 2.45.0 的流 token；实际上限跟随站点自身构建版本。
    var SMG_MIN_API_VERSION = '2.45.0';
    var SMG_TOKEN_REFRESH_MARGIN = 120 * 1000;   // 提前 2 分钟续期
    var SMG_TICK = 15000;                        // 播放看门狗周期
    var SMG_SCAN_DAYS = 3;                       // 取地址失败时回退扫描的排期天数

    var _smgTokenCache = {};      // channelId -> 直播 token
    var _smgTokenRequests = {};   // channelId -> [callback]
    var _smgReplayCache = {};     // channelId:programId -> 回看地址
    var _smgReplayRequests = {};  // channelId:programId -> [callback]
    var _smgUuidRotations = 0;
    var _smgApiVersion = '';

    /* =========================================================================
     * 1. 日志
     * ====================================================================== */

    var SMG_DEBUG = (function () {
        try {
            return localStorage.getItem('smg_debug') === '1' ||
                /[?&]smg_debug=1/.test(location.search);
        } catch (e) { return false; }
    })();

    function smgDebug() {
        if (!SMG_DEBUG) return;
        try { console.log.apply(console, ['[SMGTV]'].concat([].slice.call(arguments))); } catch (e) {}
    }
    function smgInfo() {
        try { console.log.apply(console, ['[SMGTV]'].concat([].slice.call(arguments))); } catch (e) {}
    }
    function smgWarn() {
        try { console.warn.apply(console, ['[SMGTV]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    /* =========================================================================
     * 2. 样式：隐藏版权遮罩 / 试看提示
     * ====================================================================== */

    var smgStyle = document.createElement('style');
    smgStyle.textContent =
        '.image-mask{display:none!important}' +
        '.video-tip{display:none!important}' +
        '.copyright-mask{display:none!important}';

    function smgInjectStyle() {
        var root = document.head || document.documentElement;
        if (!root) {
            document.addEventListener('DOMContentLoaded', smgInjectStyle, { once: true });
            return false;
        }
        if (!smgStyle.parentNode) root.appendChild(smgStyle);
        return true;
    }
    smgInjectStyle();

    /* =========================================================================
     * 3. 基础工具
     * ====================================================================== */

    function smgGet(obj, path) {
        var cur = obj;
        var parts = String(path).split('.');
        for (var i = 0; i < parts.length; i++) {
            if (cur == null) return undefined;
            cur = cur[parts[i]];
        }
        return cur;
    }

    function smgVersionParts(v) {
        return String(v || '0').split('.').map(function (p) { return parseInt(p, 10) || 0; });
    }
    function smgVersionGte(a, b) {
        var pa = smgVersionParts(a);
        var pb = smgVersionParts(b);
        for (var i = 0; i < 3; i++) {
            if ((pa[i] || 0) > (pb[i] || 0)) return true;
            if ((pa[i] || 0) < (pb[i] || 0)) return false;
        }
        return true;
    }

    // 站点每次发版都会把版本号编译进 runtime.vX.Y.Z.js。跟着站点走，
    // 就不会出现“脚本里写死 2.45.2、站点升到 2.50 后 CDN 全部 403”的问题。
    function smgDetectAppVersion() {
        try {
            var nuxt = window.__NUXT__;
            var candidates = [
                smgGet(nuxt, 'app.version'),
                smgGet(nuxt, 'version'),
                smgGet(nuxt, 'config.version')
            ];
            for (var i = 0; i < candidates.length; i++) {
                if (candidates[i] && /^\d+\.\d+\.\d+$/.test(candidates[i])) return candidates[i];
            }
            var scripts = document.querySelectorAll('script[src]');
            for (var j = 0; j < scripts.length; j++) {
                var m = String(scripts[j].src).match(/\.v(\d+\.\d+\.\d+)\.js/);
                if (m) return m[1];
            }
            var html = document.documentElement ? document.documentElement.innerHTML : '';
            var m2 = html.match(/\/_knews_nuxt\/js\/[^"']*?v(\d+\.\d+\.\d+)\.js/);
            if (m2) return m2[1];
        } catch (e) {}
        return '';
    }

    function smgApiVersion(force) {
        var override = '';
        try { override = localStorage.getItem('smg_version') || ''; } catch (e) {}
        if (/^\d+\.\d+\.\d+$/.test(override)) return override;
        if (_smgApiVersion && !force) return _smgApiVersion;

        var detected = smgDetectAppVersion();
        if (detected && smgVersionGte(detected, SMG_MIN_API_VERSION)) {
            _smgApiVersion = detected;
        } else {
            if (detected) {
                smgWarn('站点版本 ' + detected + ' 低于 CDN 最低要求 ' + SMG_MIN_API_VERSION + '，按最低版本请求');
            }
            _smgApiVersion = SMG_MIN_API_VERSION;
            // 版本没探到（document-start 阶段 DOM 还不全）时不写死，
            // 下次调用重新探测，避免站点升级后一直用落后的版本号。
            if (!detected) _smgApiVersion = '';
        }
        smgDebug('API version =', _smgApiVersion || SMG_MIN_API_VERSION, '(detected:', detected || 'none', ')');
        return _smgApiVersion || SMG_MIN_API_VERSION;
    }

    /* =========================================================================
     * 4. 设备 ID（M-Uuid）
     * ====================================================================== */

    function smgNewUuid() {
        var alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
        var bytes = new Uint8Array(21);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(bytes);
        } else {
            for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        var out = '';
        for (var j = 0; j < bytes.length; j++) out += alphabet[bytes[j] % 64];
        return out;
    }

    function smgEnsureUuid() {
        try {
            var uuid = localStorage.getItem('uuid');
            if (!uuid) {
                uuid = smgNewUuid();
                localStorage.setItem('uuid', uuid);
                smgInfo('生成设备 ID', uuid);
            }
            return uuid;
        } catch (e) {
            return '';
        }
    }

    // 服务端按 M-Uuid 缓存流 token：某个 uuid 一旦拿过旧版本 token，之后
    // 即使按新版本请求也会一直返回旧 token。换 uuid 是唯一解法。
    function smgRotateUuid() {
        try {
            var uuid = smgNewUuid();
            localStorage.setItem('uuid', uuid);
            _smgUuidRotations++;
            smgWarn('轮换设备 ID（第 ' + _smgUuidRotations + ' 次）->', uuid);
            Object.keys(_smgTokenCache).forEach(function (k) { delete _smgTokenCache[k]; });
            Object.keys(_smgReplayCache).forEach(function (k) { delete _smgReplayCache[k]; });
            return uuid;
        } catch (e) {
            return '';
        }
    }

    /* =========================================================================
     * 5. MD5（站点签名用：md5(md5(sortedQuery + secret))）
     * ====================================================================== */

    function smgMd5(input) {
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
            var mask = (1 << 8) - 1;
            for (var i = 0; i < s.length * 8; i += 8) {
                b[i >> 5] |= (s.charCodeAt(i / 8) & mask) << (i % 32);
            }
            return b;
        }
        function binl2hex(b) {
            var hex = '0123456789abcdef';
            var s = '';
            for (var i = 0; i < b.length * 4; i++) {
                s += hex.charAt((b[i >> 2] >> ((i % 4) * 8 + 4)) & 0xf) +
                    hex.charAt((b[i >> 2] >> ((i % 4) * 8)) & 0xf);
            }
            return s;
        }

        var str = unescape(encodeURIComponent(String(input)));
        var x = binl(str);
        x[str.length >> 2] |= 0x80 << ((str.length % 4) << 3);
        x[(((str.length + 8) >> 6) << 4) + 14] = str.length * 8;
        var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
        for (var i = 0; i < x.length; i += 16) {
            var oa = a, ob = b, oc = c, od = d;
            a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
            c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
            a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
            c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
            a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
            c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
            a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
            c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
            a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
            c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
            a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
            c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
            a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
            c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
            a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
            c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
            a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
            c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
            a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
            c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
            a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
            c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
            a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
            c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
            a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
            c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
            a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
            c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
            a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
            c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
            a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
            c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
            a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
        }
        return binl2hex([a, b, c, d]);
    }

    /* =========================================================================
     * 6. RSA：站点下发的频道地址是 1024-bit 公钥加密的分块密文
     *    这里用 BigInt 自己实现 PKCS#1 v1.5 解块，不再依赖页面的 JSEncrypt
     *    全局变量，也不依赖任何 webpack 模块号。
     * ====================================================================== */

    var _smgRsaKey = null;

    function smgRsaKey() {
        if (_smgRsaKey) return _smgRsaKey;
        var b64 = String(SMG_PUBKEY).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var pos = 0;

        // 读一个 DER TLV，返回 {tag, start, end}（start/end 为内容区间）
        function readTlv() {
            var tag = bytes[pos++];
            var len = bytes[pos++];
            if (len & 0x80) {
                var count = len & 0x7f;
                len = 0;
                for (var k = 0; k < count; k++) len = (len << 8) | bytes[pos++];
            }
            var start = pos;
            pos += len;
            return { tag: tag, start: start, end: start + len };
        }
        function readBigInt(tlv) {
            if (tlv.tag !== 0x02) throw new Error('RSA 公钥解析失败：期望 INTEGER');
            var hex = '';
            for (var j = tlv.start; j < tlv.end; j++) hex += ('0' + bytes[j].toString(16)).slice(-2);
            return BigInt('0x' + hex);
        }

        // SubjectPublicKeyInfo:
        //   SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { INTEGER n, INTEGER e } } }
        var outer = readTlv();
        if (outer.tag !== 0x30) throw new Error('RSA 公钥不是 DER 序列');
        pos = outer.start;
        var algorithm = readTlv();
        if (algorithm.tag !== 0x30) throw new Error('RSA 公钥缺少算法标识');
        var bitString = readTlv();
        if (bitString.tag !== 0x03) throw new Error('RSA 公钥缺少 BIT STRING');
        pos = bitString.start + 1;                     // 跳过 unused-bits 计数
        var inner = readTlv();
        if (inner.tag !== 0x30) throw new Error('RSA 公钥缺少 RSAPublicKey');
        pos = inner.start;
        var n = readBigInt(readTlv());
        var e = readBigInt(readTlv());
        _smgRsaKey = { n: n, e: e };
        return _smgRsaKey;
    }

    function smgModPow(base, exp, mod) {
        var result = BigInt(1);
        var b = base % mod;
        var ee = exp;
        while (ee > BigInt(0)) {
            if (ee & BigInt(1)) result = (result * b) % mod;
            b = (b * b) % mod;
            ee >>= BigInt(1);
        }
        return result;
    }

    function smgUtf8(bytes) {
        if (typeof TextDecoder === 'function') {
            try { return new TextDecoder('utf-8').decode(bytes); } catch (e) {}
        }
        var out = '';
        for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        try { return decodeURIComponent(escape(out)); } catch (e2) { return out; }
    }

    function smgRsaDecrypt(enc) {
        try {
            if (!enc || typeof enc !== 'string') return '';
            var key = smgRsaKey();
            var raw = atob(enc.replace(/\s+/g, ''));
            var bytes = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            var blockSize = 128;                       // 1024-bit
            var out = '';
            for (var off = 0; off + blockSize <= bytes.length; off += blockSize) {
                var c = BigInt(0);
                for (var j = 0; j < blockSize; j++) c = (c << BigInt(8)) | BigInt(bytes[off + j]);
                var m = smgModPow(c, key.e, key.n);
                var hex = m.toString(16);
                if (hex.length % 2) hex = '0' + hex;
                var dec = new Uint8Array(hex.length / 2);
                for (var k = 0; k < dec.length; k++) dec[k] = parseInt(hex.substr(k * 2, 2), 16);
                var p = 0;
                while (p < dec.length && dec[p] === 0) p++;
                // 站点用公钥做模幂，密文块其实是 PKCS#1 签名填充（0x01），
                // 少数通道用加密填充（0x02）。两种都按“填充到 0x00 为止”处理。
                if (dec[p] !== 0x01 && dec[p] !== 0x02) continue;
                p++;
                while (p < dec.length && dec[p] !== 0) p++;
                if (p >= dec.length) continue;
                p++;
                out += smgUtf8(dec.subarray(p));
            }
            return out;
        } catch (e) {
            smgWarn('地址解密失败：', e && e.message);
            return '';
        }
    }

    /* =========================================================================
     * 7. API 客户端（签名放 header，与站点 axios 拦截器一致）
     * ====================================================================== */

    var origFetch = window.fetch ? window.fetch.bind(window) : null;

    function smgSignParams(params) {
        var base = {
            platform: 'pc',
            version: smgApiVersion(),
            nonce: Math.random().toString(36).slice(-8),
            timestamp: Math.floor(Date.now() / 1000),
            'Api-Version': 'v1'
        };
        var merged = {};
        var key;
        for (key in (params || {})) merged[key] = params[key];
        for (key in base) merged[key] = base[key];
        var keys = Object.keys(merged).sort();
        var str = '';
        for (var i = 0; i < keys.length; i++) {
            if (merged[keys[i]] != null) str += keys[i] + '=' + merged[keys[i]] + '&';
        }
        merged.sign = smgMd5(smgMd5(str + SMG_API_SECRET));
        return merged;
    }

    function smgApiGet(path, params) {
        var clean = params || {};
        var signed = smgSignParams(clean);
        var query = Object.keys(clean).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(clean[k]);
        }).join('&');
        var headers = { Accept: 'application/json, text/plain, */*' };
        Object.keys(signed).forEach(function (k) { headers[k] = String(signed[k]); });
        headers['M-Uuid'] = smgEnsureUuid();
        var url = SMG_API_ORIGIN + path + (query ? '?' + query : '');
        smgDebug('GET', path, clean);

        return new Promise(function (resolve, reject) {
            if (!origFetch) { reject(new Error('fetch unavailable')); return; }
            var controller = typeof AbortController === 'function' ? new AbortController() : null;
            var timer = setTimeout(function () {
                reject(new Error('API request timed out'));
                if (controller) { try { controller.abort(); } catch (e) {} }
            }, 15000);
            var options = { headers: headers, cache: 'no-store', credentials: 'omit' };
            if (controller) options.signal = controller.signal;
            Promise.resolve()
                .then(function () { return origFetch(url, options); })
                .then(function (resp) {
                    if (!resp.ok) throw new Error('API HTTP ' + resp.status);
                    return resp.json();
                })
                .then(function (data) {
                    clearTimeout(timer);
                    resolve(data);
                }, function (error) {
                    clearTimeout(timer);
                    reject(error);
                });
        });
    }

    /* =========================================================================
     * 8. 流地址解析
     *    volc-stream : /live/<stream>/index.m3u8?token=&volcSecret=&volcTime=
     *    tencent     : /live/<stream>.m3u8?token=&txSecret=&txTime=(hex)
     *    ws-channels : /live/<stream>/playlist.m3u8?token=&wsSecret=&wsTime=
     *    回看地址    : .../timeshift.m3u8?t=(hex)&sign=&starttime=&endtime=
     *                  .../live-<stream>.m3u8?wsSecret=&wsTime=&wsStart=&wsEnd=
     * ====================================================================== */

    function smgJwtPayload(token) {
        try {
            var part = String(token).split('.')[1];
            if (!part) return {};
            var b64 = part.replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            return JSON.parse(atob(b64)) || {};
        } catch (e) {
            return {};
        }
    }

    function smgTokenVersion(t) {
        return (t && t.version) || '';
    }

    function smgTokenFromUrl(url) {
        if (!url || typeof url !== 'string') return null;
        var u;
        try { u = new URL(url); } catch (e) { return null; }
        var q = u.searchParams;
        var token = q.get('token') || '';
        var pathMatch = u.pathname.match(/\/live\/([^/]+)\//) ||
            u.pathname.match(/\/live\/([^/]+)\.m3u8$/) ||
            u.pathname.match(/\/live-([^/]+)\.m3u8$/);
        var stream = pathMatch ? pathMatch[1] : '';
        var dir = u.origin + (stream ? '/live/' + stream + '/' : u.pathname.replace(/[^/]*$/, ''));

        var family = '';
        var secretParam = '';
        var secret = '';
        var timeParam = '';
        var timeRaw = '';
        var volcTime = 0;
        var exp = 0;
        var version = '';

        if (token) {
            var payload = smgJwtPayload(token);
            exp = Number(payload.exp) || 0;
            version = payload.version || '';
            stream = stream || payload.stream_name || '';
            if (q.get('volcSecret')) {
                family = 'volc'; secretParam = 'volcSecret'; timeParam = 'volcTime';
            } else if (q.get('txSecret')) {
                family = 'tencent'; secretParam = 'txSecret'; timeParam = 'txTime';
            } else if (q.get('wsSecret')) {
                family = 'ws'; secretParam = 'wsSecret'; timeParam = 'wsTime';
            } else {
                family = 'token';
            }
        } else if (q.get('sign') && q.get('t')) {
            family = 'tencent-vod'; secretParam = 'sign'; timeParam = 't';
        } else if (q.get('wsSecret')) {
            family = 'ws-vod'; secretParam = 'wsSecret'; timeParam = 'wsTime';
        } else {
            return null;
        }

        secret = q.get(secretParam) || '';
        timeRaw = q.get(timeParam) || '';
        if (timeRaw) {
            // 腾讯云系列（直播 txTime、回看 t）用 16 进制秒；火山云/网宿用十进制。
            var hexTime = (family === 'tencent' || family === 'tencent-vod');
            volcTime = hexTime ? parseInt(timeRaw, 16) : Number(timeRaw);
            if (!isFinite(volcTime)) volcTime = 0;
        }

        return {
            url: url,
            family: family,
            token: token,
            secretParam: secretParam,
            secret: secret,
            timeParam: timeParam,
            timeRaw: timeRaw,
            volcTime: volcTime,
            stream: stream,
            origin: u.origin,
            dir: dir,
            exp: exp,
            version: version
        };
    }

    function smgTokenExpiresAt(t) {
        if (!t) return 0;
        var cdnExp = Number(t.volcTime);
        if (!isFinite(cdnExp) || cdnExp <= 0) return 0;
        var jwtExp = Number(t.exp);
        // 回看地址（timeshift 系列）没有 JWT，只有 CDN 签名有效期。
        if (!isFinite(jwtExp) || jwtExp <= 0) return cdnExp * 1000;
        return Math.min(jwtExp, cdnExp) * 1000;
    }
    function smgTokenMsLeft(t) {
        var at = smgTokenExpiresAt(t);
        return at ? at - Date.now() : 0;
    }
    function smgTokenValid(t) {
        return smgTokenMsLeft(t) > SMG_TOKEN_REFRESH_MARGIN;
    }

    /* =========================================================================
     * 9. 播放地址构造
     * ====================================================================== */

    function smgBuildLiveUrl(t) {
        if (!t) return null;
        var base = (t.dir || (t.origin + '/live/' + t.stream + '/'));
        var url = base + 'index.m3u8?token=' + t.token +
            '&' + t.secretParam + '=' + t.secret +
            '&' + t.timeParam + '=' + t.timeRaw;
        return url;
    }

    // 直播优先用 API 原样下发的地址：不同频道分属 volc / tencent / ws 三套 CDN，
    // 路径形态各不相同，原样使用最稳。
    function smgPreferredLiveUrl(t) {
        if (!t) return null;
        return t.url || smgBuildLiveUrl(t);
    }

    // 回放：火山云支持任意 start/end 时间窗（保留 6 天）；
    // 腾讯云/网宿回看用 starttime/endtime、wsStart/wsEnd（2026 年时的格式）。
    function smgBuildShiftUrl(t, startTime, endTime) {
        if (!t) return null;
        var start = Math.floor(Number(startTime));
        if (!isFinite(start) || start <= 0) return null;
        var end = Number(endTime) > 0 ? Math.floor(Number(endTime)) : start + 7200;
        if (end <= start) end = start + 7200;
        var base = (t.dir || (t.origin + '/live/' + t.stream + '/'));
        return base + 'index.m3u8?token=' + t.token +
            '&' + t.secretParam + '=' + t.secret +
            '&' + t.timeParam + '=' + t.timeRaw +
            '&start=' + start + '&end=' + end;
    }

    function smgStampShanghai(seconds) {
        var d = new Date((Number(seconds) + 8 * 3600) * 1000);
        function p(n) { return ('0' + n).slice(-2); }
        return '' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
            p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
    }

    function smgRetimeUrl(url, startTime, endTime) {
        if (!url) return null;
        var u;
        try { u = new URL(url); } catch (e) { return null; }
        var start = Math.floor(Number(startTime));
        if (!isFinite(start) || start <= 0) return null;
        var end = Math.floor(Number(endTime));
        if (!isFinite(end) || end <= start) end = start + 7200;
        var q = u.searchParams;
        if (q.has('starttime') || q.has('endtime')) {
            q.set('starttime', smgStampShanghai(start));
            q.set('endtime', smgStampShanghai(end));
        } else if (q.has('wsStart') || q.has('wsEnd')) {
            q.set('wsStart', smgStampShanghai(start));
            q.set('wsEnd', smgStampShanghai(end));
        } else {
            q.set('start', String(start));
            q.set('end', String(end));
        }
        return u.toString();
    }

    /* =========================================================================
     * 10. Vue 定位
     * ====================================================================== */

    function smgFindComponent(root, name) {
        if (!root) return null;
        if (root.$options && root.$options.name === name) return root;
        var children = root.$children || [];
        for (var i = 0; i < children.length; i++) {
            var found = smgFindComponent(children[i], name);
            if (found) return found;
        }
        return null;
    }

    function smgIsPlayerComponent(vue) {
        return !!(vue && typeof vue.initPlayer === 'function' && vue.programObj);
    }

    function findVue() {
        var el = document.querySelector('.huikan');
        if (el && smgIsPlayerComponent(el.__vue__)) return el.__vue__;

        var nuxt = document.querySelector('#__nuxt');
        if (nuxt && nuxt.__vue__) {
            var comp = smgFindComponent(nuxt.__vue__, 'HuikanIndex');
            if (smgIsPlayerComponent(comp)) return comp;
        }

        var candidates = document.querySelectorAll('[class*=huikan],[id*=huikan],.live-player,.video-wrap');
        for (var i = 0; i < candidates.length; i++) {
            if (smgIsPlayerComponent(candidates[i].__vue__)) return candidates[i].__vue__;
        }

        var all = document.querySelectorAll('*');
        for (var j = 0; j < all.length && j < 800; j++) {
            var v = all[j].__vue__;
            if (smgIsPlayerComponent(v)) return v;
            if (v && v.$children) {
                var nested = smgFindComponent(v, 'HuikanIndex');
                if (smgIsPlayerComponent(nested)) return nested;
            }
        }
        return null;
    }

    function getCurChannelId(vue) {
        try {
            // 页面内换台（changeChannel）不会改 URL，排期项本身也不带 channel_id，
            // 所以 vue 上的 currChannel / currChannelDetail 优先于 URL 查询参数。
            if (vue) {
                if (vue.currChannel && vue.currChannel.id != null) return String(vue.currChannel.id);
                if (vue.currChannelDetail && vue.currChannelDetail.id != null) return String(vue.currChannelDetail.id);
                if (vue.programObj && vue.programObj.channel_id != null) return String(vue.programObj.channel_id);
            }
            var qId = new URLSearchParams(location.search).get('id');
            if (qId) return String(qId);
            var m = location.pathname.match(/\/huikan\/(\d+)/);
            if (m) return String(m[1]);
            if (vue && smgGet(vue, 'programDetail.channel_info.id')) {
                return String(smgGet(vue, 'programDetail.channel_info.id'));
            }
        } catch (e) {}
        return '10';
    }

    /* =========================================================================
     * 11. 直播 token 获取
     * ====================================================================== */

    function smgTokenUsable(t) {
        if (!t) return false;
        var v = smgTokenVersion(t);
        if (!v) return true;              // 非 JWT（回看地址）：不做版本判断
        return smgVersionGte(v, SMG_MIN_API_VERSION);
    }

    function smgDateStr(offsetDays) {
        var d = new Date(Date.now() - offsetDays * 86400000);
        function p(n) { return ('0' + n).slice(-2); }
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    function smgPickLiveAddress(info) {
        if (!info) return '';
        return info.live_address || info.touping_address || info.shift_address || '';
    }

    function smgEnsureToken(vue, cb, forceRefresh) {
        var chId = getCurChannelId(vue);
        if (_smgTokenRequests[chId]) {
            _smgTokenRequests[chId].push(cb);
            return;
        }
        var cached = _smgTokenCache[chId];
        if (!forceRefresh && smgTokenValid(cached)) {
            cb(cached);
            return;
        }
        _smgTokenRequests[chId] = [cb];

        var finished = false;
        var queue = [];
        var tried = {};
        var scanDay = 0;

        function finish(token) {
            if (finished) return;
            finished = true;
            var callbacks = _smgTokenRequests[chId] || [];
            delete _smgTokenRequests[chId];
            callbacks.forEach(function (fn) {
                try { fn(token); } catch (e) { smgWarn('token 回调异常：', e && e.message); }
            });
        }

        function pushProgram(id) {
            var num = Number(id);
            if (!num || tried[num]) return;
            tried[num] = true;
            queue.push({ type: 'program', id: num });
        }

        function resetQueue() {
            queue = [];
            tried = {};
            scanDay = 0;
            if (vue && vue.programObj && vue.programObj.id) pushProgram(vue.programObj.id);
            queue.push({ type: 'channel' });
        }

        function accept(plain, source) {
            var t = smgTokenFromUrl(plain);
            if (!t) { smgDebug(source + ': 地址无法解析'); return false; }
            if (!smgTokenValid(t)) { smgDebug(source + ': 地址已过期'); return false; }
            if (!smgTokenUsable(t)) {
                if (_smgUuidRotations < 3) {
                    smgWarn('拿到旧版本 token（' + smgTokenVersion(t) + '），换设备 ID 重试');
                    smgRotateUuid();
                    resetQueue();
                    pump();
                    return true;    // 已接管流程
                }
                smgWarn('换设备 ID 后仍是旧版本 token，跳过该地址');
                return false;
            }
            _smgTokenCache[chId] = t;
            finish(t);
            return true;
        }

        function pump() {
            if (finished) return;
            if (!queue.length) {
                if (scanDay < SMG_SCAN_DAYS) {
                    var date = smgDateStr(scanDay++);
                    smgApiGet('/content/pc/tv/programs', { channel_id: chId, date: date })
                        .then(function (data) {
                            var list = smgGet(data, 'result.programs') || [];
                            list.forEach(function (p) {
                                if (p && p.id && (p.is_review === 1 || p.can_review === 1)) pushProgram(p.id);
                            });
                            pump();
                        })
                        .catch(function (e) {
                            smgDebug('排期扫描失败', date, e && e.message);
                            pump();
                        });
                    return;
                }
                smgWarn('频道 ' + chId + ' 没有可用地址');
                finish(null);
                return;
            }
            var step = queue.shift();
            if (step.type === 'channel') {
                smgApiGet('/content/app/tv/channel/detail', { channel_id: chId })
                    .then(function (data) {
                        var info = smgGet(data, 'result') || {};
                        var enc = smgPickLiveAddress(info);
                        if (!enc) { smgDebug('channel/detail 未下发地址'); pump(); return; }
                        if (!accept(smgRsaDecrypt(enc), 'channel/detail')) pump();
                    })
                    .catch(function (e) { smgDebug('channel/detail 失败', e && e.message); pump(); });
                return;
            }
            smgApiGet('/content/app/tv/program/detail', { channel_program_id: step.id })
                .then(function (data) {
                    var info = smgGet(data, 'result.channel_info') || {};
                    var enc = smgPickLiveAddress(info);
                    if (!enc) { pump(); return; }
                    if (!accept(smgRsaDecrypt(enc), 'program/detail#' + step.id)) pump();
                })
                .catch(function (e) { smgDebug('program/detail 失败', e && e.message); pump(); });
        }

        resetQueue();
        pump();
    }

    /* =========================================================================
     * 12. 回看地址获取
     * ====================================================================== */

    function smgEnsureReplaySource(vue, program, cb, forceRefresh) {
        var chId = getCurChannelId(vue);
        var key = chId + ':' + (program && program.id);
        var cached = _smgReplayCache[key];
        if (!forceRefresh && cached && smgTokenValid(cached)) { cb(cached); return; }
        if (_smgReplayRequests[key]) { _smgReplayRequests[key].push(cb); return; }
        _smgReplayRequests[key] = [cb];

        var finished = false;
        function finish(src) {
            if (finished) return;
            finished = true;
            var callbacks = _smgReplayRequests[key] || [];
            delete _smgReplayRequests[key];
            callbacks.forEach(function (fn) {
                try { fn(src); } catch (e) { smgWarn('回看回调异常：', e && e.message); }
            });
        }

        function fromLiveToken() {
            // 有些频道（魔都眼、新纪实）没有排期数据，但直播 token 支持
            // 直接拼 start/end 时间窗，火山云频道可以这样回看。
            smgEnsureToken(vue, function (t) {
                if (!t || t.family !== 'volc') { finish(null); return; }
                var url = smgBuildShiftUrl(t, program.start_time, program.end_time);
                var src = url ? smgTokenFromUrl(url) : null;
                if (src) { src.url = url; _smgReplayCache[key] = src; }
                finish(src);
            }, true);
        }

        smgApiGet('/content/app/tv/program/detail', { channel_program_id: program.id })
            .then(function (data) {
                var info = smgGet(data, 'result.channel_info') || {};
                var enc = info.shift_address || info.touping_shift_address || '';
                var src = enc ? smgTokenFromUrl(smgRsaDecrypt(enc)) : null;
                if (src && smgTokenValid(src)) {
                    _smgReplayCache[key] = src;
                    finish(src);
                    return;
                }
                fromLiveToken();
            })
            .catch(function (e) {
                smgDebug('回看地址失败', e && e.message);
                fromLiveToken();
            });
    }

    /* =========================================================================
     * 13. 播放看门狗：token 到期前续期，卡死/报错自动换源
     * ====================================================================== */

    var _smgWatchdogCleanup = null;

    function smgStartPlaybackWatchdog(vue, player, switchSource, options) {
        smgStopPlaybackWatchdog();
        var opts = options || {};
        var channelId = getCurChannelId(vue);
        var activeToken = opts.initial || _smgTokenCache[channelId];
        var renew = opts.renew || function (done) { smgEnsureToken(vue, done, true); };
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
            smgWarn('续期失败，' + Math.round((retryAt - Date.now()) / 1000) + 's 后重试：', error && error.message);
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
            smgDebug('续期频道', channelId, '剩余', Math.round(smgTokenMsLeft(activeToken) / 1000), 's');
            renew(function (t) {
                if (!isCurrent()) return;
                if (!t) { failed(new Error('no usable playback credentials')); return; }
                Promise.resolve()
                    .then(function () { if (isCurrent()) return switchSource(t); })
                    .then(function () {
                        if (!isCurrent()) return;
                        if (generation !== errorGeneration) {
                            failed(new Error('playback error during source switch'));
                            return;
                        }
                        activeToken = t;
                        refreshing = false;
                        needsRecovery = false;
                        failures = 0;
                        retryAt = Date.now() + 15000;
                        lastPosition = Number(player.currentTime) || 0;
                        lastProgressAt = Date.now();
                        if (!resume) player.pause();
                        else if (player.paused) {
                            try {
                                Promise.resolve(player.play()).catch(function (e) {
                                    smgDebug('play() 被拒绝', e && e.message);
                                });
                            } catch (e) { smgDebug('play() 失败', e && e.message); }
                        }
                        smgInfo('已续期，到期时间', new Date(smgTokenExpiresAt(t)).toLocaleString());
                    })
                    .catch(failed);
            });
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
            if (typeof player.off === 'function') player.off('error', onError);
            if (player.video && player.video.removeEventListener) {
                player.video.removeEventListener('error', onError);
            }
        }
        var timer = setInterval(tick, SMG_TICK);
        if (typeof player.on === 'function') player.on('error', onError);
        if (player.video && player.video.addEventListener) player.video.addEventListener('error', onError);
        _smgWatchdogCleanup = cleanup;
    }

    function smgStopPlaybackWatchdog() {
        if (_smgWatchdogCleanup) {
            _smgWatchdogCleanup();
            _smgWatchdogCleanup = null;
        }
    }

    /* =========================================================================
     * 14. 接管 initPlayer
     * ====================================================================== */

    function smgPlayerElement(vue) {
        return (vue.$refs && (vue.$refs.livePlayer || vue.$refs.playerBox || vue.$refs.player)) ||
            document.querySelector('#livePlayer') || null;
    }

    function smgBuildPlayer(vue, url, isLive, programStart, programEnd, title) {
        if (!vue || !url) return null;
        if (typeof vue.destroyPlayer === 'function') vue.destroyPlayer();
        var volume = 0.5;
        try {
            var saved = localStorage.getItem('playerVolume');
            if (saved) volume = Number(saved) || 0.5;
        } catch (e) {}

        var player = new vue.$xgplayer({
            el: smgPlayerElement(vue),
            url: url,
            isLive: !!isLive,
            fluid: true,
            crossOrigin: true,
            controls: true,
            volume: volume,
            playbackRate: [2, 1.5, 1.25, 1, 0.75, 0.5],
            ignores: ['cssFullscreen'],
            keyShortcut: true,
            lang: 'zh-cn',
            closeVideoClick: true,
            plugins: vue.$hlsPlayer ? [vue.$hlsPlayer] : []
        });
        vue.player = player;
        try { player.muted = !!vue.isMuted; } catch (e) {}

        if (player.on) {
            player.on('canplay', function () {
                vue.isLoading = false;
                if (!isLive && player.video && typeof Event === 'function') {
                    try { player.video.dispatchEvent(new Event('loadedmetadata')); } catch (e) {}
                }
            });
            player.on('ended', function () {
                if (!isLive && vue.programObj && vue.programObj.play === 0 &&
                    typeof vue.playNextProgram === 'function') {
                    vue.playNextProgram();
                }
            });
        }
        setTimeout(function () {
            if (vue.player === player) {
                try { Promise.resolve(player.play()).catch(function () {}); } catch (e) {}
            }
        }, 200);
        if (player.video && player.video.addEventListener) {
            player.video.addEventListener('click', function () {
                if (!vue.player) return;
                if (vue.player.paused) vue.player.play(); else vue.player.pause();
            });
        }
        smgInfo('播放器已接管：', title || '', isLive ? '直播' : '回看');
        return player;
    }

    function patchInitPlayer(vue) {
        if (!vue || typeof vue.initPlayer !== 'function' || vue.__smgInitPatched) return;
        var origInitPlayer = vue.initPlayer;

        vue.initPlayer = function () {
            var pObj = vue.programObj;
            if (!pObj || !pObj.start_time) return origInitPlayer.apply(this, arguments);

            var channelId = getCurChannelId(vue);
            var requestKey = channelId + ':' + pObj.id + ':' + pObj.play;
            if (vue.__smgInitKey === requestKey) return;
            vue.__smgInitKey = requestKey;

            var generation = (vue.__smgInitGen || 0) + 1;
            vue.__smgInitGen = generation;
            var self = this;
            var args = arguments;
            var isLive = pObj.play !== 0;
            var programStart = isLive ? Math.floor(Date.now() / 1000) : Number(pObj.start_time);
            var programEnd = Number(pObj.end_time) || 0;
            if (!programEnd || programEnd <= programStart) programEnd = programStart + 7200;

            function current() {
                return !vue._isDestroyed &&
                    vue.__smgInitGen === generation &&
                    vue.player !== null &&
                    getCurChannelId(vue) === channelId &&
                    vue.programObj && String(vue.programObj.id) === String(pObj.id) &&
                    (vue.programObj.play !== 0) === isLive;
            }

            function bail(message) {
                if (message) smgWarn(message);
                vue.__smgInitKey = null;
                return origInitPlayer.apply(self, args);
            }

            if (isLive) {
                smgEnsureToken(vue, function (t) {
                    if (vue.__smgInitGen !== generation || vue._isDestroyed) return;
                    if (!t) { bail('没有可用直播地址，回退站点播放器'); return; }
                    var url = smgPreferredLiveUrl(t);
                    if (!url) { bail('直播地址构造失败'); return; }
                    smgStopPlaybackWatchdog();
                    var player = smgBuildPlayer(vue, url, true, programStart, programEnd, pObj.name);
                    if (!player) { bail('播放器创建失败'); return; }
                    smgStartPlaybackWatchdog(vue, player, function (next) {
                        return player.switchURL(smgPreferredLiveUrl(next), { seamless: false, currentTime: 0 });
                    });
                }, false);
                return;
            }

            smgEnsureReplaySource(vue, pObj, function (src) {
                if (vue.__smgInitGen !== generation || vue._isDestroyed) return;
                if (!src) { bail('没有可用回看地址，回退站点播放器'); return; }
                var sourceUrl = src.url;
                var duration = Math.max(60, programEnd - programStart);
                var virtualPos = 0;
                var virtualTs = Date.now();
                var seeking = false;
                var seekGen = 0;
                var seekTimer = null;
                var switchQueue = Promise.resolve();

                smgStopPlaybackWatchdog();
                var player = smgBuildPlayer(vue, smgRetimeUrl(sourceUrl, programStart, programEnd) || sourceUrl,
                    false, programStart, programEnd, pObj.name);
                if (!player) { bail('播放器创建失败'); return; }

                function clamp(pos) {
                    var n = Number(pos);
                    if (!isFinite(n)) return 0;
                    return Math.max(0, Math.min(duration, n));
                }
                function publish() {
                    try { player.offsetCurrentTime = virtualPos; } catch (e) {}
                }
                try {
                    Object.defineProperty(player, 'offsetCurrentTime', {
                        get: function () { return virtualPos; },
                        set: function () {},
                        configurable: true,
                        enumerable: true
                    });
                } catch (e) { smgDebug('offsetCurrentTime 定义失败', e && e.message); }
                if (player.video) {
                    try {
                        Object.defineProperty(player.video, 'duration', {
                            get: function () { return duration; },
                            configurable: true
                        });
                    } catch (e) {}
                }

                var positionTimer = setInterval(function () {
                    if (vue.player !== player) { clearInterval(positionTimer); return; }
                    if (!player.paused && !seeking) {
                        var now = Date.now();
                        virtualPos = clamp(virtualPos + (now - virtualTs) / 1000);
                        virtualTs = now;
                        publish();
                    } else {
                        virtualTs = Date.now();
                    }
                }, 500);

                player.seek = function (time) {
                    var target = clamp(time);
                    virtualPos = target;
                    virtualTs = Date.now();
                    seeking = true;
                    publish();
                    var myGen = ++seekGen;
                    if (seekTimer) clearTimeout(seekTimer);
                    seekTimer = setTimeout(function () {
                        var at = Math.floor(programStart + virtualPos);
                        switchQueue = switchQueue.catch(function () {}).then(function () {
                            if (myGen !== seekGen || vue.player !== player) return;
                            var url = smgRetimeUrl(sourceUrl, at, programEnd);
                            if (!url || typeof player.switchURL !== 'function') { seeking = false; return; }
                            var wasPaused = player.paused;
                            return Promise.resolve(player.switchURL(url, { seamless: false, currentTime: 0 }))
                                .then(function () {
                                    seeking = false;
                                    virtualTs = Date.now();
                                    publish();
                                    if (wasPaused) player.pause(); else player.play();
                                })
                                .catch(function (e) {
                                    seeking = false;
                                    smgWarn('跳转失败：', e && e.message);
                                });
                        });
                    }, 150);
                };

                smgStartPlaybackWatchdog(vue, player, function (next) {
                    seeking = true;
                    var at = Math.floor(programStart + virtualPos);
                    switchQueue = switchQueue.catch(function () {}).then(function () {
                        if (vue.player !== player) return;
                        var url = smgRetimeUrl(next.url || sourceUrl, at, programEnd);
                        return Promise.resolve(player.switchURL(url, { seamless: false, currentTime: 0 }))
                            .then(function () {
                                seeking = false;
                                virtualTs = Date.now();
                                publish();
                            }, function (e) {
                                seeking = false;
                                throw e;
                            });
                    });
                    return switchQueue;
                }, {
                    initial: src,
                    renew: function (done) { smgEnsureReplaySource(vue, pObj, done, true); }
                });

                publish();
                smgDebug('回看时间窗', programStart, '-', programEnd, '时长', duration, 's');
            }, false);
        };
        vue.__smgInitPatched = true;
        smgDebug('initPlayer 已接管');
    }

    /* =========================================================================
     * 15. 解除页面限制
     * ====================================================================== */

    function smgFixProgram(obj) {
        if (!obj) return;
        obj.is_shield = 0;
        obj.is_review = 1;
        obj.can_review = 1;
        // isOutDate 表示「还没开播」，只对已开始的节目放开，避免把未来节目变成可点。
        if (obj.start_time && Number(obj.start_time) * 1000 <= Date.now()) obj.isOutDate = 0;
    }

    // 站点 changeProgram 有两道门：isOutDate===1 直接 return、can_review===0 且非直播 return。
    // 历史节目正是被第二道挡住，initPlayer 根本不会被调用，所以必须先放开数据。
    // handleProgramList 是站点生成列表的唯一入口，包装它能覆盖每次刷新后的新对象。
    function patchChangeProgram(vue) {
        if (!vue || vue.__smgChangePatched) return;
        if (typeof vue.handleProgramList === 'function') {
            var origList = vue.handleProgramList;
            vue.handleProgramList = function (list) {
                if (Array.isArray(list)) list.forEach(smgFixProgram);
                var result = origList.apply(this, arguments);
                if (Array.isArray(result)) result.forEach(smgFixProgram);
                if (Array.isArray(this.currentProgramList)) this.currentProgramList.forEach(smgFixProgram);
                return result;
            };
        }
        if (typeof vue.changeProgram === 'function') {
            var orig = vue.changeProgram;
            vue.changeProgram = function (item) {
                smgFixProgram(item);
                return orig.apply(this, arguments);
            };
        }
        vue.__smgChangePatched = true;
    }

    // 直接按节目对象启动播放，绕开站点 changeProgram 的全部校验与埋点逻辑。
    function smgPlayProgram(vue, item) {
        if (!vue || !item || !item.id) return false;
        smgFixProgram(item);
        vue.programObj = item;
        vue.isLoading = true;
        vue.__smgInitKey = null;
        vue.__smgInitGen = (vue.__smgInitGen || 0) + 1;
        if (typeof vue.getProgramDetail === 'function') {
            try { Promise.resolve(vue.getProgramDetail()).catch(function () {}); } catch (e) {}
        }
        try { vue.initPlayer(); } catch (e) { smgWarn('回看启动失败：', e && e.message); return false; }
        if (typeof vue.$forceUpdate === 'function') vue.$forceUpdate();
        return true;
    }

    // 兜底：站点若改名 changeProgram，仍能从 DOM 点击直接接管受限节目。
    function smgBindProgramClicks(vue) {
        if (vue.__smgClickBound) return;
        vue.__smgClickBound = true;
        document.addEventListener('click', function (event) {
            var target = event.target;
            if (!target || !target.closest) return;
            var li = target.closest('.program-list li') || target.closest('.program-container li');
            if (!li || !li.parentNode) return;
            var list = vue.currentProgramList;
            if (!Array.isArray(list) || !list.length) return;
            var rows = Array.prototype.filter.call(li.parentNode.children, function (el) {
                return el.tagName === 'LI';
            });
            var item = list[rows.indexOf(li)];
            if (!item || !item.id) return;
            // 站点本来就能播的节目交给它自己处理，只拦截被限制的。
            if (item.play === 1 || (item.can_review !== 0 && item.isOutDate !== 1)) return;
            event.preventDefault();
            event.stopPropagation();
            smgDebug('接管节目点击', item.id, item.name);
            smgPlayProgram(vue, item);
        }, true);
    }

    function tryPatch() {
        var vue = findVue();
        if (!vue) return false;

        patchInitPlayer(vue);
        patchChangeProgram(vue);
        smgBindProgramClicks(vue);

        smgFixProgram(vue.programObj);
        smgFixProgram(vue.programDetail);
        smgFixProgram(vue.playingProgramObj);
        [vue.programList, vue.currentProgramList, vue.playingProgramList].forEach(function (list) {
            if (Array.isArray(list)) list.forEach(smgFixProgram);
        });
        if (vue.currChannelDetail) vue.currChannelDetail.copyright_image = '';
        if (vue.currChannel) vue.currChannel.copyright_image = '';
        // 注意：isCopyright 在站点里是 computed（play/is_shield、play/is_review 组合），
        // 直接赋值无效，正确做法是改 programObj 本身，已由 smgFixProgram 完成。

        if (typeof vue.countdown === 'number') vue.countdown = 99999999;
        vue.showOpenApp = false;
        vue.showFlag = false;
        if (typeof vue.startCountdown === 'function') vue.startCountdown = function () {};
        if (vue.liveTimer) { clearTimeout(vue.liveTimer); vue.liveTimer = null; }

        // 保留可见性监听但清空处理函数：站点原本会在切到后台时暂停播放。
        if (typeof vue.pageVisibilityChange === 'function') {
            document.removeEventListener('visibilitychange', vue.pageVisibilityChange);
            vue.pageVisibilityChange = function () {};
            document.addEventListener('visibilitychange', vue.pageVisibilityChange);
        }

        var now = Date.now();
        if (!vue.player && vue.programObj && vue.programObj.id &&
            (!vue.__smgAutoInitAt || now - vue.__smgAutoInitAt > 10000)) {
            vue.__smgAutoInitAt = now;
            try { vue.initPlayer(); } catch (e) { smgWarn('initPlayer 调用失败：', e && e.message); }
        }

        if (typeof vue.$forceUpdate === 'function') vue.$forceUpdate();
        vue.__smgPatched = true;
        return true;
    }

    /* =========================================================================
     * 16. 启动
     * ====================================================================== */

    if (tryPatch()) {
        smgInfo('已接管当前页面');
    } else {
        var observer = null;
        if (typeof MutationObserver === 'function' && document.documentElement) {
            observer = new MutationObserver(function () {
                if (tryPatch() && observer) observer.disconnect();
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
        var attempts = 0;
        var poll = setInterval(function () {
            attempts++;
            if (tryPatch()) {
                clearInterval(poll);
                if (observer) observer.disconnect();
                smgDebug('轮询 ' + attempts + ' 次后接管成功');
            } else if (attempts >= 120) {
                clearInterval(poll);
                if (observer) observer.disconnect();
                smgWarn('等待播放器组件超时（60s），刷新页面重试');
            }
        }, 500);
    }

    // SPA 路由切换（换频道 / 选节目）后重新打补丁
    var lastHref = location.href;
    setInterval(function () {
        var mask = document.querySelector('.image-mask');
        if (mask && mask.style && mask.style.display !== 'none') mask.style.display = 'none';
        if (location.href !== lastHref) {
            lastHref = location.href;
            setTimeout(tryPatch, 800);
        }
    }, 1000);

    // 便于排查：控制台执行 SMGTV.status() 查看当前状态
    function smgRelaunch() {
        var vue = findVue();
        if (!vue) return false;
        if (vue.player) {
            try { vue.destroyPlayer(); } catch (e) {}
            vue.player = null;
        }
        vue.__smgInitKey = null;
        return tryPatch();
    }

    window.SMGTV = {
        version: SMG_VERSION,
        status: function () {
            var vue = findVue();
            var channelId = vue ? getCurChannelId(vue) : '';
            return {
                version: SMG_VERSION,
                apiVersion: smgApiVersion(),
                uuid: smgEnsureUuid(),
                channel: channelId || null,
                liveToken: channelId ? (_smgTokenCache[channelId] || null) : null,
                replaySources: Object.keys(_smgReplayCache),
                patched: !!(vue && vue.__smgPatched)
            };
        },
        refresh: smgRelaunch
    };

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
