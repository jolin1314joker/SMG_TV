const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'smg_fivestar.user.js'), 'utf8');
const setup = source.slice(0, source.indexOf('\n    if (tryPatch()) {')) + `
    smgRsaDecrypt = function(value) { return value; };
    window.testApi = { smgTokenFromUrl, smgTokenExpiresAt, smgTokenValid,
        smgTokenMsLeft, smgApiGet, smgEnsureToken, smgStartPlaybackWatchdog,
        smgStopPlaybackWatchdog, patchInitPlayer, tryPatch,
        cache: _smgTokenCache, requests: _smgTokenRequests };
})();`;
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    const h = { now: 1789224336000, timers: new Map(), fetches: [], players: [], switches: [], logs: [] };
    let timerId = 0;
    function timer(fn, delay, interval) {
        const id = ++timerId;
        h.timers.set(id, { fn, at: h.now + delay, interval });
        return id;
    }
    h.advance = async function(ms) {
        const end = h.now + ms;
        for (let i = 0; i < 100000; i++) {
            let next;
            for (const entry of h.timers) {
                if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
            }
            if (!next) { h.now = end; await settle(); return; }
            const [id, job] = next;
            h.now = job.at;
            if (job.interval) job.at += job.interval;
            else h.timers.delete(id);
            job.fn();
            await settle();
        }
        throw new Error('Timer loop did not settle');
    };
    h.url = function(overrides = {}) {
        const exp = Math.floor(h.now / 1000) + 43200;
        const volcTime = Math.floor(h.now / 1000) + 600;
        const values = { exp, volcTime, ...overrides };
        const payload = Buffer.from(JSON.stringify({ exp: values.exp })).toString('base64url');
        return 'https://volc-stream.kksmg.com/live/test-stream/index.m3u8?' +
            new URLSearchParams({ token: 'test.' + payload + '.test', volcSecret: 'test-signature', volcTime: values.volcTime });
    };
    h.response = function(url) {
        return { ok: true, status: 200, json: async () => ({ result: url.includes('/program/detail')
            ? { channel_info: { shift_address: h.url() } } : { programs: [] } }) };
    };
    class Player {
        constructor(config = {}) {
            this.config = config;
            this.paused = false;
            this.position = 0;
            this.positionAt = h.now;
            this.events = new Map();
            this.videoEvents = new Map();
            this.video = {
                error: null, ended: false, seeking: false,
                addEventListener: (name, cb) => this.videoEvents.set(name, cb),
                removeEventListener: name => this.videoEvents.delete(name),
                dispatchEvent() {},
            };
            this.plugins = { hls: { hls: { _manifestLoader: { load() {} } } } };
            h.players.push(this);
        }
        get currentTime() { return this.position + (this.paused ? 0 : (h.now - this.positionAt) / 1000); }
        on(name, cb) { this.events.set(name, cb); }
        off(name, cb) { if (this.events.get(name) === cb) this.events.delete(name); }
        emit(name) { this.events.get(name)?.(); }
        play() { this.paused = false; return Promise.resolve(); }
        pause() { this.position = this.currentTime; this.positionAt = h.now; this.paused = true; }
        switchURL(url, options) {
            h.switches.push({ url, options, time: h.now, player: this });
            if (h.switchImpl) return h.switchImpl(url, this);
            this.position = 0;
            this.positionAt = h.now;
            this.video.error = null;
            this.paused = false; // xgplayer HLS switchURL calls media.play().
            return Promise.resolve();
        }
    }
    h.makeVue = function(channelId = '10', replay = false) {
        const start = Math.floor(h.now / 1000) - 3600;
        return {
            programObj: { id: 123, channel_id: channelId, start_time: start, end_time: start + 14400, play: replay ? 0 : 1 },
            programList: [], currentProgramList: [], playingProgramList: [],
            $refs: { livePlayer: {} }, $xgplayer: Player, $hlsPlayer: {},
            initPlayer() { h.originalInits = (h.originalInits || 0) + 1; },
            destroyPlayer() { this.player = null; }, $forceUpdate() {},
        };
    };
    h.vue = h.makeVue();
    const log = (...args) => h.logs.push(args.join(' '));
    const ctx = {
        URL, URLSearchParams, Promise, AbortController, Event,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        Date: class extends Date {
            constructor(...args) { super(...(args.length ? args : [h.now])); }
            static now() { return h.now; }
        },
        console: { log, warn: log, error: log },
        location: { href: 'https://live.kankanews.com/huikan?id=10', search: '?id=10', pathname: '/huikan' },
        navigator: { userAgent: 'test' },
        localStorage: { getItem() { return ''; } },
        document: {
            head: { appendChild() {} }, createElement() { return {}; },
            querySelector(selector) { return selector === '.huikan' ? { __vue__: h.vue } : null; },
            querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {},
        },
        XMLHttpRequest: function() {}, webpackJsonp: [],
        setTimeout: (fn, ms) => timer(fn, ms, 0), clearTimeout: id => h.timers.delete(id),
        setInterval: (fn, ms) => timer(fn, ms, ms), clearInterval: id => h.timers.delete(id),
        fetch: (url, options) => {
            h.fetches.push({ url, options });
            return h.fetchImpl ? h.fetchImpl(url, options) : Promise.resolve(h.response(url));
        },
    };
    ctx.XMLHttpRequest.prototype.open = function() {};
    ctx.window = ctx;
    h.context = vm.createContext(ctx);
    vm.runInContext(setup, h.context);
    h.api = h.context.testApi;
    h.Player = Player;
    h.start = function() {
        const player = new Player();
        h.vue.player = player;
        h.api.cache['10'] = h.api.smgTokenFromUrl(h.url());
        h.api.smgStartPlaybackWatchdog(h.vue, player, t => player.switchURL(
            'https://example.invalid/test.m3u8?volcTime=' + t.volcTime, { currentTime: 0 }));
        return player;
    };
    return h;
}

