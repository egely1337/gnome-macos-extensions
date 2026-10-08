import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const GENIE_DURATION = 400;
const OPEN_DURATION = 260;
const CLOSE_DURATION = 200;

const OPEN_SCALE = 0.88;
const CLOSE_SCALE = 0.9;

// Mesh resolution of the genie deformation. The cross axis is linear per
// row, so it needs far fewer tiles than the axis the window flows along.
const MAIN_TILES = 48;
const CROSS_TILES = 8;

// Size of the fake dock icon used when no dock reports icon geometry.
const FALLBACK_ICON_SIZE = 48;

const MINIMIZE_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.DIALOG,
];
const MAP_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

const Side = {BOTTOM: 0, TOP: 1, RIGHT: 2, LEFT: 3};

const clamp01 = x => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = x => x * x * (3 - 2 * x);
const easeInOut = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const easeIn = x => x * x * x;

// Stand-in for the shell's MetaShellWm when we let it do its bookkeeping
// for a window whose animation we run ourselves.
const DETACHED_SHELLWM = {
    completed_map() {},
    completed_destroy() {},
};

function scaledDuration(ms) {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return 0;
    return Math.max(1, Math.round(ms * settings.slow_down_factor));
}

function sideOf(win, icon) {
    if (icon.y >= win.y + win.height)
        return Side.BOTTOM;
    if (icon.y + icon.height <= win.y)
        return Side.TOP;
    if (icon.x >= win.x + win.width)
        return Side.RIGHT;
    if (icon.x + icon.width <= win.x)
        return Side.LEFT;

    // Icon overlaps the window (e.g. a dock drawn over a maximized window):
    // flow toward whichever edge the icon sits closest to.
    const dx = (icon.x + icon.width / 2 - (win.x + win.width / 2)) / win.width;
    const dy = (icon.y + icon.height / 2 - (win.y + win.height / 2)) / win.height;
    if (Math.abs(dy) >= Math.abs(dx))
        return dy >= 0 ? Side.BOTTOM : Side.TOP;
    return dx >= 0 ? Side.RIGHT : Side.LEFT;
}

const GenieEffect = GObject.registerClass({
    GTypeName: 'MacAnimGenieEffect',
}, class GenieEffect extends Clutter.DeformEffect {
    // win and icon are rectangles in stage coordinates.
    _init(win, icon) {
        super._init();

        this.progress = 0;
        this._win = win;
        this._side = sideOf(win, icon);

        const horizontal = this._side === Side.LEFT || this._side === Side.RIGHT;
        if (horizontal)
            this.set_n_tiles(MAIN_TILES, CROSS_TILES);
        else
            this.set_n_tiles(CROSS_TILES, MAIN_TILES);

        // Icon relative to the window's top-left corner.
        const rx = icon.x - win.x;
        const ry = icon.y - win.y;

        this._bounds = Clutter.ActorBox.new(
            Math.min(0, rx), Math.min(0, ry),
            Math.max(win.width, rx + icon.width), Math.max(win.height, ry + icon.height));

        // Express everything in a canonical frame where the window flows
        // along +main into the icon, and cross is the perpendicular axis.
        switch (this._side) {
        case Side.BOTTOM:
            this._lenMain = win.height;
            this._lenCross = win.width;
            this._t0 = ry;
            this._t1 = ry + icon.height;
            this._c0 = rx;
            this._c1 = rx + icon.width;
            break;
        case Side.TOP:
            this._lenMain = win.height;
            this._lenCross = win.width;
            this._t0 = win.height - (ry + icon.height);
            this._t1 = win.height - ry;
            this._c0 = rx;
            this._c1 = rx + icon.width;
            break;
        case Side.RIGHT:
            this._lenMain = win.width;
            this._lenCross = win.height;
            this._t0 = rx;
            this._t1 = rx + icon.width;
            this._c0 = ry;
            this._c1 = ry + icon.height;
            break;
        case Side.LEFT:
            this._lenMain = win.width;
            this._lenCross = win.height;
            this._t0 = win.width - (rx + icon.width);
            this._t1 = win.width - rx;
            this._c0 = ry;
            this._c1 = ry + icon.height;
            break;
        }
    }

    setProgress(progress) {
        this.progress = progress;
        this.invalidate();
    }

    vfunc_modify_paint_volume(volume) {
        // Make the stage repaint the whole path down to the icon, since the
        // deformed window is drawn outside its own allocation.
        volume.union_box(this._bounds);
        return true;
    }

    vfunc_deform_vertex(width, height, vertex) {
        const p = this.progress;
        const squeeze = easeInOut(clamp01(p / 0.45));
        const slide = easeIn(clamp01((p - 0.15) / 0.85));

        let u, v;
        switch (this._side) {
        case Side.BOTTOM: u = vertex.tx; v = vertex.ty; break;
        case Side.TOP: u = vertex.tx; v = 1 - vertex.ty; break;
        case Side.RIGHT: u = vertex.ty; v = vertex.tx; break;
        case Side.LEFT: u = vertex.ty; v = 1 - vertex.tx; break;
        }

        // Slide along the main axis, compressing the window into the icon.
        const main = lerp(v * this._lenMain, this._t0 + v * (this._t1 - this._t0), slide);

        // The funnel narrows smoothly from the window's far edge (full width)
        // down to the icon's near edge (icon width).
        const funnel = this._t0 > 1 ? smoothstep(clamp01(main / this._t0)) : 1;
        const f = funnel * squeeze;
        const cross = lerp(u * this._lenCross, this._c0 + u * (this._c1 - this._c0), f);

        let x, y;
        switch (this._side) {
        case Side.BOTTOM: x = cross; y = main; break;
        case Side.TOP: x = cross; y = this._lenMain - main; break;
        case Side.RIGHT: x = main; y = cross; break;
        case Side.LEFT: x = this._lenMain - main; y = cross; break;
        }

        // The offscreen target may be in physical pixels on HiDPI setups.
        vertex.x = x * width / this._win.width;
        vertex.y = y * height / this._win.height;
    }
});

