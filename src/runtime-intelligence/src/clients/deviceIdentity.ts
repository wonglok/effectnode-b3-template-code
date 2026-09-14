import { v4 as uuidv4 } from 'uuid'
import type { EditorIdentity } from '../protocol'

/**
 * Who this tab is.
 *
 * Queries fan out to every connected editor and come back labelled, so the
 * server has to be able to name each one — "iOS · Safari · /production" rather
 * than an opaque socket id — and address a single one with `?editor=`.
 *
 * `readEnvironment` lives here rather than beside its only other caller
 * (`collectScenePerformance`) so the label and the `runtime.environment` field
 * are derived from one definition and cannot drift apart.
 */

/** The `NavigatorUAData` fields that can be read synchronously. */
type UserAgentDataLike = {
    brands?: { brand: string; version: string }[]
    mobile?: boolean
    platform?: string
}

/**
 * Browser and OS identity for the tab that answered.
 *
 * Frame timings only mean something alongside the machine that produced them —
 * 16.7 ms is comfortable on an integrated GPU and near the limit on a discrete
 * one — so the environment rides with the measurement rather than being a
 * separate request whose answer could come from a different editor tab.
 */
export type RuntimeEnvironment = {
    /** `navigator.userAgent`, verbatim. Always present. */
    userAgent: string | null
    /**
     * `navigator.userAgentData` (User-Agent Client Hints), reduced to its
     * low-entropy fields. Chromium-only — `null` in Firefox and Safari. The
     * high-entropy hints (`architecture`, `platformVersion`, `fullVersionList`)
     * are async and deliberately not read here.
     */
    userAgentData: {
        brands: { brand: string; version: string }[]
        mobile: boolean | null
        platform: string | null
    } | null
}

function navigatorOf(): Navigator | null {
    // Guarded so callers stay usable outside a browser context.
    return typeof navigator === 'undefined' ? null : navigator
}

function userAgentDataOf(nav: Navigator | null): UserAgentDataLike | undefined {
    return (nav as unknown as { userAgentData?: UserAgentDataLike } | null)?.userAgentData
}

export function readEnvironment(): RuntimeEnvironment {
    const nav = navigatorOf()
    const uaData = userAgentDataOf(nav)
    return {
        userAgent: nav?.userAgent ?? null,
        userAgentData: uaData
            ? {
                  // Copied field-by-field: `brands` is a FrozenArray of brand
                  // objects, and the reply crosses a socket as plain data.
                  brands: (uaData.brands ?? []).map((b) => ({ brand: b.brand, version: b.version })),
                  mobile: uaData.mobile ?? null,
                  platform: uaData.platform ?? null,
              }
            : null,
    }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const ID_STORAGE_KEY = 'runtime-intelligence:editor-id'

/**
 * A tab id that survives a reload of *this* tab.
 *
 * `sessionStorage` is the right home for it: it is scoped per browsing context,
 * so two tabs get two ids, and unlike a module-level constant it is not reset
 * every time Vite re-evaluates this module on HMR — otherwise a `?editor=`
 * target captured a moment ago would stop resolving mid-session.
 *
 * Ids come from the `uuid` package rather than a bare `crypto.randomUUID()`,
 * which is `undefined` outside a secure context — that is a phone hitting the
 * dev server over plain `http://192.168.x.x`, exactly the device this feature
 * exists for. `uuid`'s `v4()` prefers `crypto.randomUUID` where it exists and
 * otherwise falls back to `crypto.getRandomValues`, which carries no such
 * restriction, so the same call site is safe in both.
 */
function persistentTabId(): string {
    try {
        const existing = sessionStorage.getItem(ID_STORAGE_KEY)
        if (existing) return existing
        const created = uuidv4()
        sessionStorage.setItem(ID_STORAGE_KEY, created)
        return created
    } catch {
        // Storage access can throw outright (blocked storage, some private
        // modes). Losing the stable id is a far smaller problem than losing the
        // editor, so fall back to a per-call one.
        return uuidv4()
    }
}

/**
 * Fresh on every real page load, stable across HMR.
 *
 * A duplicated tab copies `sessionStorage`, so both tabs would otherwise present
 * the same `id` and become indistinguishable. Hanging this off `window` rather
 * than module scope is what keeps it stable through HMR — the module is
 * re-evaluated, the window is not.
 */
function perLoadId(): string {
    const scope = typeof window === 'undefined' ? null : (window as unknown as { __riLoadId?: string })
    if (!scope) return uuidv4()
    if (!scope.__riLoadId) scope.__riLoadId = uuidv4()
    return scope.__riLoadId
}

/** `"macOS"`, `"iOS"`, `"Android"`, … — UA-CH when present, else parsed. */
function describePlatform(nav: Navigator | null, uaData: UserAgentDataLike | undefined): string {
    if (uaData?.platform) return uaData.platform
    const ua = nav?.userAgent ?? ''
    if (/iPhone|iPad|iPod/.test(ua)) return 'iOS'
    if (/Android/.test(ua)) return 'Android'
    if (/Macintosh|Mac OS X/.test(ua)) return 'macOS'
    if (/Windows/.test(ua)) return 'Windows'
    if (/Linux/.test(ua)) return 'Linux'
    return 'Unknown'
}

/**
 * `"Chrome"`, `"Safari"`, `"Firefox"`, … — parsed from the UA string.
 *
 * Order matters: Chrome's UA also contains `Safari/`, and Edge's contains both
 * `Chrome/` and `Safari/`, so the more specific product token has to be tested
 * first. iOS browsers carry their own tokens (`CriOS`, `FxiOS`, `EdgiOS`)
 * because they are all WebKit underneath.
 */
function describeBrowser(nav: Navigator | null, uaData: UserAgentDataLike | undefined): string {
    const ua = nav?.userAgent ?? ''
    if (/EdgiOS|Edg\//.test(ua)) return 'Edge'
    if (/OPR\/|Opera/.test(ua)) return 'Opera'
    if (/FxiOS|Firefox\//.test(ua)) return 'Firefox'
    if (/CriOS|Chrome\/|Chromium\//.test(ua)) return 'Chrome'
    if (/Safari\//.test(ua)) return 'Safari'
    return uaData?.brands?.[0]?.brand ?? 'Unknown'
}

/** Read at call time, never cached — a rotated phone or a resized window
 *  should report the viewport it actually has when it answers. */
export function getEditorIdentity(): EditorIdentity {
    const nav = navigatorOf()
    const uaData = userAgentDataOf(nav)
    const platform = describePlatform(nav, uaData)
    const browser = describeBrowser(nav, uaData)
    const page = typeof location === 'undefined' ? '/' : location.pathname

    return {
        id: persistentTabId(),
        loadId: perLoadId(),
        label: `${platform} · ${browser} · ${page}`,
        platform,
        browser,
        page,
        viewport: {
            width: typeof window === 'undefined' ? 0 : window.innerWidth,
            height: typeof window === 'undefined' ? 0 : window.innerHeight,
        },
        devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
        userAgent: nav?.userAgent ?? '',
    }
}
