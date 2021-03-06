"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const puppeteer_1 = require("puppeteer");
const rp = require("request-promise-native");
const ToughCookie = require("tough-cookie");
const util_1 = require("util");
const helper_1 = require("./helper");
const COOKIE_PATH = __dirname + "/../tmp/.cookies.json";
const HOST = "https://simplemining.net/";
const LOGIN_PAGE = `${HOST}account/login`;
const RIGS_LIST_PAGE = `${HOST}json/getListRigs`;
const REBOOT_RIG_PAGE = `${HOST}json/rebootRig`;
const TESSERACT_JS = "https://cdn.rawgit.com/naptha/tesseract.js/1.0.10/dist/tesseract.js";
const accessAsync = util_1.promisify(fs_1.access);
const mkdirAsync = util_1.promisify(fs_1.mkdir);
const readFileAsync = util_1.promisify(fs_1.readFile);
const unlinkAsync = util_1.promisify(fs_1.unlink);
const writeFileAsync = util_1.promisify(fs_1.writeFile);
class API {
    constructor(email, password) {
        this.email = email;
        this.password = password;
    }
    /**
     * @returns {Promise<IRigInfo[]>}
     */
    getListRigs() {
        return this.sendRequest({ method: "GET", uri: RIGS_LIST_PAGE }).then((rigs) => {
            return rigs.map((rig) => {
                const { gpuCoreFrequencies, gpuMemoryFrequencies } = helper_1.parseGPUCoreMemory(rig);
                const { temperatures, fansSpeed } = helper_1.parseTemps(rig);
                const { hashRates, hashRate } = helper_1.parseSpeed(rig);
                const { uptime, programStartDate, serverTime, lastSeenDate, totalRestarts } = helper_1.parseLastUpdate(rig);
                const { kernel, ip } = helper_1.parseName(rig);
                return {
                    fansSpeed,
                    gpuCoreFrequencies,
                    gpuMemoryFrequencies,
                    group: rig.group,
                    hashRate,
                    hashRates,
                    id: rig.id,
                    ip,
                    kernel,
                    lastSeenDate,
                    osVersion: rig.version,
                    programStartDate,
                    serverTime,
                    temperatures,
                    totalRestarts,
                    uptime,
                };
            });
        });
    }
    /**
     * @param {string} id
     * @returns {Promise<void>}
     */
    rebootRig(id) {
        return this.sendRequest({ method: "POST", uri: REBOOT_RIG_PAGE, form: { id } }).then(() => {
            // return void
        });
    }
    /**
     * @param {request.CoreOptions & request.UriOptions} rpParams
     * @returns {Promise<any>}
     */
    sendRequest(rpParams) {
        let retryCount = 0;
        const caller = () => this.getJar()
            .then((jar) => rp(Object.assign({ jar }, rpParams)))
            .then((body) => body === ""
            ? this.deleteSavedCookies().then(() => retryCount++ === 3
                ? Promise.reject(new Error("Unable to get rigs list"))
                : caller())
            : JSON.parse(body));
        return caller();
    }
    /**
     * @returns {Promise<void>}
     */
    login() {
        return new Promise((resolve, reject) => {
            const closeBrowser = () => this.getBrowser()
                .then((browser) => browser.close()
                .then(() => this.browser = undefined, () => this.browser = undefined));
            const rejecter = ((e) => {
                closeBrowser();
                reject(e);
            });
            this.getPage().then((page) => {
                let retryCount = 0;
                return page.goto(LOGIN_PAGE).then(() => {
                    return this.doLogin(page);
                }).then(() => {
                    page.on("domcontentloaded", () => {
                        page.evaluate(() => {
                            const notif = document.querySelector("#content-main-notification");
                            return notif && notif.textContent
                                ? notif.textContent.replace("×", "").trim()
                                : (document.body && document.body.textContent &&
                                    /^You tried to login too many times/.test(document.body.textContent)
                                    ? document.body.textContent.trim()
                                    : "");
                        }).then((error) => {
                            if (/Logged success/.test(error)) {
                                page.cookies()
                                    .then((cookies) => this.convertPuppeteerCookiesToToughCookies(cookies))
                                    .then((cookies) => Promise.all([this.saveCookie(cookies), closeBrowser()]).then(() => cookies))
                                    .then((cookies) => {
                                    this.jar = rp.jar();
                                    cookies.forEach((cookie) => {
                                        this.jar.setCookie(cookie, HOST);
                                    });
                                    resolve(this.jar);
                                });
                            }
                            else if (/Invalid captcha/.test(error) && retryCount++ < 3) {
                                this.doLogin(page).catch(rejecter);
                            }
                            else {
                                rejecter(new Error(error || "Unknown error"));
                            }
                        }).catch(rejecter);
                    });
                });
            }).catch(rejecter);
        });
    }
    /**
     * @param {Page} page
     * @returns {Promise<void>}
     */
    async doLogin(page) {
        await page.addScriptTag({ url: TESSERACT_JS });
        await page.evaluate((email, password) => {
            const findCaptcha = () => document.querySelectorAll("img[src=\"/captcha\"")[0];
            const resolveCaptcha = (img) => Tesseract
                .recognize(img, { tessedit_char_whitelist: "abcdefghijklmnopqrstuvwxyz0123456789" })
                .progress(console.log);
            const login = (img) => {
                resolveCaptcha(img).then((r) => {
                    document.querySelector("input[name=\"data[User][email]\"]").value = email;
                    document.querySelector("input[name=\"data[User][password]\"]").value = password;
                    document.querySelector("input[name=\"data[User][captcha]\"]").value = r.text;
                    document.querySelector("#login-form [type=\"submit\"]").click();
                });
            };
            login(findCaptcha());
        }, this.email, this.password);
    }
    /**
     * @returns {Promise<Browser>}
     */
    getBrowser() {
        return this.browser
            ? Promise.resolve(this.browser)
            : puppeteer_1.launch().then((b) => this.browser = b);
    }
    /**
     * @returns {Promise<Page>}
     */
    getPage() {
        return this.getBrowser().then((browser) => browser.newPage());
    }
    /**
     * @param {Cookie[]} cookies
     * @returns {Promise<void>}
     */
    saveCookie(cookies) {
        const cookieDir = path_1.dirname(COOKIE_PATH);
        const cookieStr = JSON.stringify(cookies);
        const writeJarPromiseFn = () => writeFileAsync(COOKIE_PATH, cookieStr);
        const mkdirPromiseFn = () => mkdirAsync(cookieDir).then(writeJarPromiseFn);
        return accessAsync(cookieDir).then(writeJarPromiseFn, mkdirPromiseFn);
    }
    /**
     * @param {Cookie[]} cookies
     * @returns {ToughCookie.Cookie[]}
     */
    convertPuppeteerCookiesToToughCookies(cookies) {
        return cookies.map((cookie) => new ToughCookie.Cookie({
            domain: cookie.domain,
            expires: new Date(cookie.expires * 1000),
            httpOnly: cookie.httpOnly,
            key: cookie.name,
            path: cookie.path,
            secure: cookie.secure,
            value: cookie.value,
        }));
    }
    /**
     * @returns {Promise<void>}
     */
    deleteSavedCookies() {
        delete this.jar;
        return unlinkAsync(COOKIE_PATH);
    }
    /**
     * @returns {Promise<request.CookieJar>}
     */
    getJar() {
        if (this.jar && this.jar.getCookies(HOST).length) {
            return Promise.resolve(this.jar);
        }
        else {
            return readFileAsync(COOKIE_PATH).then((jsonStr) => {
                let json;
                try {
                    json = JSON.parse(jsonStr.toString());
                }
                catch (_a) {
                    // Ignore error
                }
                if (!(json instanceof Array)) {
                    return this.deleteSavedCookies().then(this.login.bind(this));
                }
                const jar = rp.jar();
                json.forEach((cookieJSON) => {
                    const cookie = ToughCookie.Cookie.fromJSON(cookieJSON);
                    if (cookie instanceof ToughCookie.Cookie) {
                        jar.setCookie(cookie, HOST);
                    }
                });
                this.jar = jar;
                return Promise.resolve(this.jar);
            }, this.login.bind(this));
        }
    }
}
exports.default = API;
