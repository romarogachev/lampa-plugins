/**
 * ============================================================
 *  Kino.pub Token Keeper for Lampa + online_mod
 *  Version: 2.0.0
 *
 *  Неубиваемая авторизация:
 *  - Следит за токенами online_mod (pub_access_token, pub_refresh_token)
 *  - Дублирует токены в Lampa.Storage (IndexedDB, Tizen не трогает)
 *  - При старте восстанавливает токены из Lampa.Storage если localStorage пуст
 *  - Автообновляет токен за 10 минут до истечения
 * ============================================================
 */

(function () {
    'use strict';

    var CONFIG = {
        // Ключи online_mod в localStorage
        key_access:  'pub_access_token',
        key_refresh: 'pub_refresh_token',
        key_expire:  'pub_expire_time',
        key_logined: 'logined_pub',
        key_code:    'pub_code',

        // Резервные ключи в Lampa.Storage (IndexedDB — Tizen не чистит)
        backup_access:  'kp_backup_access',
        backup_refresh: 'kp_backup_refresh',
        backup_expire:  'kp_backup_expire',

        // API
        oauth_url:     'https://api.srvkp.com/oauth2/token',
        client_id:     'xbmc',
        client_secret: 'cgg3gtifu46urtfp2zp1nqtba0k2ezxh',

        refresh_threshold_sec: 600,  // обновлять за 10 минут до истечения
        check_interval_ms:     60000 // проверять каждую минуту
    };

    // ============================================================
    //  ХРАНИЛИЩЕ
    // ============================================================
    var TokenStore = {
        // Проверить авторизован ли пользователь
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

        // Сохранить токены И продублировать в Lampa.Storage
        saveTokens: function (access, refresh, expiresIn) {
            var expireAt = Math.floor(Date.now() / 1000) + (expiresIn || 86400);

            // Пишем в localStorage (для online_mod)
            localStorage.setItem(CONFIG.key_access,  access);
            localStorage.setItem(CONFIG.key_refresh, refresh);
            localStorage.setItem(CONFIG.key_expire,  expireAt);
            localStorage.setItem(CONFIG.key_logined, 'true');

            // Дублируем в Lampa.Storage (резерв на случай очистки Tizen)
            try {
                Lampa.Storage.set(CONFIG.backup_access,  access);
                Lampa.Storage.set(CONFIG.backup_refresh, refresh);
                Lampa.Storage.set(CONFIG.backup_expire,  expireAt);
                console.log('[KP Keeper] Токены продублированы в Lampa.Storage');
            } catch (e) {
                console.log('[KP Keeper] Ошибка дублирования в Lampa.Storage:', e);
            }
        },

        // Восстановить токены из Lampa.Storage в localStorage
        restoreFromBackup: function () {
            try {
                var access  = Lampa.Storage.get(CONFIG.backup_access,  '');
                var refresh = Lampa.Storage.get(CONFIG.backup_refresh, '');
                var expire  = Lampa.Storage.get(CONFIG.backup_expire,  0);

                if (!access || !refresh) {
                    console.log('[KP Keeper] Резерв пуст, восстановление невозможно');
                    return false;
                }

                localStorage.setItem(CONFIG.key_access,  access);
                localStorage.setItem(CONFIG.key_refresh, refresh);
                localStorage.setItem(CONFIG.key_expire,  expire);
                localStorage.setItem(CONFIG.key_logined, 'true');

                console.log('[KP Keeper] Токены восстановлены из Lampa.Storage!');
                return true;
            } catch (e) {
                console.log('[KP Keeper] Ошибка восстановления:', e);
                return false;
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

        // Если expire не установлен — поставить +24ч и сразу сделать бэкап
        initExpireIfMissing: function () {
            if (!localStorage.getItem(CONFIG.key_expire) && this.isAuthorized()) {
                var expireAt = Math.floor(Date.now() / 1000) + 86400;
                localStorage.setItem(CONFIG.key_expire, expireAt);
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
                console.log('[KP Keeper] Нет refresh_token');
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
                    console.log('[KP Keeper] Ответ без access_token');
                    onFail && onFail('empty_response');
                }
            }, function (status, text) {
                self._refreshing = false;
                console.log('[KP Keeper] Ошибка обновления:', status, text);
                if (status === 401 || status === 400) {
                    // Токен полностью протух — чистим резерв тоже
                    Lampa.Storage.set(CONFIG.backup_access,  '');
                    Lampa.Storage.set(CONFIG.backup_refresh, '');
                    Lampa.Storage.set(CONFIG.backup_expire,  0);
                    Lampa.Noty.show('Kino.pub: сессия истекла — войдите через Modss → Online → KinoPub');
                }
                onFail && onFail(status);
            });
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
    //  WATCHDOG — следит за токеном каждую минуту
    //  + следит за изменениями localStorage (online_mod мог записать новый токен)
    // ============================================================
    var Watchdog = {
        _timer:      null,
        _lastAccess: '',

        start: function () {
            if (this._timer) return;
            this._lastAccess = TokenStore.getAccess();

            // Первая проверка через 5 секунд
            setTimeout(function () {
                TokenRefresher.checkAndRefresh();
            }, 5000);

            this._timer = setInterval(function () {
                // Если online_mod записал новый токен — сразу дублируем в резерв
                var currentAccess = TokenStore.getAccess();
                if (currentAccess && currentAccess !== Watchdog._lastAccess) {
                    console.log('[KP Keeper] Обнаружен новый токен от online_mod, дублируем...');
                    Watchdog._lastAccess = currentAccess;
                    TokenStore.saveTokens(
                        currentAccess,
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
    //  ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function initPlugin() {
        if (window._kinopubKeeperInited) return;
        window._kinopubKeeperInited = true;

        // Шаг 1: если localStorage пуст — попробовать восстановить из резерва
        if (!TokenStore.isAuthorized()) {
            console.log('[KP Keeper] localStorage пуст, пробуем восстановить из резерва...');
            var restored = TokenStore.restoreFromBackup();
            if (restored) {
                Lampa.Noty.show('Kino.pub: сессия восстановлена автоматически ✓');
            }
        }

        // Шаг 2: если авторизован — инициализировать expire и сделать бэкап
        if (TokenStore.isAuthorized()) {
            TokenStore.initExpireIfMissing();
            // Сразу дублируем текущие токены в резерв
            TokenStore.saveTokens(
                TokenStore.getAccess(),
                TokenStore.getRefresh(),
                TokenStore.secondsLeft()
            );
        }

        // Шаг 3: запустить UI и watchdog
        SettingsUI.init();
        Watchdog.start();

        console.log('[KP Keeper] v2.0.0 инициализирован. Авторизован:', TokenStore.isAuthorized());
        if (TokenStore.isAuthorized()) {
            console.log('[KP Keeper] Секунд до истечения:', TokenStore.secondsLeft());
            var backup = Lampa.Storage.get(CONFIG.backup_access, '');
            console.log('[KP Keeper] Резерв в Lampa.Storage:', backup ? 'есть ✓' : 'пуст');
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
