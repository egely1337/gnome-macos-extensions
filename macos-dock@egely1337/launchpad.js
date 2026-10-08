import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

const COLUMNS = 7;
const ROWS = 5;
const MAX_ICON_SIZE = 96;
// Vertical padding of .macos-launchpad-item, the label's padding-top and
// the running dot with its margin.
const ITEM_EXTRA_HEIGHT = 2 * 8 + 9 + 4 + 5;

const BLUR_RADIUS = 60;
const BLUR_BRIGHTNESS = 0.58;

const OPEN_DURATION = 320;
const CLOSE_DURATION = 220;
const PAGE_DURATION = 420;

// Icons ripple in from the middle of the grid when Launchpad opens.
const RIPPLE_DURATION = 560;
const RIPPLE_SPREAD = 240;     // delay of the outermost icons
const RIPPLE_SCALE = 0.55;
const RIPPLE_RISE = 36;
// Search results pop in one after another.
const RESULT_STAGGER = 14;
const RESULT_MAX_DELAY = 160;

const HOVER_SCALE = 1.1;
const PRESS_SCALE = 0.9;
// The launched app's icon swells towards the viewer and fades.
const LAUNCH_SCALE = 2.4;
const LAUNCH_DURATION = 450;

// Pages next to the current one shrink and fade as they slide away.
const PAGE_SHRINK = 0.14;
const PAGE_FADE = 0.7;

const DOT_SIZE = 8;
const ACTIVE_DOT_WIDTH = 24;

// Touchpad swipes drag the pages along with the fingers. This much
// smooth-scroll distance (in pixels) moves one page.
const SWIPE_DISTANCE = 420;
const SWIPE_SNAP = 0.18;       // fraction of a page that commits a flip
const EDGE_RESISTANCE = 0.3;   // how far you can pull past the first/last page
// Wheels: accumulated distance that flips a page.
const SCROLL_THRESHOLD = 1.2;
const SCROLL_RESET_MS = 180;

// Slowly drifting colored light behind the grid.
const AURORA_STRENGTH = 0.26;

function animationTime(ms) {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return 0;
    return Math.round(ms * settings.slow_down_factor);
}

function normalize(text) {
    return text.toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

// Soft blobs of colored light drifting over the blurred desktop, with a
// vignette that darkens the edges so the icons pop.
const AuroraEffect = GObject.registerClass(
class AuroraEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._sizeLocation = this.get_uniform_location('size');
        this._timeLocation = this.get_uniform_location('time');
        this.set_uniform_float(this.get_uniform_location('strength'), 1, [AURORA_STRENGTH]);
        this.setSize(1, 1);
        this.setTime(0);
    }

    setSize(width, height) {
        this.set_uniform_float(this._sizeLocation, 2, [width, height]);
    }

    setTime(seconds) {
        this.set_uniform_float(this._timeLocation, 1, [seconds]);
        this.queue_repaint();
    }

    vfunc_build_pipeline() {
        const declarations = `
            uniform vec2 size;
            uniform float time;
            uniform float strength;

            float blob(vec2 p, vec2 c, float r) {
                vec2 d = p - c;
                return exp(-dot(d, d) / (r * r));
            }
        `;
        const code = `
            vec2 uv = cogl_tex_coord_in[0].xy;
            float aspect = size.x / max(size.y, 1.0);
            vec2 p = vec2(uv.x * aspect, uv.y);
            float t = time;

            vec3 light = vec3(0.0);
            light += vec3(0.20, 0.45, 1.00) * blob(p,
                vec2(aspect * (0.22 + 0.12 * sin(t * 0.21)), 0.28 + 0.10 * cos(t * 0.17)), 0.55);
            light += vec3(0.62, 0.32, 1.00) * blob(p,
                vec2(aspect * (0.80 + 0.10 * cos(t * 0.19)), 0.22 + 0.12 * sin(t * 0.23)), 0.50);
            light += vec3(1.00, 0.36, 0.62) * blob(p,
                vec2(aspect * (0.62 + 0.14 * sin(t * 0.13 + 1.7)), 0.86 + 0.08 * cos(t * 0.29)), 0.55);
            light += vec3(0.16, 0.85, 0.78) * blob(p,
                vec2(aspect * (0.16 + 0.10 * cos(t * 0.27 + 0.6)), 0.90 + 0.07 * sin(t * 0.15)), 0.45);
            light *= strength;

            vec2 v = (uv - 0.5) * vec2(1.0, 1.2);
            float vignette = smoothstep(0.25, 0.85, length(v));
            float shade = 0.16 + 0.38 * vignette;

            // Premultiplied: the light adds, the shade darkens what's behind.
            cogl_color_out = vec4(light, shade) * cogl_color_out.a;
        `;
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, false);
    }
});

