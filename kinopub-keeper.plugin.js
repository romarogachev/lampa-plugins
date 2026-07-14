/**
 * ============================================================
 *  Kino.pub Token Keeper for Lampa + online_mod
 *  Version: 1.0.0
 *
 *  Назначение:
 *  Следит за токеном KinoPub который хранит online_mod
 *  в ключе 'online_kinopub_token' и автоматически обновляет
 *  его через refresh_token до истечения.
 *
 *  Установить ВМЕСТЕ с online_mod (http://lampa.stream/modss).
 *  Отдельная авторизация не нужна — авторизуйтесь через
 *  online_mod (Настройки → Modss → Online → KinoPub).
 * ============================================================
 */

(function () {
    'use strict';

    var CONFIG = {
        // Ключи online_mod в Lampa.Storage
        storage_key:  'online_kinopub_token',
        api_key:      'online_kinopub_api',

        // Дефолтный API (online_mod может переопределить через storage)
        api_default:  'https://api.srvkp.com/',

        // Credentials online_mod
        client_id:     'lampa',
        client_secret: 'lampa',

        // За сколько секунд до истечения делать превентивное обновление
        refresh_threshold_sec: 600, // 10 минут

        // Как часто проверять токен в фоне (мс)
        check_interval_ms: 60000 // каждую минуту
    };

    // ============================================================
    //  РАБОТА С ТОКЕНОМ ONLINE_MOD
    // ============================================================
    var TokenStore = {
        get: function () {
            var raw = Lampa.Storage.get(CONFIG.storage_key, '');
            if (!raw) return null;
            try {
                return typeof raw === 'object' ? raw : JSON.parse(raw);
            } catch (e) { return null; }
        },

        save: function (data) {
            data.time = Math.floor(Date.now() / 1000);
            Lampa.Storage.set(CONFIG.storage_key, data);
        },

        clear: function () {
            Lampa.Storage.set(CONFIG.storage_key, '');
        },

        isAuthorized: function () {
            var t = this.get();
            return !!(t && t.access_token);
        },

        // Сколько секунд осталось до истечения токена
        secondsLeft: function () {
            var t = this.get();
            if (!t || !t.time || !t.expires_in) return 0;
            var expireAt = t.time + t.expires_in;
            return expireAt - Math.floor(Date.now() / 1000);
        },

        needsRefresh: function () {
            return this.secondsLeft() < CONFIG.refresh_threshold_sec;
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
    //  ЛОГИКА ОБНОВЛЕНИЯ ТОКЕНА
    // ============================================================
    var TokenRefresher = {
        _refreshing: false,

        getApiUrl: function () {
            return Lampa.Storage.get(CONFIG.api_key, CONFIG.api_default);
        },

        // Обновить токен через refresh_token
        refresh: function (onSuccess, onFail) {
            if (this._refreshing) return;

            var tokenData = TokenStore.get();
            if (!tokenData || !tokenData.refresh_token) {
                onFail && onFail('no_refresh_token');
                return;
            }

            this._refreshing = true;
            var self = this;
            var apiUrl = this.getApiUrl();

            console.log('[KP Keeper] Обновляем токен...');

            Http.post(
                apiUrl + 'oauth2/token',
                {
                    grant_type:    'refresh_token',
                    client_id:     CONFIG.client_id,
                    client_secret: CONFIG.client_secret,
                    refresh_token: tokenData.refresh_token
                },
                function (resp) {
                    self._refreshing = false;
                    if (resp.access_token) {
                        TokenStore.save(resp);
                        console.log('[KP Keeper] Токен успешно обновлён. Истекает через', resp.expires_in, 'сек');
                        onSuccess && onSuccess(resp);
                    } else {
                        console.log('[KP Keeper] Ответ без access_token:', JSON.stringify(resp));
                        onFail && onFail('no_access_token');
                    }
                },
                function (status, text) {
                    self._refreshing = false;
                    console.log('[KP Keeper] Ошибка обновления токена:', status, text);
                    if (status === 401 || status === 400) {
                        // refresh_token протух — нужна переавторизация
                        TokenStore.clear();
                        Lampa.Noty.show('Kino.pub: сессия истекла, войдите через Modss → Online → KinoPub');
                    }
                    onFail && onFail(status);
                }
            );
        },

        // Проверить и при необходимости обновить
        checkAndRefresh: function () {
            if (!TokenStore.isAuthorized()) {
                console.log('[KP Keeper] Токен не найден — авторизация не выполнена');
                return;
            }

            var left = TokenStore.secondsLeft();
            console.log('[KP Keeper] Проверка токена. Осталось секунд:', left);

            if (TokenStore.needsRefresh()) {
                console.log('[KP Keeper] Токен истекает, запускаем обновление...');
                this.refresh(
                    function () { console.log('[KP Keeper] Фоновое обновление успешно'); },
                    function (err) { console.log('[KP Keeper] Фоновое обновление не удалось:', err); }
                );
            }
        }
    };

    // ============================================================
    //  ФОНОВЫЙ WATCHDOG
    //  Проверяет токен каждую минуту
    // ============================================================
    var Watchdog = {
        _timer: null,

        start: function () {
            if (this._timer) return;
            // Первая проверка через 5 секунд после старта
            setTimeout(function () {
                TokenRefresher.checkAndRefresh();
            }, 5000);

            // Затем каждую минуту
            this._timer = setInterval(function () {
                TokenRefresher.checkAndRefresh();
            }, CONFIG.check_interval_ms);

            console.log('[KP Keeper] Watchdog запущен');
        },

        stop: function () {
            if (this._timer) {
                clearInterval(this._timer);
                this._timer = null;
            }
        }
    };

    // ============================================================
    //  UI В НАСТРОЙКАХ
    //  Показывает статус токена и время до истечения
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
                    name:        'Статус токена',
                    description: SettingsUI._getStatus()
                },
                onChange: function () {
                    Lampa.Storage.set('kinopub_keeper_status', false);
                    // Показываем детальный статус
                    var t = TokenStore.get();
                    if (!t) {
                        Lampa.Noty.show('Kino.pub: токен не найден. Авторизуйтесь через Modss → Online → KinoPub');
                        return;
                    }
                    var left = TokenStore.secondsLeft();
                    var hours = Math.floor(left / 3600);
                    var mins  = Math.floor((left % 3600) / 60);
                    Lampa.Noty.show('Kino.pub: токен активен, истекает через ' + hours + 'ч ' + mins + 'мин');

                    // Принудительное обновление
                    if (TokenStore.needsRefresh()) {
                        TokenRefresher.refresh(
                            function () { Lampa.Noty.show('Kino.pub: токен обновлён'); },
                            function () { Lampa.Noty.show('Kino.pub: не удалось обновить токен'); }
                        );
                    }
                }
            });
        },

        _getStatus: function () {
            if (!TokenStore.isAuthorized()) return 'Не авторизован — войдите через Modss';
            var left = TokenStore.secondsLeft();
            if (left <= 0) return 'Токен истёк';
            var hours = Math.floor(left / 3600);
            return 'Авторизован ✓ (токен истекает через ~' + hours + 'ч)';
        }
    };

    // ============================================================
    //  ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function initPlugin() {
        if (window._kinopubKeeperInited) return;
        window._kinopubKeeperInited = true;

        SettingsUI.init();
        Watchdog.start();

        console.log('[KP Keeper] Инициализирован. Токен есть:', TokenStore.isAuthorized());
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
