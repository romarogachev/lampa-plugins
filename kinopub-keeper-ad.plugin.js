/**
 * Kino.pub Token Keeper + Ad Blocker
 * Version: 2.5.7
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
    //  БЛОКИРОВКА РЕКЛАМЫ — выполняется сразу
    // ============================================================
    (function blockAds() {

        // Modss VIP
        localStorage.setItem('showModssVip', 'true');

        // WebSocket блокировка
        var AD_WS = ['kurwa-bober.ninja', 'nackhui.com'];
        var OrigWS = window.WebSocket;
        window.WebSocket = function (url, protocols) {
            var blocked = false;
            for (var i = 0; i < AD_WS.length; i++) {
                if (url.indexOf(AD_WS[i]) !== -1) { blocked = true; break; }
            }
            if (blocked) {
                return {
                    send: function () {},
                    close: function () {},
                    addEventListener: function () {},
                    removeEventListener: function () {},
                    readyState: 3
                };
            }
            if (protocols) { return new OrigWS(url, protocols); }
            return new OrigWS(url);
        };
        window.WebSocket.prototype = OrigWS.prototype;

        // HTTP блокировка
        var AD_HTTP = ['yandex.ru/ads/adfox', 'ads.betweendigital.com'];

        function isAdUrl(url) {
            for (var i = 0; i < AD_HTTP.length; i++) {
                if (url.indexOf(AD_HTTP[i]) !== -1) { return true; }
            }
            return false;
        }

        var origFetch = window.fetch;
        window.fetch = function (url) {
            var u = typeof url === 'string' ? url : '';
            if (isAdUrl(u)) {
                return Promise.resolve(new Response('{}', { status: 200 }));
            }
            return origFetch.apply(this, arguments);
        };

        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url) {
            this._kpUrl = url || '';
            return origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function (body) {
            var _this = this;
            var _blocked = isAdUrl(_this._kpUrl || '');
            if (_blocked) {
                (function () {
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
                })();
            } else {
                origSend.apply(_this, arguments);
            }
        };

        // CSS скрытие рекламных элементов
        function injectCss() {
            var s = document.createElement('style');
            s.textContent = '.ad-preroll,.ad-video-block{display:none!important;visibility:hidden!important;}';
            var head = document.head || document.documentElement;
            head.appendChild(s);
        }
        if (document.head) {
            injectCss();
        } else {
            document.addEventListener('DOMContentLoaded', injectCss);
        }

        // Observer — удаляем рекламные элементы и сигнализируем о завершении
        var adObs = new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var nodes = muts[i].addedNodes;
                for (var j = 0; j < nodes.length; j++) {
                    var n = nodes[j];
                    if (n.nodeType !== 1) { continue; }
                    var cls = typeof n.className === 'string' ? n.className : '';
                    if (cls.indexOf('ad-preroll') !== -1 || cls.indexOf('ad-video-block') !== -1) {
                        n.style.display = 'none';
                        // Посылаем событие завершения рекламы через Lampa
                        setTimeout(function () {
                            try { window.Lampa && Lampa.Listener && Lampa.Listener.send('preroll:end', {}); } catch (e) {}
                            try { window.Lampa && Lampa.Listener && Lampa.Listener.send('ad:end', {}); } catch (e) {}
                            try { window.Lampa && Lampa.Listener && Lampa.Listener.send('ad:complete', {}); } catch (e) {}
                            try { window.Lampa && Lampa.Listener && Lampa.Listener.send('preroll:complete', {}); } catch (e) {}
                        }, 0);
                        try { if (n.parentNode) { n.parentNode.removeChild(n); } } catch (e) {}
                    }
                }
            }
        });
        setTimeout(function () {
            if (document.body) { adObs.observe(document.body, { childList: true }); }
        }, 500);

    })();

    // ============================================================
    //  ВОССТАНОВЛЕНИЕ ТОКЕНОВ
    // ============================================================
    (function restoreTokens() {
        if (localStorage.getItem(CONFIG.key_access)) { return undefined; }
        var access  = localStorage.getItem(CONFIG.backup_access)  || '';
        var refresh = localStorage.getItem(CONFIG.backup_refresh) || '';
        var expire  = localStorage.getItem(CONFIG.backup_expire)  || '0';
        if (!access || !refresh) { return undefined; }
        localStorage.setItem(CONFIG.key_access,  access);
        localStorage.setItem(CONFIG.key_refresh, refresh);
        localStorage.setItem(CONFIG.key_expire,  expire);
        localStorage.setItem(CONFIG.key_logined, 'true');
        console.log('[KP Keeper] Токены восстановлены');
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
            try { Lampa.Storage.set(CONFIG.backup_access,  access);  } catch (e) {}
            try { Lampa.Storage.set(CONFIG.backup_refresh, refresh); } catch (e) {}
            try { Lampa.Storage.set(CONFIG.backup_expire,  expireAt);} catch (e) {}
        },

        secondsLeft: function () {
            var exp = this.getExpireTime();
            if (!exp) { return 9999; }
            return exp - Math.floor(Date.now() / 1000);
        },

        needsRefresh: function () { return this.secondsLeft() < CONFIG.refresh_threshold_sec; },

        initExpireIfMissing: function () {
            if (!localStorage.getItem(CONFIG.key_expire) && this.isAuthorized()) {
                var exp = Math.floor(Date.now() / 1000) + 86400;
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
            if (this._busy) { return undefined; }
            var rt = TokenStore.getRefresh();
            if (!rt) { if (onFail) { onFail('no_rt'); } return undefined; }
            this._busy = true;
            var self = this;
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
        },

        checkAndRefresh: function () {
            if (!TokenStore.isAuthorized()) { return undefined; }
            if (TokenStore.needsRefresh()) { this.refresh(null, null); }
        }
    };

    // ============================================================
    //  WATCHDOG
    // ============================================================
    var Watchdog = {
        _timer: null,
        _last:  '',

        start: function () {
            if (this._timer) { return undefined; }
            this._last = TokenStore.getAccess();
            setTimeout(function () { TokenRefresher.checkAndRefresh(); }, 5000);
            this._timer = setInterval(function () {
                var cur = TokenStore.getAccess();
                if (cur && cur !== Watchdog._last) {
                    Watchdog._last = cur;
                    TokenStore.saveTokens(cur, TokenStore.getRefresh(), TokenStore.secondsLeft());
                }
                TokenRefresher.checkAndRefresh();
            }, CONFIG.check_interval_ms);
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
                    Lampa.Storage.set('kinopub_keeper_status', false);
                    if (!TokenStore.isAuthorized()) {
                        Lampa.Noty.show('Kino.pub: не авторизован');
                        return undefined;
                    }
                    var left  = TokenStore.secondsLeft();
                    var hours = Math.floor(left / 3600);
                    var mins  = Math.floor((left % 3600) / 60);
                    Lampa.Noty.show('Kino.pub: ~' + hours + 'ч ' + mins + 'мин, обновляем...');
                    TokenRefresher.refresh(
                        function () { Lampa.Noty.show('Kino.pub: токен обновлён'); },
                        function () { Lampa.Noty.show('Kino.pub: ошибка обновления'); }
                    );
                }
            });
        }
    };

    // ============================================================
    //  ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function initPlugin() {
        if (window._kinopubKeeperInited) { return undefined; }
        window._kinopubKeeperInited = true;

        if (TokenStore.isAuthorized()) {
            TokenStore.initExpireIfMissing();
            TokenStore.saveTokens(TokenStore.getAccess(), TokenStore.getRefresh(), TokenStore.secondsLeft());
        }

        SettingsUI.init();
        Watchdog.start();

        // Лог событий Lampa для диагностики
        var evLog = [];
        var evEl  = null;

        function showEvLog() {
            if (!evEl) {
                evEl = document.createElement('div');
                evEl.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99999;background:rgba(0,0,0,0.9);color:#ff0;font-size:11px;padding:8px;max-width:800px;border-radius:6px;pointer-events:none;line-height:1.5;';
                if (document.body) { document.body.appendChild(evEl); }
            }
            if (evEl) { evEl.innerHTML = '<b>Events:</b><br>' + evLog.slice(-10).join('<br>'); }
        }

        try {
            var origLSend = Lampa.Listener.send.bind(Lampa.Listener);
            Lampa.Listener.send = function (name, data) {
                var extra = '';
                if (name === 'state:changed' && data) {
                    try { extra = ' > ' + JSON.stringify(data).substring(0, 40); } catch (e) {}
                }
                evLog.push((Date.now() % 100000) + ': ' + name + extra);
                setTimeout(showEvLog, 50);

                // При активности сразу посылаем завершение рекламы
                // чтобы CUB не ждал таймера рекламного блока
                if (name === 'activity') {
                    setTimeout(function () {
                        try { origLSend('preroll:end', {}); } catch (e) {}
                        try { origLSend('ad:end', {}); } catch (e) {}
                        try { origLSend('ad:complete', {}); } catch (e) {}
                        try { origLSend('preroll:complete', {}); } catch (e) {}
                    }, 100);
                }

                return origLSend(name, data);
            };
        } catch (e) {}

        console.log('[KP Keeper] v2.5.2 инициализирован. Авторизован:', TokenStore.isAuthorized());
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