test('earliest expiry wins, including the observed 12-hour JWT / 10-minute CDN URL', () => {
    const h = harness();
    const t = h.api.smgTokenFromUrl(h.url({ exp: 1789267529, volcTime: 1789224936 }));
    assert.equal(h.api.smgTokenExpiresAt(t), 1789224936000);
    assert.equal(h.api.smgTokenValid(t), true);
    h.now = 1789224816000;
    assert.equal(h.api.smgTokenValid(t), false, 'renew at the 120-second boundary');
    h.now = 1789224937000;
    assert.equal(h.api.smgTokenMsLeft(t), -1000);
    assert.equal(h.api.smgTokenValid(t), false);
    assert.equal(h.api.smgTokenExpiresAt({ ...t, exp: 1789224500 }), 1789224500000);
    for (const volcTime of [null, '', 'not-a-time', 'Infinity', '0']) {
        assert.equal(h.api.smgTokenValid({ ...t, volcTime }), false);
    }
});

test('35 minutes of live playback renews before every CDN expiry', async () => {
    const h = harness();
    const player = h.start();
    let deadline = h.now + 600000;
    await h.advance(35 * 60000);
    assert.equal(h.switches.length, 4);
    for (const entry of h.switches) {
        assert.ok(entry.time <= deadline - 120000, 'renewal must precede CDN expiry');
        deadline = Number(new URL(entry.url).searchParams.get('volcTime')) * 1000;
    }
    assert.equal(h.vue.player, player);
    assert.equal(h.fetches.length, 4);
});

test('concurrent token requests share one network request and invalid donors are rejected', async () => {
    const h = harness();
    const received = [];
    h.api.smgEnsureToken(h.vue, t => received.push(t));
    h.api.smgEnsureToken(h.vue, t => received.push(t));
    await settle();
    assert.equal(h.fetches.length, 1);
    assert.equal(received.length, 2);
    assert.equal(received[0], received[1]);
    assert.equal(Object.keys(h.api.requests).length, 0);
    h.fetchImpl = async url => ({ ok: true, status: 200, json: async () => ({ result:
        url.includes('/program/detail') ? { channel_info: { shift_address: h.url({ volcTime: 1 }) } } : { programs: [] } }) });
    let result;
    h.api.smgEnsureToken(h.vue, t => { result = t; }, true);
    await settle();
    assert.equal(result, null);
    assert.equal(Object.keys(h.api.requests).length, 0);
});

