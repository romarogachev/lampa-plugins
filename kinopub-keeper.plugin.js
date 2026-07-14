/**
 * ============================================================
 *  Kino.pub Token Keeper for Lampa + online_mod
 *  Version: 1.1.0
 *
 *  Следит за токенами online_mod (ключи: pub_access_token,
 *  pub_refresh_token) и автоматически обновляет их до истечения.
 * ============================================================
 */

(function () {
    'use strict';

    var CONFIG = {
        // Реальные ключи которые использует online_mod
        key_access:  'pub_access_token',
        key_refresh: 'pub_refresh_token',
        key_expire:  'pub_expire_time',   // наш ключ для хранения времени истечения
        key_logined: 'logined_pub',

        // API
        oauth_url:     'https://api.srvkp.com/oauth2/token',
        client_id:     'xbmc',
        client_secret: 'cgg3gtifu46urtfp2zp1nqtba0k2ezxh',

        // За сколько секунд до истечения обновлять
        refresh_threshold_sec: 600,

        // Как часто проверять (мс)
        check_interval_ms: 60000
    };

    // ============================================================
    //  ХРАНИЛИЩЕ
    // ============================================================
    var TokenStore = {
        isAuthorized: function () {
            return localStorage.getItem(CONFIG.key_logined) === 'true' &&
                   !!localStorage.getItem(CONFIG.key_access);
        },

        getAccess: function () {
            return localStorage.getItem(CONFIG.key_access) || '';
        },

        getRefresh: function () {
            return localStorage.getItem(CONFIG.key_refresh) || '';
        },

        getExpireTime: function () {
            return parseInt(localStorage.getItem(CONFIG.key_expire) || '0', 10);
        },

        saveTokens: function (access, refresh, expiresIn) {
            localStorage.setItem(CONFIG.key_access,  access);
            localStorage.setItem(CONFIG.key_refresh, refresh);
            var expireAt = Math.floor(Date.now() / 1000) + (expiresIn || 86400);
            localStorage.setItem(CONFIG.key_expire, expireAt);
            // Также обновим в Lampa.Storage чтобы online_mod видел
            Lampa.Storage.set(CONFIG.key_access,  access);
            Lampa.Storage.set(CONFIG.key_refresh, refresh);
        },

        secondsLeft: function () {
            var expireAt = this.getExpireTime();
            if (!expireAt) return 9999; // не знаем — считаем что ок
            return expireAt - Math.floor(Date.now() / 1000);
        },

        needsRefresh: function () {
            return this.secondsLeft() < CONFIG.refresh_threshold_sec;
        },

        // Инициализация: если expire_time ещё не установлен — ставим +24ч
        initExpireIfMissing: function () {
            if (!localStorage.getItem(CONFIG.key_expire) && this.isAuthorized()) {
                var expireAt = Math.floor(Date.now() / 1000) + 86400;
                localStorage.setItem(CONFIG.key_expire, expireAt);
                console.log('[KP Keeper] Установлено время истечения токена (+24ч)');
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
                } else {
                    onError(xhr.status, xhr.statusText);
                }
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
            if (!refreshToken) {
                console.log('[KP Keeper] Нет refresh_token');
                onFail && onFail('no_refresh_token');
                return;
            }

            this._refreshing = true;
            var self = this;
            console.log('[KP Keeper] Обновляем токен...');

            Http.post(
                CONFIG.oauth_url,
                {
                    grant_type:    'refresh_token',
                    client_id:     CONFIG.client_id,
                    client_secret: CONFIG.client_secret,
                    refresh_token: refreshToken
                },
                function (resp) {
                    self._refreshing = false;
                    if (resp.access_token) {
                        TokenStore.saveTokens(
                            resp.access_token,
                            resp.refresh_token || refreshToken,
                            resp.expires_in
                        );
                        console.log('[KP Keeper] Токен обновлён! Истекает через', resp.expires_in, 'сек');
                        onSuccess && onSuccess(resp);
                    } else {
                        console.log('[KP Keeper] Ответ без access_token');
                        onFail && onFail('empty_response');
                    }
                },
                function (status, text) {
                    self._refreshing = false;
                    console.log('[KP Keeper] Ошибка обновления:', status, text);
                    if (status === 401 || status === 400) {
                        Lampa.Noty.show('Kino.pub: сессия истекла — войдите снова через Modss → Online → KinoPub');
                    }
                    onFail && onFail(status);
                }
            );
        },

        checkAndRefresh: function () {
            if (!TokenStore.isAuthorized()) {
                console.log('[KP Keeper] Не авторизован, пропускаем');
                return;
            }

            var left = TokenStore.secondsLeft();
            console.log('[KP Keeper] Проверка. Осталось секунд:', left);

            if (TokenStore.needsRefresh()) {
                console.log('[KP Keeper] Пора обновить токен');
                this.refresh(
                    function () { console.log('[KP Keeper] Фоновое обновление OK'); },
                    function (e) { console.log('[KP Keeper] Фоновое обновление FAIL:', e); }
                );
            }
        }
    };

    // ============================================================
    //  WATCHDOG
    // ============================================================
    var Watchdog = {
        _timer: null,

        start: function () {
            if (this._timer) return;
            setTimeout(function () {
                TokenRefresher.checkAndRefresh();
            }, 5000);
            this._timer = setInterval(function () {
                TokenRefresher.checkAndRefresh();
            }, CONFIG.check_interval_ms);
            console.log('[KP Keeper] Watchdog запущен');
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
                param: {
                    name:    'kinopub_keeper_status',
                    type:    'trigger',
                    default: false
                },
                field: {
                    name:        'Статус',
                    description: TokenStore.isAuthorized()
                        ? 'Авторизован ✓ — нажмите для обновления токена'
                        : 'Не авторизован — войдите через Modss → Online → KinoPub'
                },
                onChange: function () {
                    Lampa.Storage.set('kinopub_keeper_status', false);

                    if (!TokenStore.isAuthorized()) {
                        Lampa.Noty.show('Kino.pub: не авторизован. Войдите через Modss → Online → KinoPub');
                        return;
                    }

                    var left = TokenStore.secondsLeft();
                    var hours = Math.floor(left / 3600);
                    var mins  = Math.floor((left % 3600) / 60);

                    Lampa.Noty.show('Kino.pub: токен активен, ~' + hours + 'ч ' + mins + 'мин до истечения');

                    TokenRefresher.refresh(
                        function () { Lampa.Noty.show('Kino.pub: токен успешно обновлён'); },
                        function () { Lampa.Noty.show('Kino.pub: не удалось обновить токен'); }
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

        TokenStore.initExpireIfMissing();
        SettingsUI.init();
        Watchdog.start();

        console.log('[KP Keeper] Инициализирован. Авторизован:', TokenStore.isAuthorized());
        if (TokenStore.isAuthorized()) {
            console.log('[KP Keeper] access_token:', TokenStore.getAccess().substring(0, 20) + '...');
            console.log('[KP Keeper] Секунд до истечения:', TokenStore.secondsLeft());
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