export default class MacosAnimationsExtension extends Extension {
    enable() {
        this._wm = Main.wm;
        this._shellwm = global.window_manager;
        this._running = new Map();
        this._forceNoAnimation = false;

        // Main.wm connected its handlers with bound methods at startup, so
        // they cannot be swapped out; block them and handle the signals here.
        this._blocked = [];
        for (const signal of ['minimize', 'unminimize', 'map', 'destroy']) {
            const id = GObject.signal_handler_find(this._shellwm, {signalId: signal});
            if (id) {
                GObject.signal_handler_block(this._shellwm, id);
                this._blocked.push(id);
            }
        }

        this._origShouldAnimateActor = this._wm._shouldAnimateActor;
        this._wm._shouldAnimateActor = (actor, types) =>
            !this._forceNoAnimation && this._origShouldAnimateActor.call(this._wm, actor, types);

        this._shellwm.connectObject(
            'minimize', (shellwm, actor) => this._onMinimize(shellwm, actor),
            'unminimize', (shellwm, actor) => this._onUnminimize(shellwm, actor),
            'map', (shellwm, actor) => this._onMap(shellwm, actor),
            'destroy', (shellwm, actor) => this._onDestroy(shellwm, actor),
            'kill-window-effects', (shellwm, actor) => this._finish(actor),
            this);
    }

    disable() {
        this._shellwm.disconnectObject(this);

        for (const actor of [...this._running.keys()])
            this._finish(actor);

        this._wm._shouldAnimateActor = this._origShouldAnimateActor;
        for (const id of this._blocked)
            GObject.signal_handler_unblock(this._shellwm, id);

        this._blocked = null;
        this._running = null;
        this._origShouldAnimateActor = null;
        this._shellwm = null;
        this._wm = null;
    }

    _shouldAnimate(actor, types) {
        return this._origShouldAnimateActor.call(this._wm, actor, types);
    }

    _windowType(actor) {
        return this._wm._getAnimationWindowType?.(actor) ?? actor.meta_window.get_window_type();
    }

    // Run one of Main.wm's own handlers, optionally with animation forced off.
    _callShell(method, shellwm, actor, noAnimation) {
        this._forceNoAnimation = noAnimation;
        try {
            this._wm[method](shellwm, actor);
        } finally {
            this._forceNoAnimation = false;
        }
    }

    _track(actor, finish) {
        let done = false;
        const wrapped = () => {
            if (done)
                return;
            done = true;
            this._running.delete(actor);
            actor.disconnectObject(this);
            finish();
        };
        this._running.set(actor, wrapped);
        // If the actor goes away mid-animation, just drop our state.
        actor.connectObject('destroy', () => {
            done = true;
            this._running.delete(actor);
        }, this);
        return wrapped;
    }

