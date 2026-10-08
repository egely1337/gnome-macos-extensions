import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

import {Launchpad} from './launchpad.js';

const ICON_SIZE = 60;
// While a maximized window shares the screen, the dock steps back to give
// it room.
const COMPACT_ICON_SIZE = 44;
// Never shrink below this when squeezing many icons onto a narrow screen.
const MIN_ICON_SIZE = 24;
const RESIZE_DURATION = 380;
const MAGNIFICATION = 1.85;
// How far (in resting icon widths) from the pointer magnification reaches.
const MAGNIFY_RADIUS = 2.6;
const MAGNIFY_DURATION = 200;
// Slots grow in and shrink out when apps, windows or separators come and go.
const PRESENCE_DURATION = 300;

const ITEM_PADDING = 3;      // horizontal space on each side of an icon
const DOCK_PADDING = 6;      // inner padding of the dock background
const DOCK_MARGIN = 8;       // gap between the dock and the screen edge
const DOT_SPACE = 8;         // room under the icons for the running dot
const DOT_SIZE = 5;
const FOCUSED_DOT_WIDTH = 16; // the focused app's dot stretches into a pill
const DOCK_RADIUS = 24;      // at full size; scales with the dock
const SEPARATOR_WIDTH = 1;
const SEPARATOR_SPACE = 17;
const TOOLTIP_GAP = 8;
const TOOLTIP_ARROW = 10;

// The frosted glass behind the dock: blur, then a vibrancy pass that boosts
// saturation like macOS materials do.
const BLUR_RADIUS = 40;
const GLASS_SATURATION = 1.8;
const GLASS_BRIGHTNESS = 0.95;
// Soft light that follows the pointer across the glass.
const GLOW_RADIUS = 130;
const GLOW_COLOR = [0.55, 0.78, 1.0];
const GLOW_STRENGTH = 1.0;

const PRESS_BRIGHTNESS = -0.3;
const INTRO_DURATION = 650;

const LAUNCHPAD_COLORS = [
    '#ff5f57', '#ffbd2e', '#28c840',
    '#2d9cff', '#a26bfa', '#ff6fae',
    '#36d1c4', '#ff9f43', '#5e7cff',
];

const BOUNCE_HEIGHT = 28;
const BOUNCE_DURATION = 300;
const MAX_BOUNCES = 8;

// Minimized windows sit at the right end of the dock as live previews.
const PREVIEW_FILL = 0.86;      // share of the icon square the preview fills
const PREVIEW_BADGE = 0.42;     // app icon in the corner, relative to the square
const PREVIEW_FADE_DELAY = 320; // let the genie land before the preview shows

const TRASH_URI = 'trash:///';
const TRASH_QUERY_DELAY = 250;

const MAX_ICON = Math.ceil(ICON_SIZE * MAGNIFICATION);
const FULL_DOCK_HEIGHT = ICON_SIZE + DOT_SPACE + 2 * DOCK_PADDING;

const LAUNCHPAD_ID = '::launchpad';
const TRASH_ID = '::trash';
const RUNNING_SEPARATOR_ID = '::separator-running';
const WINDOWS_SEPARATOR_ID = '::separator-windows';

function dockHeight(iconSize) {
    return iconSize + DOT_SPACE + 2 * DOCK_PADDING;
}

function reservedHeight(iconSize) {
    return dockHeight(iconSize) + DOCK_MARGIN;
}

function hoverHeadroom(iconSize) {
    return Math.ceil(iconSize * (MAGNIFICATION - 1)) + 8;
}

function dockRadius(iconSize) {
    return Math.round(DOCK_RADIUS * dockHeight(iconSize) / FULL_DOCK_HEIGHT);
}

function bell(distance, radius) {
    if (distance >= radius)
        return 0;
    return (Math.cos(Math.PI * distance / radius) + 1) / 2;
}

function animationTime(ms) {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return 0;
    return Math.round(ms * settings.slow_down_factor);
}

// Calls onFrame with eased progress (0..1) every frame for ms, then onDone.
// Stopping the returned timeline skips onDone.
function tween(actor, ms, onFrame, onDone) {
    const duration = animationTime(ms);
    if (duration === 0) {
        onFrame(1);
        onDone?.();
        return null;
    }
    const timeline = new Clutter.Timeline({actor, duration});
    timeline.connect('new-frame', () => onFrame(1 - (1 - timeline.get_progress()) ** 3));
    timeline.connect('completed', () => {
        onFrame(1);
        onDone?.();
    });
    timeline.start();
    return timeline;
}

function appWindows(app) {
    return app.get_windows().filter(w => !w.skip_taskbar);
}

function windowId(window) {
    return `::window-${window.get_stable_sequence()}`;
}

// Rounds off the corners of whatever it is applied to, and gives it the
// saturated "vibrancy" look of macOS materials. Shell.BlurEffect can only
// blur rectangles, so this masks the blurred glass to the dock's shape.
// On top of that it lights the glass: a specular sheen along the top, a
// bright rim where light catches the edge, and a glow under the pointer.
const GlassEffect = GObject.registerClass(
class GlassEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._sizeLocation = this.get_uniform_location('size');
        this._radiusLocation = this.get_uniform_location('radius');
        this._pointerLocation = this.get_uniform_location('pointer');
        this._glowLocation = this.get_uniform_location('glow');
        this.set_uniform_float(this.get_uniform_location('saturation'), 1, [GLASS_SATURATION]);
        this.set_uniform_float(this.get_uniform_location('brightness'), 1, [GLASS_BRIGHTNESS]);
        this.set_uniform_float(this.get_uniform_location('glow_radius'), 1, [GLOW_RADIUS]);
        this.set_uniform_float(this.get_uniform_location('glow_color'), 3, GLOW_COLOR);
        this.setRadius(DOCK_RADIUS);
        this.setPointer(0, 0, 0);
    }

    setSize(width, height) {
        this.set_uniform_float(this._sizeLocation, 2, [width, height]);
    }

    setRadius(radius) {
        this.set_uniform_float(this._radiusLocation, 1, [radius]);
    }

    // Pointer position in the glass's coordinates; strength 0 turns it off.
    setPointer(x, y, strength) {
        this.set_uniform_float(this._pointerLocation, 2, [x, y]);
        this.set_uniform_float(this._glowLocation, 1, [strength * GLOW_STRENGTH]);
        this.queue_repaint();
    }

    vfunc_build_pipeline() {
        const declarations = `
            uniform vec2 size;
            uniform float radius;
            uniform float saturation;
            uniform float brightness;
            uniform vec2 pointer;
            uniform float glow;
            uniform float glow_radius;
            uniform vec3 glow_color;

            float rounded_rect_distance(vec2 p) {
                vec2 q = abs(p - size * 0.5) - (size * 0.5 - radius);
                return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
            }
        `;
        const code = `
            vec2 p = cogl_tex_coord_in[0].xy * size;
            float d = rounded_rect_distance(p);
            float t = p.y / size.y;

            vec3 c = cogl_color_out.rgb;
            float gray = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c = mix(vec3(gray), c, saturation) * brightness;

            c += vec3(0.12) * pow(1.0 - t, 3.0);
            c += vec3(0.14) * (1.0 - smoothstep(0.0, 2.0, -d)) * (1.0 - 0.75 * t);

            vec2 dp = p - pointer;
            c += glow_color * glow * exp(-dot(dp, dp) / (glow_radius * glow_radius));

            float mask = clamp(0.5 - d, 0.0, 1.0);
            cogl_color_out = vec4(clamp(c, 0.0, 1.0), cogl_color_out.a) * mask;
        `;
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, false);
    }
});

