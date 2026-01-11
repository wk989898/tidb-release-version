// ==UserScript==
// @name         tidb-release-version
// @version      0.05
// @description  A userscript for GitHub to query tidb release version
// @author       wk989898
// @homepage     https://github.com/wk989898/tidb-release-version
// @updateURL    https://github.com/wk989898/tidb-release-version/raw/master/tidb-release-version.user.js
// @downloadURL  https://github.com/wk989898/tidb-release-version/raw/master/tidb-release-version.user.js
// @supportURL   https://github.com/wk989898/tidb-release-version
// @match        https://github.com/pingcap/*
// @match        https://github.com/tikv/*
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(async function () {

    'use strict';
    const { Octokit } = await import('https://esm.sh/@octokit/rest@21.1.1')

    const GITHUB_TOKEN = "GITHUB_TOKEN"
    const NAME = "tidb-release-version"
    const INPUT_TOKEN = `${NAME}-input-token`
    const INPUT_TOKEN_BUTTON = `${INPUT_TOKEN}-btn`
    const LOADING = `${NAME}-loading-indicator`
    const VERSION_LIST = `${NAME}-version-list`
    const REFRESH_BUTTON = `${NAME}-refresh-btn`
    const PARENT_ELEMENT = ".gh-header-actions"
    const BROTHER_CLASS = "flex-md-order-2"
    const EVENT_TYPE = `${NAME}-replace-state`
    const PULL_REG = /pull\/\d+$/
    const TIME_INTERVAL = 500


    function getRepoFromURL() {
        const currentURL = window.location.pathname
        const currentURLSplit = currentURL.split("/")
        const currentRepoOwner = currentURLSplit[1]
        const currentRepoName = currentURLSplit[2]
        const currentType = currentURLSplit[3]
        const currentNumber = currentURLSplit[4]
        return [currentRepoOwner, currentRepoName, currentType, currentNumber]
    }

    async function getPRInfo(octokit, owner, repo, pull_number) {
        let prData = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number
        }).then(res => res.data)
        const match = prData.body.match(/^This is an automated cherry-pick of #(\d+)/)
        if (match) {
            pull_number = match[1]
            prData = await octokit.rest.pulls.get({
                owner,
                repo,
                pull_number
            }).then(res => res.data)
        }
        return [prData, pull_number]
    }

    function filterBranch(branch) {
        // FIXME: Only get branches start with `release`
        return branch.name.startsWith("release")
    }

    async function getBranches(octokit, owner, repo, disableCache = false) {
        const key = `${owner}-${repo}-branches`
        let branches = null
        if (disableCache) {
            localStorage.removeItem(key)
        } else {
            branches = JSON.parse(localStorage.getItem(key))
        }
        if (branches === null) {
            branches = await octokit.paginate(octokit.rest.repos.listBranches, {
                owner,
                repo,
                per_page: 100,
            }).then(res => res.filter(filterBranch).map(branch => branch.name))
            localStorage.setItem(key, JSON.stringify(branches))
        }
        return branches
    }

    async function getTags(octokit, owner, repo, disableCache = false) {
        const key = `${owner}-${repo}-tags`
        let tags = null
        if (disableCache) {
            localStorage.removeItem(key)
        } else {
            tags = JSON.parse(localStorage.getItem(key))
        }
        if (tags === null) {
            let listTags = await octokit.paginate(octokit.rest.repos.listTags, {
                owner,
                repo,
                per_page: 100,
            })
            tags = await Promise.all(
                listTags.map(async tag => {
                    try {
                        const { data: tagCommit } = await octokit.rest.git.getCommit({
                            owner,
                            repo,
                            commit_sha: tag.commit.sha
                        })
                        return {
                            name: tag.name,
                            sha: tag.commit.sha,
                            date: tagCommit.author.date
                        }
                    } catch (e) {
                        return {
                            name: tag.name,
                            sha: tag.commit.sha,
                            date: "0" // default date
                        }
                    }
                })
            )
            localStorage.setItem(key, JSON.stringify(tags))
        }
        return tags
    }

    async function getVersionsFromBranches(octokit, branches, owner, repo, prCreatedAt, pull_number, tags) {
        const versions = {}
        const prTagsMap = {}
        const since = prCreatedAt.toISOString()
        tags.forEach(tag => {
            if (new Date(tag.date) > prCreatedAt) {
                prTagsMap[tag.sha] = tag
            }
        })
        const concurrency = (fn, thread) => {
            const res = []
            for (let i = 0; i < thread; i++) {
                res.push(fn(i))
            }
            return Promise.all(res)
        }
        await Promise.all(
            branches.map(async branch => {
                try {
                    let page = 1
                    let thread = 1
                    let cherryPickExist = false
                    while (true) {
                        const response = await concurrency(index => octokit.rest.repos.listCommits({
                            owner,
                            repo,
                            since,
                            page: page + index,
                            sha: branch,
                            per_page: 100,
                        }), thread)
                        const commits = response.flatMap(res => res.data)
                        if (commits.length == 0) {
                            break
                        }
                        for (let commit of commits) {
                            if (prTagsMap[commit.sha] !== void 0) {
                                const tag = prTagsMap[commit.sha]
                                versions[branch] = tag.name
                            }
                            if (commit.commit.message.includes(`#${pull_number}`)) {
                                if (versions[branch] === void 0) {
                                    versions[branch] = "Next Release"
                                }
                                cherryPickExist = true
                                break
                            }
                        }
                        if ((commits.length < thread * 100) || cherryPickExist) {
                            break
                        }
                        page += thread
                        thread += page
                    }
                    if (!cherryPickExist) {
                        delete versions[branch]
                    }
                } catch (error) {
                    console.error("get release version failed", error)
                }
            })
        )
        return versions
    }

    async function getReleaseVersion(disableCache = false) {
        const token = localStorage.getItem(GITHUB_TOKEN)
        const [owner, repo, type, number] = getRepoFromURL()

        const octokit = new Octokit({
            auth: token
        })
        const [prData, pull_number] = await getPRInfo(octokit, owner, repo, number)
        if (!prData.merged) {
            throw new Error(`PR #${pull_number} has not yet been merged and the release version cannot be determined.`)
        }

        const prCreatedAt = new Date(prData.created_at)
        const branches = await getBranches(octokit, owner, repo, disableCache)
        const tags = await getTags(octokit, owner, repo, disableCache)
        const versions = await getVersionsFromBranches(octokit, branches, owner, repo, prCreatedAt, pull_number, tags)
        return versions
    }

    function genItems(versions) {
        let content = ""
        const sortedVersions = {}
        Object.keys(versions).sort().forEach(key => {
            sortedVersions[key] = versions[key]
        })
        for (const branch in sortedVersions) {
            content += `
        <li class="Box-row px-3 py-1 mt-0">
            <h4 class="d-flex flex-items-center px-1 color-fg-default text-bold no-underline">${branch}</h4>
            <div class="d-flex flex-wrap">`
            content += `<span class="Button--small px-1 m-1 State State--closed d-flex flex-items-center" style="font-size: small;">${sortedVersions[branch]}</span>`
            content += `
            </div>
        </li>`
        }
        return content
    }

    function CreateView() {
        if (document.getElementById(INPUT_TOKEN)) {
            console.warn("elements have been created before")
            return
        }

        const contnet = `
        <details class="position-relative details-overlay details-reset js-codespaces-details-container hx_dropdown-fullscreen">
            <summary class="Button--secondary Button--small Button float-none">
                <span class="Button-content">
                    <span class="Button-label">Version</span>
                </span>
                <span class="Button-visual Button-trailingAction">
                    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16" class="octicon">
                        <path
                            d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z">
                        </path>
                    </svg>
                </span>
            </summary>
            <div class="position-relative">
                <div class="dropdown-menu dropdown-menu-sw p-0 overflow-hidden" style="top:6px;width:400px;max-width: calc(100vw - 320px);">
                    <div class="input-group mt-2 px-3">
                        <input class="form-control input-monospace input-sm color-bg-subtle" placeholder="github token" type="password" id="${INPUT_TOKEN}" />
                        <div class="input-group-button">
                            <span class="btn btn-sm js-clipboard-copy tooltipped-no-delay ClipboardButton" id="${INPUT_TOKEN_BUTTON}" type="button">
                                Save
                            </span>
                        </div>
                    </div>
                    <div class="px-4 mt-3 color-fg-default text-bold no-underline" id="${LOADING}">
                        Loading...
                    </div>
                    <ul class="list-style-none" id="${VERSION_LIST}" style="display: none; max-height: calc(100vh - 200px); overflow-y: auto;"></ul>
                    <div class="px-3 mb-1 mt-2">
                        <div class="position-relative width-fit d-inline-block">
                            <button class="btn btn-primary BtnGroup-item border-right-0 js-toggle-hidden rounded-2 width-fit" id="${REFRESH_BUTTON}">
                                Refresh
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </details>`
        const versionButton = document.createElement("div")
        versionButton.classList.add(BROTHER_CLASS)
        versionButton.innerHTML = contnet
        document.querySelector(PARENT_ELEMENT).appendChild(versionButton)
        const loadingIndicator = document.getElementById(LOADING)
        const versionList = document.getElementById(VERSION_LIST)
        document.getElementById(INPUT_TOKEN_BUTTON).addEventListener("click", (e) => {
            const token = document.getElementById(INPUT_TOKEN).value
            localStorage.setItem(GITHUB_TOKEN, token)
            const prev = e.target.innerHTML
            e.target.innerHTML = `
                <svg height="16" viewBox="0 0 16 16" version="1.1" width="16" class="octicon octicon-check js-clipboard-check-icon color-fg-success d-inline-block">
                    <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path>
                </svg>`
            setTimeout(() => {
                e.target.innerHTML = prev
            }, 2000)
        })
        document.getElementById(REFRESH_BUTTON).addEventListener("click", () => {
            loadingIndicator.style.display = 'block'
            loadingIndicator.innerText = 'Loading...'
            versionList.style.display = 'none'
            versionList.innerHTML = ""
            getReleaseVersion(true).then(versions => {
                const items = genItems(versions)
                if (items) {
                    versionList.innerHTML = items
                } else {
                    versionList.innerHTML = `<li class="px-4 mt-3 text-bold">Not found release branch</li>`
                }
                loadingIndicator.style.display = 'none'
                versionList.style.display = 'block'
            }).catch(err => {
                console.error("meet error when check release version\n", err)
                loadingIndicator.innerText = err.message
            })
        })
    }

    function proxy(fn) {
        const handler = {
            apply: (target, thisArg, argumentsList) => {
                window.dispatchEvent(new CustomEvent(EVENT_TYPE))
                return target.apply(thisArg, argumentsList)
            }
        }
        history.replaceState = new Proxy(history.replaceState, handler)
        window.addEventListener(EVENT_TYPE, fn)
    }

    function start() {
        CreateView()
        getReleaseVersion().then(versions => {
            const loadingIndicator = document.getElementById(LOADING)
            const versionList = document.getElementById(VERSION_LIST)
            if (loadingIndicator == null || versionList == null) {
                return
            }
            const items = genItems(versions)
            if (items) {
                versionList.innerHTML = items
            } else {
                versionList.innerHTML = `<li class="px-4 mt-3 text-bold">Not found release branch</li>`
            }
            loadingIndicator.style.display = 'none'
            versionList.style.display = 'block'
        }).catch(err => {
            console.error("meet error when check release version\n", err)
            document.getElementById(LOADING).innerText = err.message
        })
    }

    if (PULL_REG.test(window.location.pathname)) {
        start()
    }
    proxy(() => {
        if (PULL_REG.test(window.location.pathname)) {
            const interval = setInterval(() => {
                if (document.querySelector(PARENT_ELEMENT)) {
                    clearInterval(interval)
                    start()
                }
            }, TIME_INTERVAL)
        }
    })
})();