    _finish(actor) {
        this._running?.get(actor)?.();
    }

    _iconRect(actor) {
        const window = actor.meta_window;
        const [ok, geom] = window.get_icon_geometry();
        if (ok && geom.width > 0 && geom.height > 0)
            return {x: geom.x, y: geom.y, width: geom.width, height: geom.height};

        // No dock reported where the app lives: aim at the bottom center of
        // the monitor, where the macOS dock would be.
        const monitor = Main.layoutManager.monitors[window.get_monitor()] ??
            Main.layoutManager.primaryMonitor;
        return {
            x: monitor.x + (monitor.width - FALLBACK_ICON_SIZE) / 2,
            y: monitor.y + monitor.height - FALLBACK_ICON_SIZE,
            width: FALLBACK_ICON_SIZE,
            height: FALLBACK_ICON_SIZE,
        };
    }

    _genie(actor, minimizing, onComplete) {
        const duration = scaledDuration(GENIE_DURATION);
        if (duration === 0 || actor.width < 1 || actor.height < 1) {
            if (!minimizing)
                actor.show();
            onComplete();
            return;
        }

        const rect = actor.meta_window.get_buffer_rect();
        if (!minimizing)
            actor.set_position(rect.x, rect.y);
        const win = {x: rect.x, y: rect.y, width: actor.width, height: actor.height};

        const effect = new GenieEffect(win, this._iconRect(actor));
        const progressAt = t => minimizing ? t : 1 - t;
        effect.progress = progressAt(0);
        actor.add_effect_with_name('macos-genie', effect);
        if (!minimizing)
            actor.show();

        const timeline = new Clutter.Timeline({actor, duration});
        const finish = this._track(actor, () => {
            timeline.disconnectObject(this);
            timeline.stop();
            actor.remove_effect(effect);
            onComplete();
        });

        timeline.connectObject(
            'new-frame', () => effect.setProgress(progressAt(timeline.get_progress())),
            'completed', () => finish(),
            this);
        timeline.start();
    }

    _onMinimize(shellwm, actor) {
        if (!this._shouldAnimate(actor, MINIMIZE_TYPES)) {
            shellwm.completed_minimize(actor);
            return;
        }
        this._genie(actor, true, () => shellwm.completed_minimize(actor));
    }

    _onUnminimize(shellwm, actor) {
        if (!this._shouldAnimate(actor, MINIMIZE_TYPES)) {
            shellwm.completed_unminimize(actor);
            return;
        }
        this._genie(actor, false, () => shellwm.completed_unminimize(actor));
    }

    _onMap(shellwm, actor) {
        const animate = this._shouldAnimate(actor, MAP_TYPES);
        if (!animate || this._windowType(actor) !== Meta.WindowType.NORMAL) {
            // Dialogs keep the shell's own slide animation.
            this._callShell('_mapWindow', shellwm, actor, !animate);
            return;
        }

        // Let the shell do its bookkeeping (dimming, type tracking) without
        // animating or completing the map, then run our own animation.
        this._callShell('_mapWindow', DETACHED_SHELLWM, actor, true);

        actor.set_pivot_point(0.5, 0.5);
        actor.set_scale(OPEN_SCALE, OPEN_SCALE);
        actor.opacity = 0;
        actor.show();

        const finish = this._track(actor, () => {
            actor.remove_all_transitions();
            actor.set_scale(1, 1);
            actor.opacity = 255;
            actor.set_pivot_point(0, 0);
            shellwm.completed_map(actor);
        });

        actor.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: OPEN_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => finish(),
        });
    }

    _onDestroy(shellwm, actor) {
        const animate = this._shouldAnimate(actor, MAP_TYPES);
        if (!animate || this._windowType(actor) !== Meta.WindowType.NORMAL) {
            this._callShell('_destroyWindow', shellwm, actor, !animate);
            return;
        }

        this._callShell('_destroyWindow', DETACHED_SHELLWM, actor, true);

        actor.set_pivot_point(0.5, 0.5);
        const finish = this._track(actor, () => {
            actor.remove_all_transitions();
            shellwm.completed_destroy(actor);
        });

        actor.ease({
            opacity: 0,
            scale_x: CLOSE_SCALE,
            scale_y: CLOSE_SCALE,
            duration: CLOSE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => finish(),
        });
    }
}