// macOS's Launchpad icon: a grey squircle with a grid of coloured tiles.
function createLaunchpadIcon() {
    const box = new St.Widget({width: MAX_ICON, height: MAX_ICON});

    // App icons leave ~9% transparent margin around their artwork.
    const size = Math.round(MAX_ICON * 0.82);
    const inset = Math.round((MAX_ICON - size) / 2);
    const tile = new St.Widget({
        style_class: 'macos-dock-launchpad',
        style: `border-radius: ${Math.round(size * 0.225)}px;`,
        x: inset,
        y: inset,
        width: size,
        height: size,
    });
    box.add_child(tile);

    const cell = Math.round(size * 0.19);
    const gap = Math.round(size * 0.075);
    const start = Math.round((size - 3 * cell - 2 * gap) / 2);
    LAUNCHPAD_COLORS.forEach((color, i) => {
        tile.add_child(new St.Widget({
            style: `background-color: ${color}; border-radius: ${Math.round(cell * 0.3)}px;`,
            x: start + (i % 3) * (cell + gap),
            y: start + Math.floor(i / 3) * (cell + gap),
            width: cell,
            height: cell,
        }));
    });
    return box;
}

// A minimized window shrunk into an icon-sized square: a live copy of the
// window with a shadow under it and its app's icon in the corner.
function createWindowPreview(window, app) {
    const box = new St.Widget({width: MAX_ICON, height: MAX_ICON});

    const frame = window.get_frame_rect();
    const buffer = window.get_buffer_rect();
    const scale = MAX_ICON * PREVIEW_FILL / Math.max(frame.width, frame.height, 1);
    const width = Math.max(1, Math.round(frame.width * scale));
    const height = Math.max(1, Math.round(frame.height * scale));
    const x = Math.round((MAX_ICON - width) / 2);
    const y = Math.round((MAX_ICON - height) / 2);

    box.add_child(new St.Widget({
        style_class: 'macos-dock-window-shadow',
        x, y, width, height,
    }));

    // The window actor includes client-side shadows; clip them off so only
    // the window itself shows.
    const clip = new Clutter.Actor({clip_to_allocation: true, x, y, width, height});
    const source = window.get_compositor_private();
    if (source) {
        clip.add_child(new Clutter.Clone({
            source,
            x: Math.round((buffer.x - frame.x) * scale),
            y: Math.round((buffer.y - frame.y) * scale),
            scale_x: scale,
            scale_y: scale,
        }));
    }
    box.add_child(clip);

    if (app) {
        const size = Math.round(MAX_ICON * PREVIEW_BADGE);
        const badge = app.create_icon_texture(size);
        badge.set_size(size, size);
        badge.set_position(MAX_ICON - size, MAX_ICON - size);
        box.add_child(badge);
    }
    return box;
}

// Anything that takes up a slot in the dock. A slot's presence runs from 0
// (no room at all) to 1 (fully there), so the dock grows and shrinks
// smoothly instead of jumping when its contents change.
class DockEntry {
    constructor(dock, id) {
        this.dock = dock;
        this.id = id;
        this.presence = 1;
        this.targetPresence = 1;
        this.leaving = false;
        this._presenceTimeline = null;
    }

    // Whether this is an icon (magnifies, has a tooltip) or a separator.
    get isIcon() {
        return false;
    }

    setPresence(target, animate, onDone) {
        this._presenceTimeline?.stop();
        this._presenceTimeline = null;
        this.targetPresence = target;

        const from = this.presence;
        if (!animate || from === target) {
            this.presence = target;
            this.dock.queueRelayout();
            onDone?.();
            return;
        }
        this._presenceTimeline = tween(this.dock.actor, PRESENCE_DURATION, t => {
            this.presence = from + (target - from) * t;
            this.dock.queueRelayout();
        }, () => {
            this._presenceTimeline = null;
            onDone?.();
        });
    }

    appear(animate) {
        this.presence = 0;
        this.setPresence(1, animate);
    }

    leave(onDone) {
        this.leaving = true;
        this.actor.reactive = false;
        this.setPresence(0, true, onDone);
    }

    revive() {
        this.leaving = false;
        this.actor.reactive = this.isIcon;
        this.setPresence(1, true);
    }

    stopAnimations() {
        this._presenceTimeline?.stop();
        this._presenceTimeline = null;
    }

    destroy() {
        this.stopAnimations();
        this.actor.destroy();
    }
}

class SeparatorEntry extends DockEntry {
    constructor(dock, id) {
        super(dock, id);
        this.actor = new St.Widget({
            style_class: 'macos-dock-separator',
            width: SEPARATOR_WIDTH,
        });
    }

    get restWidth() {
        return SEPARATOR_SPACE;
    }

    layout(x, dockTop, width, height) {
        const full = height - 2 * DOCK_PADDING - 12;
        const lineHeight = Math.max(0, Math.round(full * this.presence));
        this.actor.set_position(Math.round(x + (width - SEPARATOR_WIDTH) / 2),
            Math.round(dockTop + (height - lineHeight) / 2 - DOT_SPACE / 4));
        this.actor.set_height(lineHeight);
        this.actor.opacity = Math.round(255 * this.presence);
    }
}

