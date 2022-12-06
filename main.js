// ==UserScript==
// @name         TG-freee-Utils
// @namespace    http://tampermonkey.net/
// @version      1.5.1
// @description  TG用 freeeのUtil。自動でログインしたり、自動で退勤したり。
// @author       @__MOX__
// @match        https://accounts.secure.freee.co.jp/*
// @match        https://p.secure.freee.co.jp/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=freee.co.jp
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      holidays-jp.github.io
// ==/UserScript==

(function () {
    'use strict';

    const APP_NAME = 'TG-freee-Utils';
    const LOG_PREFIX = `[${APP_NAME}]: `;
    const SETTINGS = {
        // freeeのメールアドレス
        email: 'YOUR_EMAIL',
        // freeeのパスワード
        password: 'YOUR_PASSWORD',

        // 稼働開始の時間
        joinStartTime: '11:50',
        // 出勤打刻をする時間の歪み (joinStartTime + rand(max: joinJitterSec))
        joinJitterSec: 10 * 60,


        // 退勤通知の時間
        leaveStartTime: '21:50',
        // 何もしなかったときに自動で退勤するまでの時間 leaveStartTime + leaveWaitSec
        leaveWaitSec: 120,
        // 何もしなかったときに自動で退勤するまでの時間の歪み
        leaveWaitJitterSec: 120,

        // 祝日の一覧をとってくるAPI
        holidayApi: 'https://holidays-jp.github.io/api/v1/datetime.json'
    };

    const GLOBAL_STATE = {
        showLeaveDialog: false,
        workContinue: false,
    };

    Object.freeze(SETTINGS);

    const intervals = [];

    /**
     * 祝日の一覧を取得する
     */
    const getHolidayList = () => {
        const url = SETTINGS.holidayApi;
        return new Promise(resolve =>
            GM_xmlhttpRequest({
                method: "GET",
                url,
                onload: response => {
                    const json = JSON.parse(response.responseText);
                    const holidayList = Object.keys(json).map(h => new Date(h * 1000));
                    console.log(holidayList);
                    resolve(holidayList);
                },
                withCredentials: true,
            })
        );
    }

    /**
     * 全てのインターバルをクリアする
     */
    const stopAllIntervals = () => {
        intervals.forEach(i => clearInterval(i));
        intervals.length = 0;
    }

    /**
     * ログインを試行する。URLが /login/hr であればログインを試行する。
     */
    const tryAutoLogin = () => {
        console.log(LOG_PREFIX, 'pathname', location.pathname);
        if (location.pathname == '/login/hr') {
            document.querySelector('#login_id').value = SETTINGS.email;
            document.querySelector('div.field:nth-child(3) > input:nth-child(1)').value = SETTINGS.password;

            document.querySelector('input.btn').click();
        }
    }

    /**
     * ログイン状態を継続させる
     */
    const heartbeat = () => {
        fetch("https://p.secure.freee.co.jp/api/p/heartbeat", {
            "headers": {
                "accept": "application/json, text/javascript, */*; q=0.01",
                "accept-language": "en-US,en;q=0.5",
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                "sec-gpc": "1",
                "x-company-id": "1730",
                "x-requested-with": "XMLHttpRequest"
            },
            "referrer": "https://p.secure.freee.co.jp/",
            "referrerPolicy": "strict-origin-when-cross-origin",
            "body": null,
            "method": "GET",
            "mode": "cors",
            "credentials": "include"
        });
    }

    // ログイン画面以外で3分おきにheartbeatを実行する
    const heartbeatInterval = () => {
        const id = setInterval(() => {
            if (location.hostname !== 'p.secure.freee.co.jp') {
                return;
            }
            heartbeat();
        }, 1000 * 60 * 3);
        intervals.push(id);
    };

    /**
     * 現在稼働中かどうかを判断する
     * @returns {boolean}
     */
    const isJoining = () => {
        const buttons = document.querySelectorAll('.vb-button--appearancePrimary');
        let isJoining = false;
        buttons.forEach(e => {
            if (e.innerText === '退勤する') {
                isJoining = true;
            }
        });
        return isJoining;
    }

    const getJoinButton = () => {
        const buttons = document.querySelectorAll('.vb-button--appearancePrimary');
        let joinButton = null;
        buttons.forEach(e => {
            if (e.innerText === '出勤する') {
                joinButton = e;
            }
        });
        return joinButton;
    }

    /**
     * 現在稼働前かどうかを判断する
     * @returns {boolean}
     */
    const isBeforeJoined = () => {
        const buttons = document.querySelectorAll('.vb-button--appearancePrimary');
        let isBeforeJoined = false;
        buttons.forEach(e => {
            if (e.innerText === '出勤する') {
                isBeforeJoined = true;
            }
        })
        return isBeforeJoined;
    }

    /**
     * 時刻をパースしてオブジェクトで返す。
     * @param {string} time HH:MMの形式の時刻
     * @returns {{h: number, m: number} | undefined}
     */
    const parseLeaveTime = (time) => {
        const leaveTimeSliceed = time.trim().split(':');

        if (leaveTimeSliceed.length !== 2) {
            throw Error(`parse error. invalid time format: "${time}"`);
        }

        const leaveTime = {
            h: parseInt(leaveTimeSliceed[0]),
            m: parseInt(leaveTimeSliceed[1]),
        }

        if (leaveTime.h < 0 || leaveTime.h > 24 || leaveTime.m < 0 || leaveTime.m > 59) {
            throw Error(`parse error. invalid time format: "${time}"`);
        }

        return leaveTime;
    }

    /**
     * 一定時間「待機しない」が押されなかった場合に自動退勤を行う。
     * @returns {undefined}
     */
    const setLeaveDialog = () => {
        if (GLOBAL_STATE.showLeaveDialog) {
            return;
        }
        GLOBAL_STATE.showLeaveDialog = true;
        const notificationMessage = [
            `${SETTINGS.leaveStartTime}になりました。営業を終了してください。',
            '数秒後にホタルノヒカリが流れます。',
            'もしこの通知を無視する場合はfreeeのタブを開き、「退勤しない」を押してください。`
        ]
        GM_notification({
            title: '本日は営業終了',
            text: notificationMessage.join('\n'),
            timeout: 15 * 1000,
            highlight: true,
        });

        document.body.click();

        const continueButton = document.createElement('button');
        continueButton.innerText = '退勤しない';
        continueButton.setAttribute('class', 'vb-button vb-button--appearancePrimary vb-button--danger vb-mr50');
        continueButton.style = 'width: calc(100% - 200px); height: 75px; margin: 30px 100px;';
        document.body.appendChild(continueButton);

        const video = document.createElement('iframe');
        video.setAttribute('width', 1627);
        video.setAttribute('height', 745);
        video.setAttribute('src', 'https://www.youtube.com/embed/OgYWssWn7uQ?autoplay=1&loop=1&playlist=OgYWssWn7uQ');
        video.setAttribute('frameborder', '0');
        video.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
        video.setAttribute('allowfullscreen', '');
        document.body.appendChild(video);

        continueButton.addEventListener('click', () => {
            GLOBAL_STATE.workContinue = true;
            alert('自動退勤を無効化しました。');
            document.body.removeChild(video);
            document.body.removeChild(continueButton);
        }, false);

        // 自動退勤
        const leaveAfter = (SETTINGS.leaveWaitSec + SETTINGS.leaveWaitJitterSec * Math.random()) * 1000;
        console.log(LOG_PREFIX, 'leave timer set', leaveAfter, 'ms');
        const leaveAfterSec = Math.floor(leaveAfter / 1000);
        GM_notification({
            title: '自動退勤まで',
            text: `${leaveAfterSec}秒以内に退勤が押されない場合は自動的に退勤が行われます。`,
            timeout: 15 * 1000,
            highlight: true,
        });
        setTimeout(() => {
            console.log(LOG_PREFIX, 'LEAVE work continue?', GLOBAL_STATE.workContinue);
            if (GLOBAL_STATE.workContinue) {
                return;
            }
            const currentJoining = isJoining();
            console.log(LOG_PREFIX, 'LEAVE current joining', currentJoining);
            if (!currentJoining) {
                return;
            }

            GM_notification({
                title: '本日は営業終了',
                text: `${SETTINGS.leaveWaitSec}秒間に「退勤しない」が押されなかったため、自動で退勤ボタンを押しました。`,
            });

            const buttons = document.querySelectorAll('.vb-button--appearancePrimary');
            buttons.forEach(e => {
                if (e.innerText === '退勤する') {
                    e.click();
                    document.body.removeChild(video);
                    document.body.removeChild(continueButton);
                }
            });

        }, leaveAfter);
    };

    /**
     * 定刻になったら自動で抜けるためのスケジューラーを設定する
     */
    const setAutoLeave = () => {
        const id = setInterval(() => {
            const currentJoining = isJoining();
            console.log(LOG_PREFIX, 'current joining', currentJoining);
            if (!currentJoining) {
                return;
            }
            const now = new Date();

            const nowTime = ('00' + now.getHours()).slice(-2) + ':' + ('00' + now.getMinutes()).slice(-2);
            const leaveTime = parseLeaveTime(SETTINGS.leaveStartTime);
            const nowTimes = {
                h: now.getHours(),
                m: now.getMinutes(),
            }

            console.log(LOG_PREFIX, 'now', nowTime, 'leave time', SETTINGS.leaveStartTime);

            if (nowTimes.h > leaveTime.h || (nowTimes.h == leaveTime.h && nowTimes.m >= leaveTime.m)) {
                setLeaveDialog();
            }

        }, 1 * 1000);
        intervals.push(id);
    };


    /**
     * 定刻になったら自動で出勤するためのスケジューラーを設定する
     */
    const setAutoJoin = () => {
        const id = setInterval(async () => {
            const now = new Date();

            const nowTime = ('00' + now.getHours()).slice(-2) + ':' + ('00' + now.getMinutes()).slice(-2);
            const joinTime = parseLeaveTime(SETTINGS.joinStartTime);
            const nowTimes = {
                h: now.getHours(),
                m: now.getMinutes(),
            }
            const jitterMsec = SETTINGS.joinJitterSec * 1000
            const joinTimeUnix = new Date(now.getFullYear(), now.getMonth(), now.getDate(), joinTime.h, joinTime.m, 0).getTime();
            const minPer = -(joinTimeUnix - now.getTime()) / jitterMsec;
            const joinSub = Math.random() * (1 - minPer) + minPer;

            // 開始予定時刻より前であれば何もしない
            if (!(nowTimes.h > joinTime.h || (nowTimes.h == joinTime.h && nowTimes.m >= joinTime.m))) {
                return;
            }

            // 開始時間直前に一旦リロードしてデータを同期させる
            const lastLoadTime = await GM_getValue('lastLoadTime', 0);
            if (lastLoadTime < joinTimeUnix) {
                console.log(lastLoadTime < joinTimeUnix, lastLoadTime, joinTimeUnix);
                stopAllIntervals();
                location.reload();
            }

            const currentBeforeJoining = isBeforeJoined();
            console.log(LOG_PREFIX, 'current before joining', currentBeforeJoining);
            if (!currentBeforeJoining) {
                return;
            }

            console.log(LOG_PREFIX, 'now', nowTime, 'join time', SETTINGS.joinStartTime);

            // 10%の確率で打刻する
            if (joinSub < 0.90) {
                return;
            }
            console.log(LOG_PREFIX, 'join push (', joinSub, ')');

            // 休日チェック
            const dayOfWeek = now.getDay();
            if (dayOfWeek == 0 || dayOfWeek == 6) {
                console.log(LOG_PREFIX, 'today is holiday(Sunday or Saturday). not join.');
                return;
            }

            // 祝日チェック
            const holidays = await getHolidayList();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            if (holidays.some(e => e.getTime() === today.getTime())) {
                console.log(LOG_PREFIX, 'today is holiday (sp). not join.');
                return;
            }

            const joinButton = getJoinButton();
            if (!joinButton) {
                console.log(LOG_PREFIX, 'join button not found!');
                return;
            }
            joinButton.click();
        }, 1 * 1000);
        intervals.push(id);
    }

    window.addEventListener('load', () => {
        // 読み込みした日時を入れておく
        const loadTime = new Date();
        GM_setValue('lastLoadTime', loadTime.getTime());

        tryAutoLogin();
        setAutoLeave();
        heartbeatInterval();
        setAutoJoin();
    });
})();