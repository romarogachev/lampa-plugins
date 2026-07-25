/**
 * ============================================================
 *  Kino.pub Token Keeper for Lampa + online_mod
 *  Version: 2.5.0 (чистая блокировка рекламы, без логов)
 * ============================================================
 */

(function () {
    'use strict';

    var CONFIG = {
        key_access:  'pub_access_token',
        key_refresh: 'pub_refresh_token',
        key_expire:  'pub_expire_time',
        key_logined: 'logined_pub',

        backup_access:  'kp_backup_access',
        backup_refresh: 'kp_backup_refresh',
        backup_expire:  'kp_backup_expire',

        oauth_url:     'https://api.srvkp.com/oauth2/token',
        client_id:     'xbmc',
        client_secret: 'cgg3gtifu46urtfp2zp1nqtba0k2ezxh',

        refresh_threshold_sec: 600,
        check_interval_ms:     60000
    };

    // ============================================================
    //  НЕМЕДЛЕННОЕ ВЫПОЛНЕНИЕ — до загрузки Lampa
    // ============================================================
    (function immediateRestore() {

        // 1. Отключаем рекламу Modss
        localStorage.setItem('showModssVip', 'true');

        // 2. Блокируем рекламные WebSocket
        var AD_WS = ['kurwa-bober.ninja', 'nackhui.com'];
        var OrigWS = window.WebSocket;
        window.WebSocket = function(url, protocols) {
            var isAd = AD_WS.some(function(d) { return url.indexOf(d) !== -1; });
            if (isAd) {
                return { send:function(){}, close:function(){}, addEventListener:function(){}, removeEventListener:function(){}, readyState:3 };
            }
            return protocols ? new OrigWS(url, protocols) : new OrigWS(url);
        };
        window.WebSocket.prototype = OrigWS.prototype;

        // 3. Блокируем рекламные HTTP запросы (Яндекс AdFox + BetweenDigital)
        var AD_HTTP = ['yandex.ru/ads', 'adfox', 'betweendigital.com', 'ads.between'];

        var origFetch = window.fetch;
        window.fetch = function(url) {
            var u = typeof url === 'string' ? url : (url && url.url) || '';
            var isAd = AD_HTTP.some(function(d) { return u.indexOf(d) !== -1; });
            if (isAd) {
                return Promise.resolve(new Response('{}', { status: 200 }));
            }
            return origFetch.apply(this, arguments);
        };

        var origXHROpen = XMLHttpRequest.prototype.open;
        var origXHRSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
            this._adUrl = url || '';
            return origXHROpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(body) {
            var url = this._adUrl || '';
            var isAd = AD_HTTP.some(function(d) { return url.indexOf(d) !== -1; });
            if (isAd) {
                var self = this;
                try {
                    Object.defineProperty(self, 'readyState',   { get: function(){ return 4; }, configurable: true });
                    Object.defineProperty(self, 'status',       { get: function(){ return 200; }, configurable: true });
                    Object.defineProperty(self, 'responseText', { get: function(){ return '{"ads":[],"items":[]}'; }, configurable: true });
                    Object.defineProperty(self, 'response',     { get: function(){ return '{"ads":[],"items":[]}'; }, configurable: true });
                } catch(e) {}
                setTimeout(function() {
                    try { if (typeof self.onreadystatechange === 'function') self.onreadystatechange(); } catch(e) {}
                    try { if (typeof self.onload === 'function') self.onload(); } catch(e) {}
                    try { self.dispatchEvent(new Event('load')); } catch(e) {}
                    try { self.dispatchEvent(new Event('loadend')); } catch(e) {}
                }, 0);
                return;
            }
            return origXHRSend.apply(this, arguments);
        };

        // 4. Скрываем рекламные элементы через CSS + лёгкий observer
        (function hideAdElements() {
            // CSS — мгновенно скрывает элементы по классу
            function injectCss() {
                var s = document.createElement('style');
                s.textContent = '.ad-preroll,.ad-video-block{display:none!important}';
                (document.head || document.documentElement).appendChild(s);
            }
            if (document.head) { injectCss(); }
            else { document.addEventListener('DOMContentLoaded', injectCss); }

            // Observer — страховка на случай если CSS не успел
            var obs = new MutationObserver(function(muts) {
                muts.forEach(function(m) {
                    m.addedNodes.forEach(function(n) {
                        if (n.nodeType !== 1) return;
                        var cls = typeof n.className === 'string' ? n.className : '';
                        if (cls.indexOf('ad-preroll') !== -1 || cls.indexOf('ad-video-block') !== -1) {
                            n.style.display = 'none';
                        }
                    });
                });
            });
            setTimeout(function() {
                if (document.body) obs.observe(document.body, { childList: true });
            }, 1000);
        })();

        // 5. Восстановление токенов из резерва если localStorage пуст
        (function restoreTokens() {
            if (localStorage.getItem(CONFIG.key_access)) return;

            var access  = localStorage.getItem(CONFIG.backup_access)  || '';
            var refresh = localStorage.getItem(CONFIG.backup_refresh) || '';
            var expire  = localStorage.getItem(CONFIG.backup_expire)  || '0';

            if (!access || !refresh) return;

            localStorage.setItem(CONFIG.key_access,  access);
            localStorage.setItem(CONFIG.key_refresh, refresh);
            localStorage.setItem(CONFIG.key_expire,  expire);
            localStorage.setItem(CONFIG.key_logined, 'true');
            console.log('[KP Keeper] Токены восстановлены из резерва');
        })();

    })();

    // ============================================================
    //  ХРАНИЛИЩЕ
    // ============================================================
    var TokenStore = {
        isAuthorized: function () { return !!localStorage.getItem(CONFIG.key_access); },
        getAccess:    function () { return localStorage.getItem(CONFIG.key_access)  || ''; },
        getRefresh:   function () { return localStorage.getItem(CONFIG.key_refresh) || ''; },
        getExpireTime: function () { return parseInt(localStorage.getItem(CONFIG.key_expire) || '0', 10); },

        saveTokens: function (access, refresh, expiresIn) {
            var expireAt = Math.floor(Date.now() / 1000) + (expiresIn || 86400);
            localStorage.setItem(CONFIG.key_access,  access);
            localStorage.setItem(CONFIG.key_refresh, refresh);
            localStorage.setItem(CONFIG.key_expire,  expireAt);
            localStorage.setItem(CONFIG.key_logined, 'true');
            localStorage.setItem(CONFIG.backup_access,  access);
            localStorage.setItem(CONFIG.backup_refresh, refresh);
            localStorage.setItem(CONFIG.backup_expire,  expireAt);
            try {
                Lampa.Storage.set(CONFIG.backup_access,  access);
                Lampa.Storage.set(CONFIG.backup_refresh, refresh);
                Lampa.Storage.set(CONFIG.backup_expire,  expireAt);
            } catch (e) {}
        },

        secondsLeft: function () {
            var expireAt = this.getExpireTime();
            if (!expireAt) return 9999;
            return expireAt - Math.floor(Date.now() / 1000);
        },

        needsRefresh: function () { return this.secondsLeft() < CONFIG.refresh_threshold_sec; },

        initExpireIfMissing: function () {
            if (!localStorage.getItem(CONFIG.key_expire) && this.isAuthorized()) {
                var expireAt = Math.floor(Date.now() / 1000) + 86400;
                localStorage.setItem(CONFIG.key_expire,    expireAt);
                localStorage.setItem(CONFIG.backup_expire, expireAt);
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
                    try { onSuccess(JSON.parse(xhr.responseText)); }
                    catch (e) { onError(0, 'JSON parse error'); }
                } else { onError(xhr.status, xhr.statusText); }
            };
            xhr.onerror = function () { onError(0, 'Network error'); };
            xhr.send(body);
        }
    };

    // ============================================================
    //  ОБНОВЛЕНИЕ ТОКЕНА
    // ============================================================
    var TokenRefresher = {
        _refreshing: false,

        refresh: function (onSuccess, onFail) {
            if (this._refreshing) return;
            var refreshToken = TokenStore.getRefresh();
            if (!refreshToken) { onFail && onFail('no_refresh_token'); return; }
            this._refreshing = true;
            var self = this;
            Http.post(CONFIG.oauth_url, {
                grant_type:    'refresh_token',
                client_id:     CONFIG.client_id,
                client_secret: CONFIG.client_secret,
                refresh_token: refreshToken
            }, function (resp) {
                self._refreshing = false;
                if (resp.access_token) {
                    TokenStore.saveTokens(resp.access_token, resp.refresh_token || refreshToken, resp.expires_in || 86400);
                    console.log('[KP Keeper] Токен обновлён');
                    onSuccess && onSuccess(resp);
                } else { onFail && onFail('empty_response'); }
            }, function (status) {
                self._refreshing = false;
                if (status === 401 || status === 400) {
                    localStorage.removeItem(CONFIG.backup_access);
                    localStorage.removeItem(CONFIG.backup_refresh);
                    localStorage.removeItem(CONFIG.backup_expire);
                    try {
                        Lampa.Storage.set(CONFIG.backup_access, '');
                        Lampa.Storage.set(CONFIG.backup_refresh, '');
                        Lampa.Storage.set(CONFIG.backup_expire, 0);
                    } catch(e) {}
                    Lampa.Noty.show('Kino.pub: сессия истекла — войдите через Modss → Online → KinoPub');
                }
                onFail && onFail(status);
            });
        },

        checkAndRefresh: function () {
            if (!TokenStore.isAuthorized()) return;
            if (TokenStore.needsRefresh()) {
                this.refresh(null, null);
            }
        }
    };

    // ============================================================
    //  WATCHDOG
    // ============================================================
    var Watchdog = {
        _timer: null,
        _lastAccess: '',

        start: function () {
            if (this._timer) return;
            this._lastAccess = TokenStore.getAccess();
            setTimeout(function () { TokenRefresher.checkAndRefresh(); }, 5000);
            this._timer = setInterval(function () {
                var current = TokenStore.getAccess();
                if (current && current !== Watchdog._lastAccess) {
                    Watchdog._lastAccess = current;
                    TokenStore.saveTokens(current, TokenStore.getRefresh(), TokenStore.secondsLeft());
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
                        ? 'Авторизован ✓ — нажмите для принудительного обновления'
                        : 'Не авторизован — войдите через Modss → Online → KinoPub'
                },
                onChange: function () {
                    Lampa.Storage.set('kinopub_keeper_status', false);
                    if (!TokenStore.isAuthorized()) {
                        Lampa.Noty.show('Kino.pub: не авторизован. Войдите через Modss → Online → KinoPub');
                        return;
                    }
                    var left  = TokenStore.secondsLeft();
                    var hours = Math.floor(left / 3600);
                    var mins  = Math.floor((left % 3600) / 60);
                    Lampa.Noty.show('Kino.pub: токен активен ~' + hours + 'ч ' + mins + 'мин, обновляем...');
                    TokenRefresher.refresh(
                        function () { Lampa.Noty.show('Kino.pub: токен обновлён'); },
                        function () { Lampa.Noty.show('Kino.pub: не удалось обновить'); }
                    );
                }
            });
        }
    };

    // ============================================================
    //  ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function initPlugin() {
        if (window._kinopubKeeperInited) return;
        window._kinopubKeeperInited = true;
        if (TokenStore.isAuthorized()) {
            TokenStore.initExpireIfMissing();
            TokenStore.saveTokens(TokenStore.getAccess(), TokenStore.getRefresh(), TokenStore.secondsLeft());
        }
        SettingsUI.init();
        Watchdog.start();
        console.log('[KP Keeper] v2.4.2 инициализирован. Авторизован:', TokenStore.isAuthorized());
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