// An icon in the dock: hover, press, tooltip, click and menu handling, plus
// the running dot under it.
class DockItem extends DockEntry {
    constructor(dock, id, icon) {
        super(dock, id);
        this.menu = null;
        this._pressedButton = 0;
        this._iconBox = null;

        this.actor = new St.Widget({reactive: true, track_hover: true});
        // AppMenu calls this on its source actor for "New Window" and such.
        this.actor.animateLaunch = () => this.bounce();

        this.icon = icon;
        this.actor.add_child(this.icon);

        // Darkens the icon while it is held down, like macOS does.
        this._pressEffect = new Clutter.BrightnessContrastEffect({enabled: false});
        this._pressEffect.set_brightness(PRESS_BRIGHTNESS);
        this.icon.add_effect(this._pressEffect);

        this._itemWidth = 0;
        this._itemHeight = 0;
        this.dot = new St.Widget({
            style_class: 'macos-dock-dot',
            width: DOT_SIZE,
            height: DOT_SIZE,
            visible: false,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.dot.connect('notify::width', () => this._positionDot());
        this.actor.add_child(this.dot);

        this.actor.connect('notify::hover', () => {
            if (!this.actor.hover)
                this._setPressed(false);
            this.dock.itemHoverChanged(this);
        });
        this.actor.connect('button-press-event', (actor, event) => {
            this._pressedButton = event.get_button();
            if (this._pressedButton === Clutter.BUTTON_PRIMARY)
                this._setPressed(true);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('button-release-event', (actor, event) => {
            this._setPressed(false);
            const button = event.get_button();
            if (button !== this._pressedButton || !this.actor.hover)
                return Clutter.EVENT_STOP;
            this._pressedButton = 0;
            if (button === Clutter.BUTTON_SECONDARY)
                this.popupMenu();
            else
                this.activate(button, event.get_state());
            return Clutter.EVENT_STOP;
        });

        this.actor.connect('destroy', () => this._onDestroy());
    }

    get isIcon() {
        return true;
    }

    get name() {
        return '';
    }

    // Visual geometry of the icon, relative to the dock's hitbox.
    get iconBox() {
        return this._iconBox;
    }

    // Keeps the bounce going while this is true.
    get isStarting() {
        return false;
    }

    _setPressed(pressed) {
        this._pressEffect.enabled = pressed;
    }

    syncFocus() {
    }

    _positionDot() {
        // The dot sits just above the dock's bottom edge, under the icon.
        this.dot.set_position(Math.round((this._itemWidth - this.dot.width) / 2),
            Math.round(this._itemHeight - DOT_SIZE));
    }

    // Lay out the item at x (bottom of the icon row at baseY): its slot is
    // width wide and its icon size pixels square once fully present.
    layout(x, baseY, width, size) {
        const height = size + DOT_SPACE;
        this.actor.set_position(Math.round(x), Math.round(baseY - height));
        this.actor.set_size(Math.max(1, Math.round(width)), Math.round(height));

        // Arriving and leaving icons grow out of / sink into the dock.
        const visual = size * this.presence;
        const iconScale = visual / MAX_ICON;
        this.icon.set_scale(iconScale, iconScale);
        this.icon.set_position(Math.round((width - visual) / 2), Math.round(size - visual));
        this.actor.opacity = Math.round(255 * Math.min(1, this.presence * 1.4));

        this._itemWidth = width;
        this._itemHeight = height;
        this._positionDot();

        this._iconBox = {
            x: x + (width - size) / 2,
            y: baseY - height,
            width: size,
            height: size,
        };
    }

    activate() {
    }

    popupMenu() {
    }

    _setupMenu(menu) {
        this.menu = menu;
        menu.connect('open-state-changed', (m, open) => this.dock.menuStateChanged(this, open));
        Main.uiGroup.add_child(menu.actor);
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
        this._menuManager.addMenu(menu);
    }

    bounce() {
        let count = 0;
        const step = () => {
            this.icon.ease({
                translation_y: -BOUNCE_HEIGHT,
                duration: BOUNCE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this.icon.ease({
                        translation_y: 0,
                        duration: BOUNCE_DURATION,
                        mode: Clutter.AnimationMode.EASE_IN_QUAD,
                        onComplete: () => {
                            count++;
                            if (this.isStarting && count < MAX_BOUNCES)
                                step();
                        },
                    });
                },
            });
        };
        this.icon.remove_transition('translation-y');
        this.icon.translation_y = 0;
        step();
    }

    _onDestroy() {
        this.stopAnimations();
        this.menu?.destroy();
        this.menu = null;
    }
}

class AppItem extends DockItem {
    constructor(dock, app) {
        const icon = app.create_icon_texture(MAX_ICON);
        icon.set_size(MAX_ICON, MAX_ICON);
        super(dock, app.get_id(), icon);
        this.app = app;

        app.connectObject('notify::state', () => this.syncRunning(), this);
        this.syncRunning();
    }

    get name() {
        return this.app.get_name();
    }

    get isStarting() {
        return this.app.state === Shell.AppState.STARTING;
    }

    syncRunning() {
        const running = this.app.state !== Shell.AppState.STOPPED;
        if (running === this.dot.visible)
            return;

        this.dot.remove_all_transitions();
        if (running) {
            // The dot pops in when the app comes up.
            this.dot.set_scale(0, 0);
            this.dot.show();
            this.dot.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 350,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        } else {
            this.dot.ease({
                scale_x: 0,
                scale_y: 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => {
                    if (this.app.state === Shell.AppState.STOPPED)
                        this.dot.hide();
                    this.dot.set_scale(1, 1);
                },
            });
        }
    }

    syncFocus(focusApp) {
        const focused = focusApp === this.app;
        this.dot.ease({
            width: focused ? FOCUSED_DOT_WIDTH : DOT_SIZE,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        if (focused)
            this.dot.add_style_class_name('focused');
        else
            this.dot.remove_style_class_name('focused');
    }

    activate(button, modifiers) {
        const ctrl = (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const wantsNew = button === Clutter.BUTTON_MIDDLE || ctrl;
        const app = this.app;

        if (app.state === Shell.AppState.STOPPED) {
            this.bounce();
            app.activate();
            return;
        }

        if (wantsNew && app.can_open_new_window()) {
            this.bounce();
            app.open_new_window(-1);
            return;
        }

        // Clicking the focused app's icon minimizes its windows on this
        // workspace into the dock, like the dock's "minimize on click".
        const workspace = global.workspace_manager.get_active_workspace();
        const here = appWindows(app).filter(w => w.located_on_workspace(workspace));
        const tracker = Shell.WindowTracker.get_default();
        if (tracker.focus_app === app && here.some(w => !w.minimized)) {
            here.forEach(w => w.minimize());
            return;
        }

        const minimized = here.filter(w => w.minimized);
        if (minimized.length > 0 && minimized.length === here.length) {
            // Bring every minimized window back, most recent on top.
            const sorted = global.display.sort_windows_by_stacking(minimized);
            const time = global.get_current_time();
            sorted.forEach(w => w.unminimize());
            Main.activateWindow(sorted[sorted.length - 1], time);
            return;
        }

        app.activate();
    }

    popupMenu() {
        if (!this.menu) {
            const menu = new AppMenu(this.actor, St.Side.BOTTOM, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            menu.setApp(this.app);
            this._setupMenu(menu);
        }
        this.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _onDestroy() {
        this.app.disconnectObject(this);
        super._onDestroy();
    }
}

class LaunchpadItem extends DockItem {
    constructor(dock) {
        super(dock, LAUNCHPAD_ID, createLaunchpadIcon());
    }

    get name() {
        return 'Applications';
    }

    activate() {
        this.dock.launchpad?.toggle();
    }
}

class WindowItem extends DockItem {
    constructor(dock, window) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        super(dock, windowId(window), createWindowPreview(window, app));
        this.window = window;
        this.app = app;
    }

    get name() {
        return this.window.get_title() || this.app?.get_name() || '';
    }

    appear(animate) {
        super.appear(animate);
        // Stay hidden while the genie pours the window into this slot.
        if (animate) {
            this.icon.opacity = 0;
            this._fadeIcon(255, PREVIEW_FADE_DELAY);
        }
    }

    leave(onDone) {
        // The window is flying back out of this slot; don't show it twice.
        this._fadeIcon(0, 0);
        super.leave(onDone);
    }

    revive() {
        super.revive();
        this._fadeIcon(255, PREVIEW_FADE_DELAY);
    }

    _fadeIcon(opacity, delay) {
        this.icon.remove_transition('opacity');
        this.icon.ease({
            opacity,
            delay: animationTime(delay),
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    activate() {
        Main.activateWindow(this.window);
    }

    popupMenu() {
        if (!this.menu) {
            const menu = new PopupMenu.PopupMenu(this.actor, 0.5, St.Side.BOTTOM);
            menu.addAction('Geri Getir', () => this.activate());
            menu.addAction('Kapat', () => this.window.delete(global.get_current_time()));
            this._setupMenu(menu);
        }
        this.menu.open(BoxPointer.PopupAnimation.FULL);
    }
}

class TrashItem extends DockItem {
    constructor(dock) {
        const icon = new St.Icon({
            gicon: dock.trashIcons.empty,
            icon_size: MAX_ICON,
            width: MAX_ICON,
            height: MAX_ICON,
        });
        super(dock, TRASH_ID, icon);

        this._full = false;
        this._queried = false;
        this._queryId = 0;
        this._cancellable = new Gio.Cancellable();
        this._file = Gio.File.new_for_uri(TRASH_URI);
        try {
            this._monitor = this._file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._queueQuery());
        } catch (e) {
            console.warn(`macOS Dock: can't watch the trash: ${e.message}`);
            this._monitor = null;
        }
        this._query();
    }

    get name() {
        return 'Çöp Sepeti';
    }

    _queueQuery() {
        if (this._queryId)
            return;
        this._queryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TRASH_QUERY_DELAY, () => {
            this._queryId = 0;
            this._query();
            return GLib.SOURCE_REMOVE;
        });
    }

    _query() {
        this._file.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (file, result) => {
                let count;
                try {
                    count = file.query_info_finish(result).get_attribute_uint32('trash::item-count');
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`macOS Dock: can't read the trash: ${e.message}`);
                    return;
                }
                this._setFull(count > 0);
            });
    }

    _setFull(full) {
        const first = !this._queried;
        this._queried = true;
        if (full === this._full)
            return;
        this._full = full;
        this.icon.gicon = full ? this.dock.trashIcons.full : this.dock.trashIcons.empty;
        // A little hop when something lands in it.
        if (full && !first)
            this.bounce();
    }

    activate() {
        try {
            Gio.AppInfo.launch_default_for_uri(TRASH_URI,
                global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('Çöp Sepeti açılamadı', e.message);
        }
    }

    popupMenu() {
        if (!this.menu) {
            const menu = new PopupMenu.PopupMenu(this.actor, 0.5, St.Side.BOTTOM);
            menu.addAction('Aç', () => this.activate());
            this._emptyMenuItem = menu.addAction('Çöp Sepetini Boşalt…',
                () => this._confirmEmpty());
            this._setupMenu(menu);
        }
        this._emptyMenuItem.setSensitive(this._full);
        this.menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _confirmEmpty() {
        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: 'Çöp Sepeti boşaltılsın mı?',
            description: 'Çöp Sepetindeki tüm öğeler kalıcı olarak silinecek. Bu işlem geri alınamaz.',
        }));
        dialog.setButtons([{
            label: 'Vazgeç',
            action: () => dialog.close(),
            key: Clutter.KEY_Escape,
            // Enter shouldn't throw anything away by accident.
            default: true,
        }, {
            label: 'Boşalt',
            action: () => {
                dialog.close();
                this._emptyTrash();
            },
        }]);
        dialog.open();
    }

    _emptyTrash() {
        let proc;
        try {
            proc = Gio.Subprocess.new(['gio', 'trash', '--empty'], Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notifyError('Çöp Sepeti boşaltılamadı', e.message);
            return;
        }
        proc.wait_check_async(null, (p, result) => {
            try {
                p.wait_check_finish(result);
                global.display.get_sound_player().play_from_theme('trash-empty',
                    'Çöp Sepeti boşaltıldı', null);
            } catch (e) {
                Main.notifyError('Çöp Sepeti boşaltılamadı', e.message);
            }
        });
    }

    _onDestroy() {
        this._cancellable.cancel();
        this._monitor?.cancel();
        this._monitor = null;
        if (this._queryId) {
            GLib.source_remove(this._queryId);
            this._queryId = 0;
        }
        super._onDestroy();
    }
}

class Dock {
    constructor(path) {
        this.launchpad = null;
        this.trashIcons = {
            empty: Gio.FileIcon.new(Gio.File.new_for_path(`${path}/icons/trash-empty.svg`)),
            full: Gio.FileIcon.new(Gio.File.new_for_path(`${path}/icons/trash-full.svg`)),
        };

        this._entries = [];
        this._items = new Map();
        this._windows = new Set();
        this._mouseX = null;
        this._mouseY = null;
        this._magnify = 0;
        this._timeline = null;
        this._resizeTimeline = null;
        this._hoveredItem = null;
        this._openMenus = 0;
        this._geometryLater = 0;
        this._relayoutLater = 0;
        this._compactLater = 0;
        this._radius = -1;
        this._iconSize = ICON_SIZE;
        this._targetIconSize = ICON_SIZE;

        // Reserves the space at the bottom of the screen so maximized
        // windows stop above the dock. It follows the dock's resting size,
        // never magnification, so windows don't resize under the pointer.
        this._strut = new St.Widget({reactive: false});
        this._strut.connect('destroy', () => (this._strut = null));
        Main.layoutManager.addChrome(this._strut, {
            affectsStruts: true,
            trackFullscreen: true,
        });

        // The reactive area: the dock plus, while magnified, the room the
        // magnified icons stick up into.
        this.actor = new St.Widget({
            name: 'macosDock',
            reactive: true,
            track_hover: true,
        });
        // A soft shadow the dock casts on whatever is behind it. It is solid
        // (see the stylesheet) and the glass is opaque, so only the part
        // outside the dock shows.
        this._shadow = new St.Widget({style_class: 'macos-dock-shadow'});
        this.actor.add_child(this._shadow);

        // Frosted glass: a live copy of whatever is under the dock (the
        // wallpaper and windows), blurred and clipped to the dock's shape.
        this._glass = new Clutter.Actor({clip_to_allocation: true});
        this._glassClone = new Clutter.Clone({source: global.window_group});
        this._glass.add_child(this._glassClone);
        // Effects paint outermost first: the shape mask has to wrap the blur.
        this._glassEffect = new GlassEffect();
        this._glass.add_effect(this._glassEffect);
        this._glass.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS,
            brightness: 1,
        }));
        this.actor.add_child(this._glass);

        this._background = new St.Widget({style_class: 'macos-dock'});
        this.actor.add_child(this._background);
        this._outline = new St.Widget({style_class: 'macos-dock-outline'});
        this.actor.add_child(this._outline);

        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: false,
            trackFullscreen: true,
        });
        // The shell may tear our actors down itself (e.g. on shutdown).
        this.actor.connect('destroy', () => this._onDestroy());

        // A label with a small arrow under it pointing at the icon. The arrow
        // is a rotated square tucked behind the label.
        this._tooltip = new St.Widget({opacity: 0, visible: false});
        this._tooltipArrow = new St.Widget({
            style_class: 'macos-dock-tooltip-arrow',
            width: TOOLTIP_ARROW,
            height: TOOLTIP_ARROW,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            rotation_angle_z: 45,
        });
        this._tooltip.add_child(this._tooltipArrow);
        this._tooltipLabel = new St.Label({style_class: 'macos-dock-tooltip'});
        this._tooltip.add_child(this._tooltipLabel);
        this._tooltip.connect('destroy', () => (this._tooltip = null));
        Main.layoutManager.addTopChrome(this._tooltip);

        this.actor.connect('motion-event', (actor, event) => {
            [this._mouseX, this._mouseY] = event.get_coords();
            this._relayout();
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('notify::hover', () => this._syncMagnify());

        this._appSystem = Shell.AppSystem.get_default();
        this._favorites = AppFavorites.getAppFavorites();
        this._tracker = Shell.WindowTracker.get_default();

        this._favorites.connectObject('changed', () => this._rebuild(), this);
        this._appSystem.connectObject(
            'app-state-changed', () => this._rebuild(),
            'installed-changed', () => this._rebuild(),
            this);
        this._tracker.connectObject(
            'tracked-windows-changed', () => this._queueGeometryUpdate(),
            'notify::focus-app', () => this._syncFocus(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._relayout();
            this._queueCompactCheck();
        }, this);
        Main.overview.connectObject(
            'showing', () => this._setOverviewMode(true),
            'hidden', () => this._setOverviewMode(false),
            this);
        global.display.connectObject(
            'window-created', (display, window) => {
                this._trackWindow(window);
                this._queueGeometryUpdate();
            },
            'window-entered-monitor', () => this._queueCompactCheck(),
            'window-left-monitor', () => this._queueCompactCheck(),
            this);
        global.workspace_manager.connectObject('active-workspace-changed', () => {
            this._rebuild();
            this._queueCompactCheck();
        }, this);

        for (const actor of global.get_window_actors())
            this._trackWindow(actor.meta_window);

        // Start at the right size rather than animating into it.
        this._iconSize = this._targetIconSize = this._wantedIconSize();
        this._rebuild(false);
        this._setOverviewMode(Main.overview.visible);
        this._playIntro();
    }

    // The dock rises up from under the screen edge when it first appears.
    _playIntro() {
        if (!St.Settings.get().enable_animations)
            return;
        this.actor.translation_y = reservedHeight(this._iconSize) + 20;
        this.actor.opacity = 0;
        this.actor.ease({
            translation_y: 0,
            opacity: 255,
            duration: INTRO_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _syncFocus() {
        const focusApp = this._tracker.focus_app;
        for (const entry of this._entries)
            entry.syncFocus?.(focusApp);
    }

    destroy() {
        this.actor.destroy();
    }

    _onDestroy() {
        this._favorites.disconnectObject(this);
        this._appSystem.disconnectObject(this);
        this._tracker.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        for (const window of this._windows)
            window.disconnectObject(this);

        const laters = global.compositor.get_laters();
        for (const id of [this._geometryLater, this._relayoutLater, this._compactLater]) {
            if (id)
                laters.remove(id);
        }
        this._geometryLater = this._relayoutLater = this._compactLater = 0;
        this._timeline?.stop();
        this._timeline = null;
        this._resizeTimeline?.stop();
        this._resizeTimeline = null;

        // Item actors are our children and go down with us.
        for (const entry of this._entries)
            entry.stopAnimations();
        this._entries = [];
        this._items.clear();
        this._hoveredItem = null;

        // Forget icon positions we reported, so nothing aims at a dock
        // that is no longer there.
        for (const window of this._windows)
            window.set_icon_geometry(null);
        this._windows.clear();

        this._tooltip?.destroy();
        this._strut?.destroy();
    }

    get _monitor() {
        return Main.layoutManager.primaryMonitor;
    }

    _setOverviewMode(inOverview) {
        // The overview has its own dash; don't stack two docks there.
        this.actor.visible = !inOverview;
        if (inOverview)
            this._hideTooltip();
    }

    _trackWindow(window) {
        if (this._windows.has(window))
            return;
        this._windows.add(window);
        window.connectObject(
            'notify::minimized', () => this._onMinimizedChanged(),
            'notify::maximized-vertically', () => this._queueCompactCheck(),
            'workspace-changed', () => {
                this._rebuild();
                this._queueCompactCheck();
            },
            'unmanaged', () => {
                window.disconnectObject(this);
                this._windows.delete(window);
                this._rebuild();
                this._queueCompactCheck();
            },
            this);
    }

    _onMinimizedChanged() {
        this._rebuild();
        // The minimize animation asks for the icon geometry right away, so
        // the new preview's slot has to be reported before the next frame.
        this._updateIconGeometry();
        this._queueCompactCheck();
    }

    _minimizedWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        return [...this._windows].filter(w =>
            w.minimized &&
            !w.skip_taskbar &&
            !w.get_transient_for() &&
            w.get_compositor_private() &&
            w.located_on_workspace(workspace));
    }

    _createEntry(id, apps, windows) {
        if (id === LAUNCHPAD_ID)
            return new LaunchpadItem(this);
        if (id === TRASH_ID)
            return new TrashItem(this);
        if (id === RUNNING_SEPARATOR_ID || id === WINDOWS_SEPARATOR_ID)
            return new SeparatorEntry(this, id);
        if (windows.has(id))
            return new WindowItem(this, windows.get(id));
        return new AppItem(this, apps.get(id));
    }

    _rebuild(animate = true) {
        const favorites = this._favorites.getFavorites();
        const favoriteIds = new Set(favorites.map(a => a.get_id()));
        const running = this._appSystem.get_running()
            .filter(a => !favoriteIds.has(a.get_id()));
        const minimized = this._minimizedWindows();

        // Keep running apps and minimized windows in the order they first
        // showed up.
        const previous = this._entries.map(e => e.id);
        const byPrevious = getId => (a, b) => {
            const ia = previous.indexOf(getId(a));
            const ib = previous.indexOf(getId(b));
            return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
        };
        running.sort(byPrevious(a => a.get_id()));
        minimized.sort(byPrevious(windowId));

        const apps = new Map([...favorites, ...running].map(a => [a.get_id(), a]));
        const windows = new Map(minimized.map(w => [windowId(w), w]));
        const wanted = [LAUNCHPAD_ID, ...favorites.map(a => a.get_id())];
        if (running.length > 0)
            wanted.push(RUNNING_SEPARATOR_ID, ...running.map(a => a.get_id()));
        wanted.push(WINDOWS_SEPARATOR_ID, ...windows.keys(), TRASH_ID);
        const wantedSet = new Set(wanted);

        // What's no longer wanted shrinks away where it stands.
        for (const entry of this._entries) {
            if (!wantedSet.has(entry.id) && !entry.leaving)
                this._removeEntry(entry, animate);
        }

        const next = wanted.map(id => {
            let entry = this._items.get(id);
            if (!entry) {
                entry = this._createEntry(id, apps, windows);
                this._items.set(id, entry);
                this.actor.add_child(entry.actor);
                entry.syncFocus?.(this._tracker.focus_app);
                entry.appear(animate);
            } else if (entry.leaving) {
                entry.revive();
            }
            return entry;
        });

        // Leaving entries keep their place behind the neighbour they had.
        const trailing = new Map();
        let anchor = null;
        for (const entry of this._entries) {
            if (entry.leaving) {
                if (!trailing.has(anchor))
                    trailing.set(anchor, []);
                trailing.get(anchor).push(entry);
            } else {
                anchor = entry;
            }
        }
        const order = [...trailing.get(null) ?? []];
        for (const entry of next)
            order.push(entry, ...trailing.get(entry) ?? []);
        // An anchor that just left the list takes its followers along to
        // the end rather than dropping them.
        for (const [key, list] of trailing) {
            if (key !== null && !next.includes(key))
                order.push(...list);
        }
        this._entries = order;

        this._relayout();
    }

    _removeEntry(entry, animate) {
        if (this._hoveredItem === entry) {
            this._hoveredItem = null;
            this._hideTooltip();
        }
        const remove = () => {
            this._entries = this._entries.filter(e => e !== entry);
            if (this._items.get(entry.id) === entry)
                this._items.delete(entry.id);
            entry.destroy();
            this.queueRelayout();
        };
        if (animate) {
            entry.leave(remove);
        } else {
            entry.leaving = true;
            remove();
        }
    }

    queueRelayout() {
        if (this._relayoutLater)
            return;
        this._relayoutLater = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._relayoutLater = 0;
                this._relayout();
                return GLib.SOURCE_REMOVE;
            });
    }

    // The largest icon size up to size that still fits every icon on screen.
    _fitIconSize(size) {
        const monitor = this._monitor;
        let icons = 0;
        let fixed = 0;
        for (const entry of this._entries) {
            if (entry.leaving)
                continue;
            if (entry.isIcon)
                icons++;
            else
                fixed += entry.restWidth;
        }
        const available = monitor.width - 2 * DOCK_MARGIN - 2 * DOCK_PADDING - fixed;
        const fit = Math.floor(available / Math.max(1, icons)) - 2 * ITEM_PADDING;
        return Math.max(MIN_ICON_SIZE, Math.min(size, fit));
    }

    // Where everything goes. With targets, it's where things will settle
    // once arriving and leaving entries and resizing are done.
    _computeLayout(targets) {
        const monitor = this._monitor;
        const iconSize = this._fitIconSize(targets ? this._targetIconSize : this._iconSize);
        const presence = e => targets ? e.targetPresence : e.presence;
        const slot = iconSize + 2 * ITEM_PADDING;
        const restWidth = e => (e.isIcon ? slot : e.restWidth) * presence(e);

        // Magnification is computed against the resting layout, so the
        // icons don't run away from the pointer as the dock widens.
        const baseWidth = this._entries.reduce((sum, e) => sum + restWidth(e), 0) +
            2 * DOCK_PADDING;
        const baseLeft = monitor.x + (monitor.width - baseWidth) / 2;
        const radius = MAGNIFY_RADIUS * slot;

        let cursor = baseLeft + DOCK_PADDING;
        const slots = [];
        for (const entry of this._entries) {
            const w = restWidth(entry);
            let scale = 1;
            if (entry.isIcon && this._magnify > 0 && this._mouseX !== null) {
                const d = Math.abs(this._mouseX - (cursor + w / 2));
                scale = 1 + (MAGNIFICATION - 1) * this._magnify * bell(d, radius);
            }
            const size = iconSize * scale;
            const width = entry.isIcon ? (size + 2 * ITEM_PADDING) * presence(entry) : w;
            slots.push({entry, width, size});
            cursor += w;
        }

        let x = DOCK_PADDING;
        for (const s of slots) {
            s.x = x;
            x += s.width;
        }

        const totalWidth = x + DOCK_PADDING;
        const dockH = dockHeight(iconSize);
        const reserved = dockH + DOCK_MARGIN;
        const hovering = this._magnify > 0 || this.actor.hover || this._openMenus > 0;
        const height = reserved + (hovering ? hoverHeadroom(iconSize) : 0);
        const left = Math.round(monitor.x + (monitor.width - totalWidth) / 2);
        const top = monitor.y + monitor.height - height;
        const dockTop = height - reserved;

        return {
            iconSize,
            slots,
            dockWidth: Math.ceil(totalWidth),
            dockHeight: dockH,
            height,
            left,
            top,
            dockTop,
            rowBottom: dockTop + DOCK_PADDING + iconSize + DOT_SPACE,
        };
    }

    _updateStrut() {
        const monitor = this._monitor;
        if (!monitor || !this._strut)
            return;
        const height = reservedHeight(this._fitIconSize(this._targetIconSize));
        this._strut.set_position(monitor.x, monitor.y + monitor.height - height);
        this._strut.set_size(monitor.width, height);
    }

    _setRadius(radius) {
        if (radius === this._radius)
            return;
        this._radius = radius;
        this._glassEffect.setRadius(radius);
        this._background.style = `border-radius: ${radius}px;`;
        this._shadow.style = `border-radius: ${radius}px;`;
        this._outline.style = `border-radius: ${radius + 1}px;`;
    }

    _relayout() {
        if (!this._monitor || this._entries.length === 0)
            return;

        if (this._relayoutLater) {
            global.compositor.get_laters().remove(this._relayoutLater);
            this._relayoutLater = 0;
        }

        this._updateStrut();

        const layout = this._computeLayout(false);
        const {left, top, dockTop, dockWidth, dockHeight: dockH} = layout;
        this.actor.set_position(left, top);
        this.actor.set_size(dockWidth, layout.height);

        this._setRadius(dockRadius(layout.iconSize));
        this._glass.set_position(0, dockTop);
        this._glass.set_size(dockWidth, dockH);
        this._glassClone.set_position(-left, -(top + dockTop));
        this._glassEffect.setSize(dockWidth, dockH);
        if (this._mouseX !== null) {
            this._glassEffect.setPointer(this._mouseX - left,
                this._mouseY - (top + dockTop), this._magnify);
        }
        this._shadow.set_position(0, dockTop);
        this._shadow.set_size(dockWidth, dockH);
        this._background.set_position(0, dockTop);
        this._background.set_size(dockWidth, dockH);
        this._outline.set_position(-1, dockTop - 1);
        this._outline.set_size(dockWidth + 2, dockH + 2);

        for (const {entry, x, width, size} of layout.slots) {
            if (entry.isIcon)
                entry.layout(x, layout.rowBottom, width, size);
            else
                entry.layout(x, dockTop, width, dockH);
        }

        if (this._hoveredItem)
            this._positionTooltip(this._hoveredItem);
        this._queueGeometryUpdate();
    }

    // Shrink the dock while a maximized window is on screen with it, so
    // the window gets the room; grow back once it's gone.
    _wantedIconSize() {
        const workspace = global.workspace_manager.get_active_workspace();
        const primary = Main.layoutManager.primaryIndex;
        const crowded = [...this._windows].some(w =>
            w.maximized_vertically &&
            !w.minimized &&
            !w.skip_taskbar &&
            w.get_monitor() === primary &&
            w.located_on_workspace(workspace));
        return crowded ? COMPACT_ICON_SIZE : ICON_SIZE;
    }

    _queueCompactCheck() {
        if (this._compactLater)
            return;
        this._compactLater = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._compactLater = 0;
                this._setIconSize(this._wantedIconSize());
                return GLib.SOURCE_REMOVE;
            });
    }

    _setIconSize(target) {
        if (target === this._targetIconSize)
            return;
        this._targetIconSize = target;
        // The strut jumps straight to its new size, so windows resize once
        // while the dock animates.
        this._updateStrut();

        this._resizeTimeline?.stop();
        const from = this._iconSize;
        this._resizeTimeline = tween(this.actor, RESIZE_DURATION, t => {
            this._iconSize = from + (target - from) * t;
            this._relayout();
        }, () => (this._resizeTimeline = null));
    }

    _syncMagnify() {
        const target = this.actor.hover || this._openMenus > 0 ? 1 : 0;
        if (target === 0 && this._openMenus === 0)
            this._hideTooltip();

        this._timeline?.stop();
        const from = this._magnify;
        if (from === target) {
            this._relayout();
            return;
        }

        this._timeline = tween(this.actor, MAGNIFY_DURATION, t => {
            this._magnify = from + (target - from) * t;
            this._relayout();
        }, () => (this._timeline = null));
    }

    itemHoverChanged(item) {
        if (item.actor.hover) {
            this._hoveredItem = item;
            this._showTooltip(item);
        } else if (this._hoveredItem === item) {
            this._hoveredItem = null;
            this._hideTooltip();
        }
    }

    menuStateChanged(item, open) {
        this._openMenus = Math.max(0, this._openMenus + (open ? 1 : -1));
        if (open)
            this._hideTooltip();
        this._syncMagnify();
    }

    _showTooltip(item) {
        if (this._openMenus > 0 || !this._tooltip)
            return;
        this._tooltipLabel.text = item.name;
        this._tooltip.show();
        this._positionTooltip(item);
        this._tooltip.remove_all_transitions();
        this._tooltip.ease({
            opacity: 255,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _hideTooltip() {
        if (!this._tooltip)
            return;
        this._tooltip.remove_all_transitions();
        this._tooltip.ease({
            opacity: 0,
            duration: 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._tooltip?.hide(),
        });
    }

    _positionTooltip(item) {
        const box = item.iconBox;
        if (!box)
            return;
        const [, natWidth] = this._tooltipLabel.get_preferred_width(-1);
        const [, natHeight] = this._tooltipLabel.get_preferred_height(-1);
        // How far the rotated arrow pokes out under the label.
        const arrowDrop = Math.round(TOOLTIP_ARROW * Math.SQRT1_2);
        const height = natHeight + arrowDrop;
        this._tooltip.set_size(natWidth, height);
        this._tooltipLabel.set_position(0, 0);
        this._tooltipLabel.set_size(natWidth, natHeight);

        const iconCenter = this.actor.x + box.x + box.width / 2;
        const monitor = this._monitor;
        const x = Math.round(Math.max(monitor.x,
            Math.min(iconCenter - natWidth / 2, monitor.x + monitor.width - natWidth)));
        const y = Math.round(this.actor.y + box.y - height - TOOLTIP_GAP);
        this._tooltip.set_position(x, y);
        this._tooltipArrow.set_position(
            Math.round(iconCenter - x - TOOLTIP_ARROW / 2),
            Math.round(natHeight - TOOLTIP_ARROW / 2));
    }

    _queueGeometryUpdate() {
        if (this._geometryLater)
            return;
        this._geometryLater = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._geometryLater = 0;
                this._updateIconGeometry();
                return GLib.SOURCE_REMOVE;
            });
    }

    // Tell mutter where each window's icon is, so minimize animations
    // (genie) fly into the right spot on the dock: a minimized window into
    // its own preview, everything else into its app. Positions are where
    // icons will settle, not where they are mid-animation.
    _updateIconGeometry() {
        if (!this._monitor || this._entries.length === 0)
            return;
        const layout = this._computeLayout(true);
        const rects = new Map();
        for (const {entry, x, width, size} of layout.slots) {
            if (!entry.isIcon || entry.leaving)
                continue;
            rects.set(entry, new Mtk.Rectangle({
                x: Math.round(layout.left + x + (width - size) / 2),
                y: Math.round(layout.top + layout.rowBottom - size - DOT_SPACE),
                width: Math.round(size),
                height: Math.round(size),
            }));
        }

        // A window flying back out of its preview keeps aiming at it.
        const handled = new Set();
        for (const entry of this._entries) {
            if (!(entry instanceof WindowItem))
                continue;
            handled.add(entry.window);
            const rect = rects.get(entry);
            if (rect)
                entry.window.set_icon_geometry(rect);
        }
        for (const entry of this._entries) {
            const rect = rects.get(entry);
            if (!(entry instanceof AppItem) || !rect)
                continue;
            for (const window of appWindows(entry.app)) {
                if (!handled.has(window))
                    window.set_icon_geometry(rect);
            }
        }
    }
}

export default class MacosDockExtension extends Extension {
    enable() {
        this._dock = new Dock(this.path);
        this._launchpad = new Launchpad();
        this._dock.launchpad = this._launchpad;

        // Super+A opens Launchpad instead of the overview's app grid.
        Main.wm.setCustomKeybindingHandler('toggle-application-view',
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._launchpad.toggle());

        // Tapping Super toggles Launchpad too, instead of the overview. The
        // overview's own handler is blocked rather than removed, so it comes
        // back as it was when we are disabled. Launchpad is a POPUP-mode
        // modal, so the key has to be allowed there for Super to close it.
        GObject.signal_handlers_block_matched(global.display, {signalId: 'overlay-key'});
        global.display.connectObject('overlay-key', () => {
            if (Main.overview.visible)
                Main.overview.hide();
            else
                this._launchpad.toggle();
        }, this);
        Main.wm.allowKeybinding('overlay-key',
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);

        // The three-finger swipe up opens Launchpad too, not the overview.
        // As with Super, the overview's handlers are only blocked.
        this._overviewSwipe = Main.overview._swipeTracker;
        if (this._overviewSwipe) {
            GObject.signal_handlers_block_matched(this._overviewSwipe, {signalId: 'begin'});
            GObject.signal_handlers_block_matched(this._overviewSwipe, {signalId: 'update'});
            GObject.signal_handlers_block_matched(this._overviewSwipe, {signalId: 'end'});
            this._overviewSwipe.connectObject(
                'begin', tracker => {
                    // Only from the desktop; in the overview the swipe is
                    // still ours, so swiping there just does nothing.
                    if (!Main.overview.visible && !this._launchpad.isOpen)
                        tracker.confirmSwipe(global.screen_height, [0, 1], 0, 0);
                },
                'end', (tracker, duration, endProgress) => {
                    if (endProgress >= 1)
                        this._launchpad.open();
                },
                this);
        }

        // Land on the desktop after login, not in the overview. Hiding the
        // overview once its startup animation is done leaves the screen
        // half-drawn until something repaints it, so instead the session
        // pretends to have no overview while starting up. GNOME then plays
        // its plain zoom-in animation and never shows the overview at all.
        if (Main.layoutManager._startingUp) {
            this._hadOverview = Main.sessionMode.hasOverview;
            Main.sessionMode.hasOverview = false;
            Main.layoutManager.connectObject('startup-complete',
                () => this._restoreOverview(), this);
        }
    }

    _restoreOverview() {
        Main.layoutManager.disconnectObject(this);
        if (this._hadOverview !== undefined) {
            Main.sessionMode.hasOverview = this._hadOverview;
            delete this._hadOverview;
        }
    }

    disable() {
        global.display.disconnectObject(this);
        GObject.signal_handlers_unblock_matched(global.display, {signalId: 'overlay-key'});
        Main.wm.allowKeybinding('overlay-key',
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._restoreOverview();

        if (this._overviewSwipe) {
            this._overviewSwipe.disconnectObject(this);
            GObject.signal_handlers_unblock_matched(this._overviewSwipe, {signalId: 'begin'});
            GObject.signal_handlers_unblock_matched(this._overviewSwipe, {signalId: 'update'});
            GObject.signal_handlers_unblock_matched(this._overviewSwipe, {signalId: 'end'});
            this._overviewSwipe = null;
        }

        const controls = Main.overview._overview?.controls;
        if (controls) {
            Main.wm.setCustomKeybindingHandler('toggle-application-view',
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                controls._toggleAppsPage.bind(controls));
        }

        this._launchpad.destroy();
        this._launchpad = null;
        this._dock.destroy();
        this._dock = null;
    }
}
