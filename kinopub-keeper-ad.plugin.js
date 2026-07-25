/**
 * ============================================================
 *  Kino.pub Token Keeper for Lampa + online_mod
 *  Version: 2.1.1
 *
 *  Ключевое улучшение: восстановление токенов происходит
 *  НЕМЕДЛЕННО при загрузке скрипта, до инициализации Lampa.
 *  Это гарантирует что online_mod увидит токены при старте.
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
    //  ШАГ 0: НЕМЕДЛЕННОЕ ВОССТАНОВЛЕНИЕ
    //  Выполняется синхронно до любой инициализации Lampa.
    //  online_mod ещё не успел проверить токены — мы уже их восстановили.
    // ============================================================
    (function immediateRestore() {
        // Отключаем рекламу Modss
        localStorage.setItem('showModssVip', 'true');
        console.log('[KP Keeper] VIP флаг установлен, реклама отключена');

        var hasToken = !!localStorage.getItem(CONFIG.key_access);
        if (hasToken) {
            console.log('[KP Keeper] Токен в localStorage есть, восстановление не нужно');
            return;
        }

        // localStorage пуст — пробуем восстановить из резерва напрямую
        // Lampa ещё не загружена, поэтому читаем из localStorage напрямую
        var access  = localStorage.getItem(CONFIG.backup_access)  || '';
        var refresh = localStorage.getItem(CONFIG.backup_refresh) || '';
        var expire  = localStorage.getItem(CONFIG.backup_expire)  || '0';

        if (!access || !refresh) {
            console.log('[KP Keeper] Резерв пуст, восстановление невозможно');
            return;
        }

        localStorage.setItem(CONFIG.key_access,  access);
        localStorage.setItem(CONFIG.key_refresh, refresh);
        localStorage.setItem(CONFIG.key_expire,  expire);
        localStorage.setItem(CONFIG.key_logined, 'true');

        console.log('[KP Keeper] НЕМЕДЛЕННОЕ восстановление токенов выполнено!');
        console.log('[KP Keeper] access_token:', access.substring(0, 20) + '...');
    })();

    // ============================================================
    //  ХРАНИЛИЩЕ
    // ============================================================
    var TokenStore = {
        isAuthorized: function () {
            return !!localStorage.getItem(CONFIG.key_access);
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

        // Сохранить токены в localStorage И продублировать в резерв
        saveTokens: function (access, refresh, expiresIn) {
            var expireAt = Math.floor(Date.now() / 1000) + (expiresIn || 86400);

            // localStorage — для online_mod
            localStorage.setItem(CONFIG.key_access,  access);
            localStorage.setItem(CONFIG.key_refresh, refresh);
            localStorage.setItem(CONFIG.key_expire,  expireAt);
            localStorage.setItem(CONFIG.key_logined, 'true');

            // Резерв в localStorage под другими ключами (не чистится Tizen так же агрессивно)
            localStorage.setItem(CONFIG.backup_access,  access);
            localStorage.setItem(CONFIG.backup_refresh, refresh);
            localStorage.setItem(CONFIG.backup_expire,  expireAt);

            // Резерв в Lampa.Storage (IndexedDB)
            try {
                Lampa.Storage.set(CONFIG.backup_access,  access);
                Lampa.Storage.set(CONFIG.backup_refresh, refresh);
                Lampa.Storage.set(CONFIG.backup_expire,  expireAt);
                console.log('[KP Keeper] Токены продублированы в localStorage + Lampa.Storage');
            } catch (e) {
                console.log('[KP Keeper] Ошибка дублирования в Lampa.Storage:', e);
            }
        },

        secondsLeft: function () {
            var expireAt = this.getExpireTime();
            if (!expireAt) return 9999;
            return expireAt - Math.floor(Date.now() / 1000);
        },

        needsRefresh: function () {
            return this.secondsLeft() < CONFIG.refresh_threshold_sec;
        },

        initExpireIfMissing: function () {
            if (!localStorage.getItem(CONFIG.key_expire) && this.isAuthorized()) {
                var expireAt = Math.floor(Date.now() / 1000) + 86400;
                localStorage.setItem(CONFIG.key_expire,  expireAt);
                localStorage.setItem(CONFIG.backup_expire, expireAt);
                console.log('[KP Keeper] Установлено время истечения +24ч');
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
                onFail && onFail('no_refresh_token');
                return;
            }

            this._refreshing = true;
            var self = this;
            console.log('[KP Keeper] Обновляем токен...');

            Http.post(CONFIG.oauth_url, {
                grant_type:    'refresh_token',
                client_id:     CONFIG.client_id,
                client_secret: CONFIG.client_secret,
                refresh_token: refreshToken
            }, function (resp) {
                self._refreshing = false;
                if (resp.access_token) {
                    TokenStore.saveTokens(
                        resp.access_token,
                        resp.refresh_token || refreshToken,
                        resp.expires_in || 86400
                    );
                    console.log('[KP Keeper] Токен обновлён! Истекает через', resp.expires_in, 'сек');
                    onSuccess && onSuccess(resp);
                } else {
                    onFail && onFail('empty_response');
                }
            }, function (status, text) {
                self._refreshing = false;
                console.log('[KP Keeper] Ошибка обновления:', status, text);
                if (status === 401 || status === 400) {
                    // Чистим резерв
                    localStorage.removeItem(CONFIG.backup_access);
                    localStorage.removeItem(CONFIG.backup_refresh);
                    localStorage.removeItem(CONFIG.backup_expire);
                    try {
                        Lampa.Storage.set(CONFIG.backup_access,  '');
                        Lampa.Storage.set(CONFIG.backup_refresh, '');
                        Lampa.Storage.set(CONFIG.backup_expire,  0);
                    } catch(e) {}
                    Lampa.Noty.show('Kino.pub: сессия истекла — войдите через Modss → Online → KinoPub');
                }
                onFail && onFail(status);
            });
        },

        checkAndRefresh: function () {
            if (!TokenStore.isAuthorized()) return;
            var left = TokenStore.secondsLeft();
            console.log('[KP Keeper] Проверка. Осталось секунд:', left);
            if (TokenStore.needsRefresh()) {
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
        _timer:      null,
        _lastAccess: '',

        start: function () {
            if (this._timer) return;
            this._lastAccess = TokenStore.getAccess();

            setTimeout(function () {
                TokenRefresher.checkAndRefresh();
            }, 5000);

            this._timer = setInterval(function () {
                // Если online_mod записал новый токен — сразу дублируем
                var current = TokenStore.getAccess();
                if (current && current !== Watchdog._lastAccess) {
                    console.log('[KP Keeper] Новый токен от online_mod, дублируем...');
                    Watchdog._lastAccess = current;
                    TokenStore.saveTokens(
                        current,
                        TokenStore.getRefresh(),
                        TokenStore.secondsLeft()
                    );
                }
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
                        function () { Lampa.Noty.show('Kino.pub: токен успешно обновлён'); },
                        function () { Lampa.Noty.show('Kino.pub: не удалось обновить токен'); }
                    );
                }
            });
        }
    };

    // ============================================================
    //  ИНИЦИАЛИЗАЦИЯ (после загрузки Lampa)
    // ============================================================
    function initPlugin() {
        if (window._kinopubKeeperInited) return;
        window._kinopubKeeperInited = true;

        if (TokenStore.isAuthorized()) {
            TokenStore.initExpireIfMissing();
            // Дублируем текущие токены в резерв
            TokenStore.saveTokens(
                TokenStore.getAccess(),
                TokenStore.getRefresh(),
                TokenStore.secondsLeft()
            );
        }

        SettingsUI.init();
        Watchdog.start();

        console.log('[KP Keeper] v2.1.0 инициализирован. Авторизован:', TokenStore.isAuthorized());
        if (TokenStore.isAuthorized()) {
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