test('API requests bypass the script interceptor, reject HTTP errors, and time out', async () => {
    const h = harness();
    h.context.fetch = () => { throw new Error('Must not use intercepted fetch'); };
    await h.api.smgApiGet('/content/pc/tv/program/detail', { channel_program_id: 123 });
    assert.equal(h.fetches[0].options.cache, 'no-store');
    h.fetchImpl = async () => ({ ok: false, status: 403 });
    await assert.rejects(h.api.smgApiGet('/test', {}), /API HTTP 403/);
    h.fetchImpl = () => new Promise(() => {});
    const pending = assert.rejects(h.api.smgApiGet('/test', {}), /timed out/);
    await settle();
    const request = h.fetches.at(-1);
    await h.advance(15000);
    await pending;
    assert.equal(request.options.signal.aborted, true);
});

test('network media errors and HLS player errors trigger fresh credentials', async () => {
    for (const kind of ['media', 'hls']) {
        const h = harness();
        const player = h.start();
        if (kind === 'media') {
            player.video.error = { code: 2 };
            await h.advance(15000);
        } else {
            player.emit('error');
            await settle();
        }
        assert.equal(h.fetches.length, 1, kind);
        assert.equal(h.switches.length, 1, kind);
    }
});

test('failed source switches retry despite the newly cached token, with bounded request frequency', async () => {
    const h = harness();
    h.start();
    h.switchImpl = () => Promise.reject(new Error('network failure'));
    await h.advance(480000);
    assert.equal(h.switches.length, 1);
    await h.advance(15000);
    assert.equal(h.switches.length, 2);
    await h.advance(15000);
    assert.equal(h.switches.length, 2, 'backoff prevents a retry on every tick');
    h.switchImpl = null;
    await h.advance(15000);
    assert.equal(h.switches.length, 3);
    assert.equal(h.fetches.length, 3);
});

test('pending source switches cannot overlap', async () => {
    const h = harness();
    h.start();
    let complete;
    h.switchImpl = () => new Promise(resolve => { complete = resolve; });
    await h.advance(480000);
    await h.advance(60000);
    assert.equal(h.switches.length, 1);
    complete();
    await settle();
    await h.advance(15000);
    assert.equal(h.switches.length, 1);
});

test('switching channel cancels stale renewal callbacks and removes old listeners', async () => {
    const h = harness();
    const player = h.start();
    let complete;
    h.fetchImpl = url => new Promise(resolve => { complete = () => resolve(h.response(url)); });
    await h.advance(480000);
    h.vue.programObj.channel_id = '1';
    await h.advance(15000);
    complete();
    await settle();
    assert.equal(h.switches.length, 0);
    assert.equal(player.events.has('error'), false);
    assert.equal(player.videoEvents.has('error'), false);
});

test('repeated init calls create only one player and new Vue components get their own wrapper', async () => {
    const h = harness();
    h.api.patchInitPlayer(h.vue);
    for (let i = 0; i < 10; i++) h.vue.initPlayer();
    await settle();
    assert.equal(h.fetches.length, 1);
    assert.equal(h.players.length, 1);
    const second = h.makeVue();
    const original = second.initPlayer;
    h.api.patchInitPlayer(second);
    assert.notEqual(second.initPlayer, original);
});

test('replay renewal preserves the absolute playback position', async () => {
    const h = harness();
    h.vue = h.makeVue('10', true);
    const programStart = h.vue.programObj.start_time;
    h.api.patchInitPlayer(h.vue);
    h.vue.initPlayer();
    await settle();
    await h.advance(485000);
    assert.equal(h.switches.length, 1);
    const start = Number(new URL(h.switches[0].url).searchParams.get('startTime'));
    assert.ok(start >= programStart + 478 && start <= programStart + 481);
    assert.ok(h.vue.player.offsetCurrentTime > 480, 'renewal must not reset replay to the beginning');
});

test('an intentionally paused player stays paused through scheduled renewal', async () => {
    const h = harness();
    const player = h.start();
    player.pause();
    await h.advance(485000);
    assert.equal(h.switches.length, 1);
    assert.equal(player.paused, true);
});
