/**
 * Kino.pub Token Keeper + Ad Blocker
 * Version: 3.5.0
 *
 * Что делает:
 * - Блокирует запросы рекламы CUB (/api/ad/get/preroll и /banner)
 * - Блокирует рекламу Яндекс AdFox и BetweenDigital
 * - Рекламное видео (если всё же загрузилось): глушит звук и мгновенно
 *   доматывает до конца, чтобы CUB сразу запускал фильм
 * - Скрывает рекламные элементы (.ad-preroll, .ad-video-block)
 * - Устанавливает VIP флаг Modss
 * - Хранит токены KinoPub в резерве и восстанавливает после выключения TV
 * - Автообновляет токен за 10 минут до истечения
 */

(function () {
    'use strict';

    var CONFIG = {
        key_access:     'pub_access_token',
        key_refresh:    'pub_refresh_token',
        key_expire:     'pub_expire_time',
        key_logined:    'logined_pub',
        backup_access:  'kp_backup_access',
        backup_refresh: 'kp_backup_refresh',
        backup_expire:  'kp_backup_expire',
        oauth_url:      'https://api.srvkp.com/oauth2/token',
        client_id:      'xbmc',
        client_secret:  'cgg3gtifu46urtfp2zp1nqtba0k2ezxh',
        refresh_threshold_sec: 600,
        check_interval_ms:     60000
    };

    // ============================================================
    //  БЛОКИРОВКА РЕКЛАМЫ
    // ============================================================
    (function blockAds() {
        var i, AD_WS, AD_HTTP, OrigWS, origFetch, origOpen, origSend;

        localStorage.setItem('showModssVip', 'true');

        // WebSocket
        AD_WS = ['kurwa-bober.ninja', 'nackhui.com'];
        OrigWS = window.WebSocket;
        window.WebSocket = function (url, protocols) {
            var blocked = false;
            for (i = 0; i < AD_WS.length; i++) {
                if (url.indexOf(AD_WS[i]) !== -1) { blocked = true; }
            }
            if (blocked) {
                return { send:function(){}, close:function(){}, addEventListener:function(){}, removeEventListener:function(){}, readyState:3 };
            }
            if (protocols) { return new OrigWS(url, protocols); }
            return new OrigWS(url);
        };
        window.WebSocket.prototype = OrigWS.prototype;

        // HTTP
        AD_HTTP = ['yandex.ru/ads/adfox', 'ads.betweendigital.com'];


        function isAd(url) {
            var k, found = false;
            for (k = 0; k < AD_HTTP.length; k++) {
                if (url && url.indexOf(AD_HTTP[k]) !== -1) { found = true; }
            }
            return found;
        }

        // Запросы рекламы к самому CUB (домен меняется: cub.rip, cub.best...)
        // Отвечаем сетевой ошибкой — CUB считает, что рекламы нет
        var AD_ERR = ['/api/ad/get/'];
        function isAdErr(url) {
            var k, found = false;
            for (k = 0; k < AD_ERR.length; k++) {
                if (url && String(url).indexOf(AD_ERR[k]) !== -1) { found = true; }
            }
            return found;
        }

        origFetch = window.fetch;
        window.fetch = function (url) {
            var u = typeof url === 'string' ? url : (url && url.url ? url.url : '');
            if (isAdErr(u)) {
                return Promise.reject(new TypeError('Failed to fetch'));
            }
            if (isAd(u)) {
                return Promise.resolve(new Response('{}', { status: 200 }));
            }
            return origFetch.apply(this, arguments);
        };

        origOpen = XMLHttpRequest.prototype.open;
        origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url) {
            this._kpUrl = url || '';
            origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function (body) {
            var _this = this;
            if (isAdErr(_this._kpUrl || '')) {
                try { Object.defineProperty(_this, 'readyState', { get: function () { return 4; }, configurable: true }); } catch (e) {}
                try { Object.defineProperty(_this, 'status',     { get: function () { return 0; }, configurable: true }); } catch (e) {}
                setTimeout(function () {
                    try { if (typeof _this.onerror === 'function') { _this.onerror(); } } catch (e) {}
                    try { _this.dispatchEvent(new Event('error')); } catch (e) {}
                    try { _this.dispatchEvent(new Event('loadend')); } catch (e) {}
                }, 0);
            } else if (isAd(_this._kpUrl || '')) {
                try { Object.defineProperty(_this, 'readyState',   { get: function () { return 4; }, configurable: true }); } catch (e) {}
                try { Object.defineProperty(_this, 'status',       { get: function () { return 200; }, configurable: true }); } catch (e) {}
                try { Object.defineProperty(_this, 'responseText', { get: function () { return '{}'; }, configurable: true }); } catch (e) {}
                try { Object.defineProperty(_this, 'response',     { get: function () { return '{}'; }, configurable: true }); } catch (e) {}
                setTimeout(function () {
                    try { if (typeof _this.onreadystatechange === 'function') { _this.onreadystatechange(); } } catch (e) {}
                    try { if (typeof _this.onload === 'function') { _this.onload(); } } catch (e) {}
                    try { _this.dispatchEvent(new Event('load')); } catch (e) {}
                    try { _this.dispatchEvent(new Event('loadend')); } catch (e) {}
                }, 0);
            } else {
                origSend.apply(_this, arguments);
            }
        };

        // CSS — прячем рекламные блоки визуально (НЕ удаляем из DOM)
        function injectCss() {
            var s = document.createElement('style');
            s.textContent = '.ad-preroll,.ad-video-block{display:none!important;visibility:hidden!important;}';
            var head = document.head || document.documentElement;
            head.appendChild(s);
        }
        if (document.head) { injectCss(); }
        else { document.addEventListener('DOMContentLoaded', injectCss); }

        // Рекламное видео: глушим и доматываем до конца,
        // чтобы CUB получил нормальное "ended" и сразу запустил фильм
        function inAdBlock(el) {
            var p = el, found = false, c;
            while (p && !found) {
                c = typeof p.className === 'string' ? p.className : '';
                if (c.indexOf('ad-preroll') !== -1 || c.indexOf('ad-video-block') !== -1) { found = true; }
                p = p.parentNode;
            }
            return found;
        }

        function fireEnded(v) {
            var ev;
            try {
                ev = new Event('ended');
            } catch (e) {
                ev = document.createEvent('Event');
                ev.initEvent('ended', false, false);
            }
            try { v.dispatchEvent(ev); } catch (e) {}
        }

        function seekToEnd(v) {
            if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.3) {
                try { v.currentTime = v.duration - 0.1; } catch (e) {}
            }
        }

        function speedUp(v) {
            var rates = [16, 8, 4, 2], k, ok = false;
            for (k = 0; k < rates.length && !ok; k++) {
                try { v.playbackRate = rates[k]; ok = v.playbackRate === rates[k]; } catch (e) {}
            }
        }

        function clickSkip(v) {
            var box = v.parentNode, c, btns, b;
            while (box && box !== document.body) {
                c = typeof box.className === 'string' ? box.className : '';
                if (c.indexOf('ad-preroll') !== -1) {
                    btns = box.querySelectorAll('[class*="skip"],[class*="close"],[class*="next"]');
                    for (b = 0; b < btns.length; b++) {
                        try { btns[b].click(); } catch (e) {}
                    }
                    box = null;
                } else {
                    box = box.parentNode;
                }
            }
        }

        function finishAd(v) {
            var key = v.currentSrc || v.src || 'ad';
            var ticks = 0, timer;
            try { v.muted = true; v.volume = 0; } catch (e) {}
            if (v._kpDone !== key) {
                v._kpDone = key;
                speedUp(v);
                seekToEnd(v);
                v.addEventListener('loadedmetadata', function () { speedUp(v); seekToEnd(v); });
                v.addEventListener('durationchange', function () { seekToEnd(v); });
                v.addEventListener('ratechange', function () {
                    if (v._kpDone === key && v.playbackRate < 2) { speedUp(v); }
                });
                timer = setInterval(function () {
                    ticks++;
                    if (v._kpDone !== key || v.ended || ticks > 40) {
                        clearInterval(timer);
                    } else {
                        try { v.muted = true; } catch (e) {}
                        speedUp(v);
                        seekToEnd(v);
                        clickSkip(v);
                    }
                }, 250);
                setTimeout(function () {
                    if (v._kpDone === key && !v.ended) {
                        try { v.pause(); } catch (e) {}
                        fireEnded(v);
                    }
                }, 3000);
            }
        }

        function onMedia(e) {
            var t = e.target;
            if (t && t.tagName === 'VIDEO' && inAdBlock(t)) { finishAd(t); }
        }
        document.addEventListener('loadstart', onMedia, true);
        document.addEventListener('play',      onMedia, true);
        document.addEventListener('playing',   onMedia, true);

    })();

    // ============================================================
    //  ВОССТАНОВЛЕНИЕ ТОКЕНОВ
    // ============================================================
    (function restoreTokens() {
        var access, refresh, expire;
        if (!localStorage.getItem(CONFIG.key_access)) {
            access  = localStorage.getItem(CONFIG.backup_access)  || '';
            refresh = localStorage.getItem(CONFIG.backup_refresh) || '';
            expire  = localStorage.getItem(CONFIG.backup_expire)  || '0';
            if (access && refresh) {
                localStorage.setItem(CONFIG.key_access,  access);
                localStorage.setItem(CONFIG.key_refresh, refresh);
                localStorage.setItem(CONFIG.key_expire,  expire);
                localStorage.setItem(CONFIG.key_logined, 'true');
                console.log('[KP Keeper] Токены восстановлены');
            }
        }
    })();

    // ============================================================
    //  ХРАНИЛИЩЕ
    // ============================================================
    var TokenStore = {
        isAuthorized: function () { return !!localStorage.getItem(CONFIG.key_access); },
        getAccess:    function () { return localStorage.getItem(CONFIG.key_access)  || ''; },
        getRefresh:   function () { return localStorage.getItem(CONFIG.key_refresh) || ''; },
        getExpireTime:function () { return parseInt(localStorage.getItem(CONFIG.key_expire) || '0', 10); },

        saveTokens: function (access, refresh, expiresIn) {
            var expireAt = Math.floor(Date.now() / 1000) + (expiresIn || 86400);
            localStorage.setItem(CONFIG.key_access,     access);
            localStorage.setItem(CONFIG.key_refresh,    refresh);
            localStorage.setItem(CONFIG.key_expire,     expireAt);
            localStorage.setItem(CONFIG.key_logined,    'true');
            localStorage.setItem(CONFIG.backup_access,  access);
            localStorage.setItem(CONFIG.backup_refresh, refresh);
            localStorage.setItem(CONFIG.backup_expire,  expireAt);
            try { Lampa.Storage.set(CONFIG.backup_access,  access);   } catch (e) {}
            try { Lampa.Storage.set(CONFIG.backup_refresh, refresh);  } catch (e) {}
            try { Lampa.Storage.set(CONFIG.backup_expire,  expireAt); } catch (e) {}
        },

        secondsLeft: function () {
            var exp = this.getExpireTime();
            var left = exp ? exp - Math.floor(Date.now() / 1000) : 9999;
            return left;
        },

        needsRefresh: function () { return this.secondsLeft() < CONFIG.refresh_threshold_sec; },

        initExpireIfMissing: function () {
            var exp;
            if (!localStorage.getItem(CONFIG.key_expire) && this.isAuthorized()) {
                exp = Math.floor(Date.now() / 1000) + 86400;
                localStorage.setItem(CONFIG.key_expire,    exp);
                localStorage.setItem(CONFIG.backup_expire, exp);
            }
        }
    };

    // ============================================================
    //  HTTP
    // ============================================================
    var Http = {
        post: function (url, params, onSuccess, onError) {
            var body = Object.keys(params)
                .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
                .join('&');
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.setRequestHeader('Accept', 'application/json');
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try { onSuccess(JSON.parse(xhr.responseText)); } catch (e) { onError(0, 'parse'); }
                } else {
                    onError(xhr.status, xhr.statusText);
                }
            };
            xhr.onerror = function () { onError(0, 'network'); };
            xhr.send(body);
        }
    };

    // ============================================================
    //  ОБНОВЛЕНИЕ ТОКЕНА
    // ============================================================
    var TokenRefresher = {
        _busy: false,

        refresh: function (onOk, onFail) {
            var rt, self;
            if (!this._busy) {
                rt = TokenStore.getRefresh();
                if (rt) {
                    this._busy = true;
                    self = this;
                    Http.post(CONFIG.oauth_url, {
                        grant_type:    'refresh_token',
                        client_id:     CONFIG.client_id,
                        client_secret: CONFIG.client_secret,
                        refresh_token: rt
                    }, function (resp) {
                        self._busy = false;
                        if (resp.access_token) {
                            TokenStore.saveTokens(resp.access_token, resp.refresh_token || rt, resp.expires_in || 86400);
                            if (onOk) { onOk(resp); }
                        } else {
                            if (onFail) { onFail('empty'); }
                        }
                    }, function (status) {
                        self._busy = false;
                        if (status === 400 || status === 401) {
                            localStorage.removeItem(CONFIG.backup_access);
                            localStorage.removeItem(CONFIG.backup_refresh);
                            localStorage.removeItem(CONFIG.backup_expire);
                            try { Lampa.Storage.set(CONFIG.backup_access,  ''); } catch (e) {}
                            try { Lampa.Storage.set(CONFIG.backup_refresh, ''); } catch (e) {}
                            try { Lampa.Storage.set(CONFIG.backup_expire,   0); } catch (e) {}
                            Lampa.Noty.show('Kino.pub: сессия истекла — войдите через Modss');
                        }
                        if (onFail) { onFail(status); }
                    });
                } else {
                    if (onFail) { onFail('no_rt'); }
                }
            }
        },

        checkAndRefresh: function () {
            if (TokenStore.isAuthorized() && TokenStore.needsRefresh()) {
                this.refresh(null, null);
            }
        }
    };

    // ============================================================
    //  WATCHDOG
    // ============================================================
    var Watchdog = {
        _timer: null,
        _last:  '',

        start: function () {
            var self = this;
            if (!self._timer) {
                self._last = TokenStore.getAccess();
                setTimeout(function () { TokenRefresher.checkAndRefresh(); }, 5000);
                self._timer = setInterval(function () {
                    var cur = TokenStore.getAccess();
                    if (cur && cur !== self._last) {
                        self._last = cur;
                        TokenStore.saveTokens(cur, TokenStore.getRefresh(), TokenStore.secondsLeft());
                    }
                    TokenRefresher.checkAndRefresh();
                }, CONFIG.check_interval_ms);
            }
        }
    };

    // ============================================================
    //  UI
    // ============================================================
    var SettingsUI = {
        init: function () {
            Lampa.SettingsApi.addComponent({
                component: 'kinopub_keeper',
                name:      'Kino.pub Keeper',
                icon:      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 4l5 2.18V11c0 3.5-2.33 6.79-5 7.93-2.67-1.14-5-4.43-5-7.93V7.18L12 5z"/></svg>'
            });
            Lampa.SettingsApi.addParam({
                component: 'kinopub_keeper',
                param: { name: 'kinopub_keeper_status', type: 'trigger', default: false },
                field: {
                    name:        'Статус',
                    description: TokenStore.isAuthorized()
                        ? 'Авторизован ✓ — нажмите для обновления'
                        : 'Не авторизован — войдите через Modss → Online → KinoPub'
                },
                onChange: function () {
                    var left, hours, mins;
                    Lampa.Storage.set('kinopub_keeper_status', false);
                    if (TokenStore.isAuthorized()) {
                        left  = TokenStore.secondsLeft();
                        hours = Math.floor(left / 3600);
                        mins  = Math.floor((left % 3600) / 60);
                        Lampa.Noty.show('Kino.pub: ~' + hours + 'ч ' + mins + 'мин, обновляем...');
                        TokenRefresher.refresh(
                            function () { Lampa.Noty.show('Kino.pub: токен обновлён'); },
                            function () { Lampa.Noty.show('Kino.pub: ошибка обновления'); }
                        );
                    } else {
                        Lampa.Noty.show('Kino.pub: не авторизован. Войдите через Modss → Online → KinoPub');
                    }
                }
            });
        }
    };

    // ============================================================
    //  ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function initPlugin() {
        if (!window._kinopubKeeperInited) {
            window._kinopubKeeperInited = true;

            if (TokenStore.isAuthorized()) {
                TokenStore.initExpireIfMissing();
                TokenStore.saveTokens(TokenStore.getAccess(), TokenStore.getRefresh(), TokenStore.secondsLeft());
            }

            SettingsUI.init();
            Watchdog.start();

            console.log('[KP Keeper] v3.5.0 инициализирован. Авторизован:', TokenStore.isAuthorized());
        }
    }

    function tryInit() {
        if (window.Lampa && Lampa.Storage && Lampa.Listener && Lampa.SettingsApi && Lampa.Noty) {
            initPlugin();
        } else {
            setTimeout(tryInit, 200);
        }
    }

    tryInit();

})();