class LaunchpadItem {
    constructor(launchpad, app) {
        this.app = app;
        this.menu = null;
        this._launchpad = launchpad;
        this._iconSize = 0;
        this._searchText = normalize([
            app.get_name(),
            app.get_id(),
            ...(app.app_info?.get_keywords?.() ?? []),
            app.app_info?.get_generic_name?.() ?? '',
        ].join(' '));

        this.actor = new St.Button({
            style_class: 'macos-launchpad-item',
            reactive: true,
            can_focus: false,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        this.actor.set_pivot_point(0.5, 0.5);
        // AppMenu calls this on its source actor for "New Window" and such.
        this.actor.animateLaunch = () => launchpad.flyOut(this);

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.set_child(box);

        this._iconBin = new St.Bin({x_align: Clutter.ActorAlign.CENTER});
        this._iconBin.set_pivot_point(0.5, 0.5);
        box.add_child(this._iconBin);
        this.label = new St.Label({
            style_class: 'macos-launchpad-label',
            text: app.get_name(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this.label);

        this._dot = new St.Widget({
            style_class: 'macos-launchpad-running',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });
        box.add_child(this._dot);
        this.syncRunning();

        this.actor.connect('clicked', (actor, button) => {
            if (button === Clutter.BUTTON_SECONDARY)
                this.popupMenu();
            else
                launchpad.launch(this);
        });
        this.actor.connect('notify::hover', () => this._syncIconScale());
        this.actor.connect('notify::pressed', () => this._syncIconScale());
        this.actor.connect('destroy', () => {
            this.menu?.destroy();
            this.menu = null;
        });
    }

    get iconActor() {
        return this._iconBin.get_child();
    }

    _syncIconScale() {
        let scale = 1;
        if (this.actor.pressed)
            scale = PRESS_SCALE;
        else if (this.actor.hover || this._selected)
            scale = HOVER_SCALE;
        this._iconBin.ease({
            scale_x: scale,
            scale_y: scale,
            duration: this.actor.pressed ? 90 : 260,
            mode: this.actor.pressed
                ? Clutter.AnimationMode.EASE_OUT_QUAD
                : Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    syncRunning() {
        const running = this.app.state !== Shell.AppState.STOPPED;
        this._dot.ease({
            opacity: running ? 255 : 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    matches(terms) {
        return terms.every(t => this._searchText.includes(t));
    }

    // Lower is better: name prefix, then word prefix, then anywhere.
    rank(terms) {
        const name = normalize(this.app.get_name());
        const first = terms[0];
        if (name.startsWith(first))
            return 0;
        if (name.split(/[\s\-_.]+/).some(w => w.startsWith(first)))
            return 1;
        return 2;
    }

    setIconSize(size, cellWidth) {
        if (size !== this._iconSize) {
            this._iconSize = size;
            this._iconBin.set_child(this.app.create_icon_texture(size));
        }
        // Natural width keeps short names centred; long ones ellipsize.
        this.label.set_width(-1);
        const [, natural] = this.label.get_preferred_width(-1);
        this.label.set_width(Math.min(natural, Math.round(cellWidth - 16)));
    }

    set selected(value) {
        this._selected = value;
        if (value)
            this.actor.add_style_pseudo_class('selected');
        else
            this.actor.remove_style_pseudo_class('selected');
        this._syncIconScale();
    }

    popupMenu() {
        if (!this.menu) {
            this.menu = new AppMenu(this.actor, St.Side.TOP, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            this.menu.setApp(this.app);
            Main.uiGroup.add_child(this.menu.actor);
            this._menuManager = new PopupMenu.PopupMenuManager(this.actor);
            this._menuManager.addMenu(this.menu);
            // Anything picked from the menu opens or changes an app; get
            // out of its way. Pinning to the dock is the exception.
            this.menu.connect('activate', (menu, menuItem) => {
                if (menuItem !== menu._toggleFavoriteItem)
                    this._launchpad.close();
            });
        }
        // Launchpad sits on top of everything; the menu has to go above it.
        Main.uiGroup.set_child_above_sibling(this.menu.actor, null);
        this.menu.open(BoxPointer.PopupAnimation.FULL);
    }
}

export class Launchpad {
    constructor() {
        this._items = new Map();
        this._visibleItems = [];
        this._pages = [];
        this._page = 0;
        this._pageCount = 1;
        this._selected = -1;
        this._grab = null;
        this._open = false;
        this._appsDirty = true;
        this._scrollAccum = 0;
        this._scrollResetId = 0;
        this._scrollLocked = false;
        this._dragging = false;
        this._dragOffset = 0;
        this._dragAxis = null;
        this._metrics = null;
        this._flying = new Set();

        this.actor = new St.Widget({
            name: 'macosLaunchpad',
            reactive: true,
            visible: false,
            clip_to_allocation: true,
        });
        this.actor.connect('destroy', () => this._onDestroy());

        // The blurred, dimmed desktop behind the grid.
        this._backdrop = new Clutter.Actor();
        this._backdropClone = new Clutter.Clone({source: global.window_group});
        this._backdrop.add_child(this._backdropClone);
        this._blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: 0,
            brightness: 1,
        });
        this._backdrop.add_effect_with_name('blur', this._blur);
        this.actor.add_child(this._backdrop);

        this._aurora = new St.Widget({style_class: 'macos-launchpad-aurora'});
        this._auroraEffect = new AuroraEffect();
        this._aurora.add_effect(this._auroraEffect);
        this.actor.add_child(this._aurora);
        this._auroraTimeline = new Clutter.Timeline({
            actor: this.actor,
            duration: 1000,
            repeat_count: -1,
        });
        this._auroraStart = GLib.get_monotonic_time();
        this._auroraTimeline.connect('new-frame', () => {
            this._auroraEffect.setTime((GLib.get_monotonic_time() - this._auroraStart) / 1e6);
        });

        this._content = new St.Widget();
        this.actor.add_child(this._content);

        this._entry = new St.Entry({
            style_class: 'macos-launchpad-search',
            hint_text: 'Ara',
            can_focus: true,
            primary_icon: new St.Icon({
                icon_name: 'system-search-symbolic',
                style_class: 'macos-launchpad-search-icon',
            }),
        });
        this._entry.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._entry.clutter_text.connect('key-press-event',
            (actor, event) => this._onKeyPress(event));
        this._content.add_child(this._entry);

        this._viewport = new Clutter.Actor({clip_to_allocation: true, reactive: true});
        this._content.add_child(this._viewport);
        this._strip = new Clutter.Actor();
        this._strip.connect('notify::translation-x', () => this._updateParallax());
        this._viewport.add_child(this._strip);

        this._dots = new St.BoxLayout({style_class: 'macos-launchpad-dots'});
        this._content.add_child(this._dots);

        this._empty = new St.BoxLayout({
            style_class: 'macos-launchpad-empty',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
        });
        this._empty.add_child(new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'macos-launchpad-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._empty.add_child(new St.Label({
            style_class: 'macos-launchpad-empty-title',
            text: 'Sonuç yok',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._emptyHint = new St.Label({
            style_class: 'macos-launchpad-empty-hint',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._empty.add_child(this._emptyHint);
        this._content.add_child(this._empty);

        // Clicking anywhere that isn't an icon closes, like macOS.
        this.actor.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,
                ...event.get_coords());
            if (target === this.actor || target === this._viewport)
                this.close();
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('scroll-event', (actor, event) => this._onScroll(event));
        this.actor.connect('key-press-event', (actor, event) => this._onKeyPress(event));

        Main.layoutManager.uiGroup.add_child(this.actor);

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject(
            'installed-changed', () => {
                this._appsDirty = true;
                if (this._open)
                    this._refreshApps();
            },
            'app-state-changed', (system, app) => this._items.get(app.get_id())?.syncRunning(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            if (this._open)
                this._relayout();
        }, this);
    }

    get isOpen() {
        return this._open;
    }

    toggle() {
        if (this._open)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._open)
            return;

        if (Main.overview.visible)
            Main.overview.hide();

        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        this._open = true;

        if (this._appsDirty)
            this._refreshApps();
        for (const item of this._items.values())
            item.syncRunning();
        this._entry.text = '';
        this._page = 0;
        this._select(-1);
        this._relayout();
        this._strip.remove_all_transitions();
        this._strip.translation_x = 0;
        this._updateParallax();

        const parent = this.actor.get_parent();
        parent.set_child_above_sibling(this.actor, null);
        this.actor.show();
        global.stage.set_key_focus(this._entry.clutter_text);
        this._auroraTimeline.start();

        const duration = animationTime(OPEN_DURATION);
        this.actor.remove_all_transitions();
        this.actor.opacity = 0;
        this.actor.ease({
            opacity: 255,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._blur.radius = 0;
        this._blur.brightness = 1;
        this._backdrop.ease_property('@effects.blur.radius', BLUR_RADIUS, {
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._backdrop.ease_property('@effects.blur.brightness', BLUR_BRIGHTNESS, {
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // The search field and page dots drop into place; the icons ripple
        // out from the middle.
        for (const actor of [this._entry, this._dots]) {
            actor.remove_all_transitions();
            actor.translation_y = -14;
            actor.opacity = 0;
            actor.ease({
                translation_y: 0,
                opacity: 255,
                delay: animationTime(80),
                duration: animationTime(380),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
        this._resetItems();
        this._ripple();
    }

    close() {
        if (!this._open)
            return;
        this._open = false;
        this._endDrag(false);

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        const duration = animationTime(CLOSE_DURATION);
        this._backdrop.ease_property('@effects.blur.radius', 0, {
            duration,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        this._backdrop.ease_property('@effects.blur.brightness', 1, {
            duration,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        // Icons sink back as everything fades.
        for (const item of this._pageItems(this._page)) {
            item.actor.remove_all_transitions();
            item.actor.ease({
                scale_x: 0.82,
                scale_y: 0.82,
                translation_y: RIPPLE_RISE / 2,
                duration,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
            });
        }
        this.actor.ease({
            opacity: 0,
            duration,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (this._open)
                    return;
                this.actor.hide();
                this._auroraTimeline.stop();
                this._resetItems();
            },
        });
    }

    launch(item) {
        this.flyOut(item);
        item.app.activate();
        this.close();
    }

    // A copy of the icon swells towards the viewer and fades, as if the
    // app were coming out of it.
    flyOut(item) {
        const icon = item.iconActor;
        if (!icon || animationTime(LAUNCH_DURATION) === 0)
            return;
        const [x, y] = icon.get_transformed_position();
        const [width, height] = icon.get_transformed_size();
        const clone = new Clutter.Clone({
            source: icon,
            reactive: false,
            x, y, width, height,
        });
        clone.set_pivot_point(0.5, 0.5);
        Main.layoutManager.uiGroup.add_child(clone);
        this._flying.add(clone);
        clone.ease({
            scale_x: LAUNCH_SCALE,
            scale_y: LAUNCH_SCALE,
            opacity: 0,
            duration: animationTime(LAUNCH_DURATION),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                this._flying.delete(clone);
                clone.destroy();
            },
        });
    }

    destroy() {
        this.actor.destroy();
    }

    _onDestroy() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        if (this._scrollResetId) {
            GLib.source_remove(this._scrollResetId);
            this._scrollResetId = 0;
        }
        this._auroraTimeline.stop();
        for (const clone of this._flying)
            clone.destroy();
        this._flying.clear();
        this._appSystem.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        // Items that never made it onto a page aren't our children.
        for (const item of this._items.values()) {
            if (!item.actor.get_parent())
                item.actor.destroy();
        }
        this._items.clear();
        this._visibleItems = [];
        this._pages = [];
    }

    _refreshApps() {
        this._appsDirty = false;
        const apps = this._appSystem.get_installed()
            .filter(info => info.should_show())
            .map(info => this._appSystem.lookup_app(info.get_id()))
            .filter(app => app !== null);

        const wanted = new Set(apps.map(a => a.get_id()));
        for (const [id, item] of this._items) {
            if (!wanted.has(id)) {
                item.actor.destroy();
                this._items.delete(id);
            }
        }
        for (const app of apps) {
            if (!this._items.has(app.get_id()))
                this._items.set(app.get_id(), new LaunchpadItem(this, app));
        }

        const collator = new Intl.Collator(undefined, {sensitivity: 'base'});
        this._allItems = [...this._items.values()]
            .sort((a, b) => collator.compare(a.app.get_name(), b.app.get_name()));
        this._filter();
    }

    _searchTerms() {
        return normalize(this._entry.text).split(/\s+/).filter(t => t.length > 0);
    }

    _filter() {
        const terms = this._searchTerms();
        let items = this._allItems ?? [];
        if (terms.length > 0) {
            items = items
                .filter(i => i.matches(terms))
                .map((item, index) => ({item, index, rank: item.rank(terms)}))
                .sort((a, b) => a.rank - b.rank || a.index - b.index)
                .map(({item}) => item);
        }
        this._visibleItems = items;
    }

    _onSearchChanged() {
        if (!this._open)
            return;
        this._select(-1);
        this._filter();
        this._page = 0;
        this._endDrag(false);
        this._strip.remove_all_transitions();
        this._strip.translation_x = 0;
        this._relayout();
        this._resetItems();
        this._popResults();
        this._select(this._searchTerms().length > 0 && this._visibleItems.length > 0 ? 0 : -1);
    }

    _pageItems(page) {
        const perPage = COLUMNS * ROWS;
        return this._visibleItems.slice(page * perPage, (page + 1) * perPage);
    }

    _resetItems() {
        for (const item of this._items.values()) {
            item.actor.remove_all_transitions();
            item.actor.set_scale(1, 1);
            item.actor.translation_y = 0;
            item.actor.opacity = 255;
        }
    }

    _ripple() {
        if (animationTime(RIPPLE_DURATION) === 0)
            return;
        const cx = (COLUMNS - 1) / 2;
        const cy = (ROWS - 1) / 2;
        const farthest = Math.hypot(cx, cy);
        this._pageItems(this._page).forEach((item, i) => {
            const d = Math.hypot(i % COLUMNS - cx, Math.floor(i / COLUMNS) - cy) / farthest;
            const delay = animationTime(d * RIPPLE_SPREAD);
            const actor = item.actor;
            actor.set_scale(RIPPLE_SCALE, RIPPLE_SCALE);
            actor.translation_y = RIPPLE_RISE;
            actor.opacity = 0;
            // Opacity can't overshoot, so it gets its own gentler curve.
            actor.ease({
                opacity: 255,
                delay,
                duration: animationTime(RIPPLE_DURATION * 0.6),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            actor.ease({
                scale_x: 1,
                scale_y: 1,
                translation_y: 0,
                delay,
                duration: animationTime(RIPPLE_DURATION),
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        });
    }

    _popResults() {
        if (animationTime(RIPPLE_DURATION) === 0)
            return;
        this._pageItems(0).forEach((item, i) => {
            const actor = item.actor;
            const delay = animationTime(Math.min(RESULT_MAX_DELAY, i * RESULT_STAGGER));
            actor.set_scale(0.8, 0.8);
            actor.opacity = 0;
            actor.ease({
                opacity: 255,
                delay,
                duration: animationTime(180),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            actor.ease({
                scale_x: 1,
                scale_y: 1,
                delay,
                duration: animationTime(320),
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        });
    }

    _computeMetrics(monitor) {
        const sideMargin = Math.round(monitor.width * 0.09);
        const top = Math.round(Math.max(110, monitor.height * 0.11));
        const bottom = Math.round(Math.max(120, monitor.height * 0.12));
        const gridWidth = monitor.width - 2 * sideMargin;
        const gridHeight = monitor.height - top - bottom;
        const cellWidth = gridWidth / COLUMNS;
        const cellHeight = gridHeight / ROWS;
        const iconSize = Math.round(Math.min(MAX_ICON_SIZE, cellWidth * 0.6, cellHeight * 0.58));
        return {sideMargin, top, bottom, gridWidth, gridHeight, cellWidth, cellHeight, iconSize};
    }

    _pageActor(index) {
        while (this._pages.length <= index) {
            const page = new Clutter.Actor();
            page.set_pivot_point(0.5, 0.5);
            this._strip.add_child(page);
            this._pages.push(page);
        }
        return this._pages[index];
    }

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, monitor.height);
        this._backdrop.set_size(monitor.width, monitor.height);
        this._backdropClone.set_position(-monitor.x, -monitor.y);
        this._aurora.set_size(monitor.width, monitor.height);
        this._auroraEffect.setSize(monitor.width, monitor.height);
        this._content.set_size(monitor.width, monitor.height);

        const m = this._computeMetrics(monitor);
        this._metrics = m;

        const [, entryHeight] = this._entry.get_preferred_height(-1);
        const entryWidth = 300;
        this._entry.set_size(entryWidth, entryHeight);
        this._entry.set_position(Math.round((monitor.width - entryWidth) / 2),
            Math.round((m.top - entryHeight) / 2));

        this._viewport.set_position(m.sideMargin, m.top);
        this._viewport.set_size(m.gridWidth, m.gridHeight);

        const perPage = COLUMNS * ROWS;
        const items = this._visibleItems;
        this._pageCount = Math.max(1, Math.ceil(items.length / perPage));
        this._page = Math.min(this._page, this._pageCount - 1);
        this._strip.set_size(m.gridWidth * this._pageCount, m.gridHeight);

        this._pages.forEach((page, i) => (page.visible = i < this._pageCount));
        for (let i = 0; i < this._pageCount; i++) {
            const page = this._pageActor(i);
            page.set_position(i * m.gridWidth, 0);
            page.set_size(m.gridWidth, m.gridHeight);
        }

        const shown = new Set(items);
        for (const item of this._items.values()) {
            if (!shown.has(item))
                item.actor.hide();
        }

        items.forEach((item, i) => {
            const page = this._pageActor(Math.floor(i / perPage));
            const slot = i % perPage;
            const col = slot % COLUMNS;
            const row = Math.floor(slot / COLUMNS);

            const parent = item.actor.get_parent();
            if (parent !== page) {
                parent?.remove_child(item.actor);
                page.add_child(item.actor);
            }

            item.setIconSize(m.iconSize, m.cellWidth);
            // The button hugs the icon and label so the selection highlight
            // does too; it sits centred in its grid cell.
            const width = Math.min(m.cellWidth, m.iconSize * 1.9);
            const [, labelHeight] = item.label.get_preferred_height(-1);
            const height = m.iconSize + labelHeight + ITEM_EXTRA_HEIGHT;
            item.actor.set_size(Math.round(width), Math.round(height));
            item.actor.set_position(
                Math.round(col * m.cellWidth + (m.cellWidth - width) / 2),
                Math.round(row * m.cellHeight + (m.cellHeight - height) / 2));
            item.actor.show();
        });

        this._empty.visible = items.length === 0;
        if (this._empty.visible) {
            this._emptyHint.text = `“${this._entry.text.trim()}” ile eşleşen uygulama yok`;
            const [, w] = this._empty.get_preferred_width(-1);
            const [, h] = this._empty.get_preferred_height(w);
            this._empty.set_size(w, h);
            this._empty.set_position(Math.round((monitor.width - w) / 2),
                Math.round(m.top + m.gridHeight / 3 - h / 2));
        }

        this._rebuildDots();
        const dotsWidth = (this._pageCount - 1) * (DOT_SIZE + 10) + ACTIVE_DOT_WIDTH;
        const [, dotsHeight] = this._dots.get_preferred_height(-1);
        this._dots.set_position(Math.round((monitor.width - dotsWidth) / 2),
            Math.round(monitor.height - m.bottom + (m.bottom - dotsHeight) / 3));
        this._strip.translation_x = -this._page * m.gridWidth;
        this._updateParallax();
    }

    // Pages shrink and fade with their distance from the middle of the view.
    _updateParallax() {
        if (!this._metrics)
            return;
        const position = -this._strip.translation_x / this._metrics.gridWidth;
        this._pages.forEach((page, i) => {
            const offset = Math.min(1, Math.abs(i - position));
            const scale = 1 - PAGE_SHRINK * offset;
            page.set_scale(scale, scale);
            page.opacity = Math.round(255 * (1 - PAGE_FADE * offset));
        });
    }

    _rebuildDots() {
        this._dots.destroy_all_children();
        this._dots.visible = this._pageCount > 1;
        for (let i = 0; i < this._pageCount; i++) {
            const dot = new St.Button({
                style_class: 'macos-launchpad-dot',
                can_focus: false,
                width: i === this._page ? ACTIVE_DOT_WIDTH : DOT_SIZE,
                height: DOT_SIZE,
            });
            if (i === this._page)
                dot.add_style_pseudo_class('checked');
            dot.connect('clicked', () => this._goToPage(i));
            this._dots.add_child(dot);
        }
    }

    // The current page's dot stretches into a pill.
    _syncDots() {
        this._dots.get_children().forEach((dot, i) => {
            const active = i === this._page;
            if (active)
                dot.add_style_pseudo_class('checked');
            else
                dot.remove_style_pseudo_class('checked');
            dot.ease({
                width: active ? ACTIVE_DOT_WIDTH : DOT_SIZE,
                duration: animationTime(300),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
    }

    _goToPage(page) {
        page = Math.max(0, Math.min(this._pageCount - 1, page));
        if (!this._metrics)
            return;
        const changed = page !== this._page;
        this._page = page;
        this._syncDots();

        this._scrollLocked = true;
        this._strip.ease({
            translation_x: -page * this._metrics.gridWidth,
            duration: animationTime(changed ? PAGE_DURATION : 260),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => (this._scrollLocked = false),
        });
    }

    _restartScrollReset(callback) {
        if (this._scrollResetId)
            GLib.source_remove(this._scrollResetId);
        this._scrollResetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_RESET_MS, () => {
            this._scrollResetId = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onScroll(event) {
        if (this._pageCount < 2)
            return Clutter.EVENT_STOP;

        const direction = event.get_scroll_direction();
        const touchpad = event.get_source_device()?.get_device_type() ===
            Clutter.InputDeviceType.TOUCHPAD_DEVICE;
        if (direction === Clutter.ScrollDirection.SMOOTH && touchpad) {
            this._onSwipe(event);
            return Clutter.EVENT_STOP;
        }

        let delta = 0;
        switch (direction) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            delta = -SCROLL_THRESHOLD;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            delta = SCROLL_THRESHOLD;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            break;
        }
        }

        // A high-resolution wheel sends a stream of small deltas; turn each
        // burst into a single page flip.
        this._restartScrollReset(() => (this._scrollAccum = 0));
        if (this._scrollLocked)
            return Clutter.EVENT_STOP;

        this._scrollAccum += delta;
        if (Math.abs(this._scrollAccum) >= SCROLL_THRESHOLD) {
            const step = Math.sign(this._scrollAccum);
            this._scrollAccum = 0;
            this._flipTo(this._page + step);
        }
        return Clutter.EVENT_STOP;
    }

    _flipTo(target) {
        if (target < 0 || target >= this._pageCount)
            return;
        this._goToPage(target);
        if (this._selected >= 0)
            this._select(target * COLUMNS * ROWS);
    }

    // Touchpad: the pages follow the fingers, then snap when they lift.
    _onSwipe(event) {
        const [dx, dy] = event.get_scroll_delta();
        if (!this._dragging) {
            this._dragging = true;
            this._dragOffset = 0;
            this._dragAxis = null;
            this._strip.remove_all_transitions();
            this._scrollLocked = false;
            // Pick up from wherever an unfinished flip left the strip.
            this._dragOffset = -this._strip.translation_x / this._metrics.gridWidth - this._page;
        }
        if (!this._dragAxis && (dx !== 0 || dy !== 0))
            this._dragAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';

        const delta = this._dragAxis === 'y' ? dy : dx;
        this._dragOffset += delta * 10 / SWIPE_DISTANCE;

        let position = this._page + this._dragOffset;
        const last = this._pageCount - 1;
        if (position < 0)
            position *= EDGE_RESISTANCE;
        else if (position > last)
            position = last + (position - last) * EDGE_RESISTANCE;
        this._strip.translation_x = -position * this._metrics.gridWidth;

        if (event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE)
            this._endDrag(true);
        else
            this._restartScrollReset(() => this._endDrag(true));
    }

    _endDrag(snap) {
        if (this._scrollResetId) {
            GLib.source_remove(this._scrollResetId);
            this._scrollResetId = 0;
        }
        if (!this._dragging)
            return;
        this._dragging = false;
        const offset = this._dragOffset;
        this._dragOffset = 0;
        if (!snap)
            return;

        let target = Math.round(this._page + offset);
        if (target === this._page && Math.abs(offset) > SWIPE_SNAP)
            target += Math.sign(offset);
        target = Math.max(0, Math.min(this._pageCount - 1, target));
        this._goToPage(target);
        if (this._selected >= 0 && Math.floor(this._selected / (COLUMNS * ROWS)) !== target)
            this._select(target * COLUMNS * ROWS);
    }

    _select(index) {
        const previous = this._visibleItems[this._selected];
        if (previous)
            previous.selected = false;
        this._selected = index;
        const item = this._visibleItems[index];
        if (!item)
            return;
        item.selected = true;
        const page = Math.floor(index / (COLUMNS * ROWS));
        if (page !== this._page)
            this._goToPage(page);
    }

    _moveSelection(dx, dy) {
        const count = this._visibleItems.length;
        if (count === 0)
            return;
        if (this._selected < 0) {
            this._select(this._page * COLUMNS * ROWS);
            return;
        }

        const perPage = COLUMNS * ROWS;
        const page = Math.floor(this._selected / perPage);
        const slot = this._selected % perPage;
        let col = slot % COLUMNS + dx;
        let row = Math.floor(slot / COLUMNS) + dy;
        let targetPage = page;

        if (col < 0) {
            if (page === 0)
                return;
            targetPage--;
            col = COLUMNS - 1;
        } else if (col >= COLUMNS) {
            if (page === this._pageCount - 1)
                return;
            targetPage++;
            col = 0;
        }
        row = Math.max(0, Math.min(ROWS - 1, row));

        let index = targetPage * perPage + row * COLUMNS + col;
        if (index >= count)
            index = targetPage === page && dx === 0 ? this._selected : count - 1;
        this._select(index);
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        switch (symbol) {
        case Clutter.KEY_Escape:
            if (this._entry.text !== '')
                this._entry.text = '';
            else
                this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter: {
            const item = this._visibleItems[Math.max(0, this._selected)];
            if (item)
                this.launch(item);
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Left:
            this._moveSelection(-1, 0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
            this._moveSelection(1, 0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._moveSelection(0, -1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._moveSelection(0, 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._flipTo(this._page - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._flipTo(this._page + 1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}
