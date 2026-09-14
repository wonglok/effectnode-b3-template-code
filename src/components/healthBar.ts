/**
 * A small floating health bar, one per character.
 *
 * A `THREE.Sprite`, so it billboards for free — sprites are rendered facing the
 * camera by the renderer, which means this module needs no camera reference and
 * no per-frame quaternion maths. (The hand-rolled billboard in `npcProps.
 * calibrateGun` exists because a *gun* has to stay aligned to a hand bone; a bar
 * has no such constraint, and repeating that maths here would be pure cost.)
 *
 * ## One sprite, not two quads
 *
 * The obvious build is a background quad plus a fill quad whose `scale.x` tracks
 * the fraction. That is two draw calls per character. Drawing the bar into a
 * canvas instead costs one texture upload *when the value changes* — ten uploads
 * across a whole life, since damage arrives ten times — and one draw call per
 * character for the entire time it is on screen. With seven characters that is
 * seven draw calls rather than fourteen, and the bar gets rounded ends and a
 * border for free, which is fiddly geometry otherwise.
 *
 * ## It reads as a HUD element that happens to live in the scene
 *
 * `depthTest: false` plus a late `renderOrder`, so a bar is never sliced in half
 * by scenery it is not really in front of, and `fog: false` so distance does not
 * tint it like a prop. A half-drawn health bar is worse than no health bar.
 */

import * as THREE from 'three'

/**
 * Canvas resolution. Deliberately small: the bar is about a metre wide in world
 * space and is normally viewed from several metres away, so this is already
 * sharper than it will ever be seen. It is redrawn only on a damage event.
 */
const CANVAS_W = 128
const CANVAS_H = 24

/** World size of the bar, in metres. */
const BAR_WIDTH = 1.05
const BAR_HEIGHT = BAR_WIDTH * (CANVAS_H / CANVAS_W)

/**
 * Where the bar sits above the character's feet, in metres.
 *
 * The bodies are ~1.7 m, so this clears the head with a little air. Set on the
 * caller's group, which only ever yaws — a rotation about Y cannot move a purely
 * vertical offset, so the bar stays directly overhead however the character
 * turns.
 */
export const BAR_HEIGHT_ABOVE = 2.05

const BORDER = '#0b131b'
const TRACK = '#2b3743'
/** Tiers, so the bar reads at a glance without needing the number. */
const HEALTHY = '#81d8d0'
const HURT = '#f0b429'
const CRITICAL = '#e5484d'

export interface HealthBar {
    /** Add to the character's group and place at {@link BAR_HEIGHT_ABOVE}. */
    readonly sprite: THREE.Sprite
    /**
     * Redraw for a new value. Cheap, but it does re-upload the texture, so
     * callers should only call it when the numbers actually change.
     */
    setFraction(fraction: number, hp: number, max: number): void
    /** Hide/show — a downed character shows no bar. */
    setVisible(visible: boolean): void
    dispose(): void
}

export function createHealthBar(): HealthBar {
    const canvas = document.createElement('canvas')
    canvas.width = CANVAS_W
    canvas.height = CANVAS_H
    const ctx = canvas.getContext('2d')

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    // The bar is a flat, near-field graphic; mipmaps would only blur the text-
    // like edges, and there is no minification to speak of at this size.
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false

    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
    })

    const sprite = new THREE.Sprite(material)
    sprite.scale.set(BAR_WIDTH, BAR_HEIGHT, 1)
    sprite.renderOrder = 999

    // Redraw only on change — the whole point of the canvas approach.
    let lastKey = ''

    /**
     * Paint the bar. `hp`/`max` are unused for the pixels today but kept in the
     * signature so a number can be drawn in later without touching callers.
     */
    const paint = (fraction: number, hp: number, max: number) => {
        void hp
        void max
        if (!ctx) return
        const f = Math.max(0, Math.min(1, fraction))

        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)

        // Dark surround, so the bar keeps its shape over a bright background.
        ctx.beginPath()
        ctx.roundRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1, CANVAS_H / 2)
        ctx.fillStyle = BORDER
        ctx.fill()

        const inset = 3
        const trackW = CANVAS_W - inset * 2
        const trackH = CANVAS_H - inset * 2
        ctx.beginPath()
        ctx.roundRect(inset, inset, trackW, trackH, trackH / 2)
        ctx.fillStyle = TRACK
        ctx.fill()

        if (f > 0) {
            // Clipped to the track's pill shape and filled as a plain rectangle,
            // rather than rounding the fill itself. Rounding the fill would need
            // a minimum width of one radius to stay drawable, which reads as a
            // healthy sliver when the character is nearly dead — the exact
            // opposite of what a low bar has to communicate.
            ctx.save()
            ctx.beginPath()
            ctx.roundRect(inset, inset, trackW, trackH, trackH / 2)
            ctx.clip()
            ctx.fillStyle = f > 0.5 ? HEALTHY : f > 0.25 ? HURT : CRITICAL
            ctx.fillRect(inset, inset, trackW * f, trackH)
            ctx.restore()
        }

        texture.needsUpdate = true
    }

    return {
        sprite,
        setFraction(fraction, hp, max) {
            // Skip the re-upload when nothing moved: the frame loop may call this
            // every tick, and a texture upload per frame per character would be a
            // real cost for no visible change.
            const key = `${fraction}|${hp}|${max}`
            if (key === lastKey) return
            lastKey = key
            paint(fraction, hp, max)
        },
        setVisible(visible) {
            sprite.visible = visible
        },
        dispose() {
            material.dispose()
            texture.dispose()
        },
    }
}
