import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as RemoteSearch from 'resource:///org/gnome/shell/ui/remoteSearch.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import {AppSearchProvider} from 'resource:///org/gnome/shell/ui/appDisplay.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const PANEL_WIDTH = 680;
const PANEL_RADIUS = 16;
// Where the search bar sits, as a fraction of the monitor height.
const PANEL_TOP = 0.22;
const MAX_RESULTS_HEIGHT = 440;

const MAX_APP_RESULTS = 6;
const MAX_PROVIDER_RESULTS = 4;
const SEARCH_DELAY = 90;

const ROW_ICON_SIZE = 30;
const TOP_HIT_ICON_SIZE = 44;

const BLUR_RADIUS = 40;
const GLASS_SATURATION = 1.7;
const GLASS_BRIGHTNESS = 0.92;

const OPEN_DURATION = 180;
const CLOSE_DURATION = 140;
const RESIZE_DURATION = 160;

const KEYBINDING = 'switch-input-source';

function animationTime(ms) {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return 0;
    return Math.round(ms * settings.slow_down_factor);
}

// Masks the blurred glass to a rounded rectangle and gives it macOS's
// saturated "vibrancy". Shell.BlurEffect can only blur rectangles.
const SpotlightGlassEffect = GObject.registerClass({
    GTypeName: 'MacSpotlightGlassEffect',
}, class SpotlightGlassEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._sizeLocation = this.get_uniform_location('size');
        this.set_uniform_float(this.get_uniform_location('radius'), 1, [PANEL_RADIUS]);
        this.set_uniform_float(this.get_uniform_location('saturation'), 1, [GLASS_SATURATION]);
        this.set_uniform_float(this.get_uniform_location('brightness'), 1, [GLASS_BRIGHTNESS]);
    }

    setSize(width, height) {
        this.set_uniform_float(this._sizeLocation, 2, [width, height]);
    }

    vfunc_build_pipeline() {
        const declarations = `
            uniform vec2 size;
            uniform float radius;
            uniform float saturation;
            uniform float brightness;

            float rounded_rect_alpha(vec2 p) {
                vec2 q = abs(p - size * 0.5) - (size * 0.5 - radius);
                float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
                return clamp(0.5 - d, 0.0, 1.0);
            }
        `;
        const code = `
            vec3 c = cogl_color_out.rgb;
            float gray = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c = clamp(mix(vec3(gray), c, saturation) * brightness, 0.0, 1.0);
            float mask = rounded_rect_alpha(cogl_tex_coord_in[0].xy * size);
            cogl_color_out = vec4(c, cogl_color_out.a) * mask;
        `;
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, false);
    }
});

class ResultRow {
    constructor(spotlight, result, topHit) {
        this.result = result;

        this.actor = new St.Button({
            style_class: topHit ? 'macos-spotlight-row top-hit' : 'macos-spotlight-row',
            can_focus: false,
            track_hover: true,
            x_expand: true,
            button_mask: St.ButtonMask.ONE,
        });
        const box = new St.BoxLayout({style_class: 'macos-spotlight-row-box', x_expand: true});
        this.actor.set_child(box);

        const size = topHit ? TOP_HIT_ICON_SIZE : ROW_ICON_SIZE;
        const icon = result.createIcon(size) ?? new St.Icon({
            icon_name: 'text-x-generic-symbolic',
            icon_size: size,
        });
        const iconBin = new St.Bin({
            style_class: 'macos-spotlight-row-icon',
            width: size,
            height: size,
            y_align: Clutter.ActorAlign.CENTER,
            child: icon,
        });
        box.add_child(iconBin);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        box.add_child(text);

        const title = new St.Label({style_class: 'macos-spotlight-row-title', text: result.name});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(title);

        if (result.description) {
            const description = new St.Label({
                style_class: 'macos-spotlight-row-description',
                text: result.description.replace(/\s+/g, ' '),
            });
            description.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            text.add_child(description);
        }

        if (result.kind) {
            box.add_child(new St.Label({
                style_class: 'macos-spotlight-row-kind',
                text: result.kind,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        this.actor.connect('notify::hover', () => {
            if (this.actor.hover)
                spotlight.selectRow(this, false, true);
        });
        this.actor.connect('clicked', () => spotlight.activate(this.result));
    }

    set selected(value) {
        if (value)
            this.actor.add_style_pseudo_class('selected');
        else
            this.actor.remove_style_pseudo_class('selected');
    }
}

class Spotlight {
    constructor() {
        this._open = false;
        this._grab = null;
        this._searchId = 0;
        this._cancellable = null;
        this._sections = [];
        this._rows = [];
        this._selected = null;

        this._appProvider = new AppSearchProvider();
        this._systemActions = SystemActions.getDefault();
        this._searchSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
        this._searchSettings.connectObject('changed', () => this._loadProviders(), this);
        this._loadProviders();

        // Full-screen, invisible catcher: clicking outside the panel closes.
        this.actor = new St.Widget({
            name: 'macosSpotlight',
            reactive: true,
            visible: false,
        });
        this.actor.connect('destroy', () => this._onDestroy());
        this.actor.connect('button-press-event', (actor, event) => {
            const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,
                ...event.get_coords());
            if (target === this.actor)
                this.close();
            return Clutter.EVENT_STOP;
        });

        this._panel = new St.Widget({
            style_class: 'macos-spotlight-panel',
            clip_to_allocation: true,
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });

        // The panel clips to its edges, so its shadow is a sibling that
        // follows it around.
        this._shadow = new St.Widget({style_class: 'macos-spotlight-shadow'});
        for (const property of ['x', 'y', 'width', 'height', 'opacity', 'scale-x', 'scale-y', 'pivot-point'])
            this._panel.bind_property(property, this._shadow, property, GObject.BindingFlags.SYNC_CREATE);
        this.actor.add_child(this._shadow);
        this.actor.add_child(this._panel);

        // Frosted glass: a live copy of the desktop, blurred and rounded.
        this._glass = new Clutter.Actor({clip_to_allocation: true, x_expand: true, y_expand: true});
        this._glassClone = new Clutter.Clone({source: global.window_group});
        this._glass.add_child(this._glassClone);
        this._glassEffect = new SpotlightGlassEffect();
        this._glass.add_effect(this._glassEffect);
        this._glass.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS,
            brightness: 1,
        }));
        this._panel.add_child(this._glass);

        this._panel.add_child(new St.Widget({
            style_class: 'macos-spotlight',
            x_expand: true,
            y_expand: true,
        }));

        this._content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        this._panel.add_child(this._content);

        const header = new St.BoxLayout({style_class: 'macos-spotlight-header'});
        this._content.add_child(header);
        header.add_child(new St.Icon({
            style_class: 'macos-spotlight-search-icon',
            icon_name: 'system-search-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._entry = new St.Entry({
            style_class: 'macos-spotlight-entry',
            hint_text: 'Spotlight Araması',
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._entry.clutter_text.connect('text-changed', () => this._queueSearch());
        this._entry.clutter_text.connect('key-press-event',
            (actor, event) => this._onKeyPress(event));
        header.add_child(this._entry);

        this._separator = new St.Widget({style_class: 'macos-spotlight-separator', visible: false});
        this._content.add_child(this._separator);

        this._scrollView = new St.ScrollView({
            style_class: 'macos-spotlight-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            visible: false,
        });
        this._results = new St.BoxLayout({
            style_class: 'macos-spotlight-results',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scrollView.set_child(this._results);
        this._content.add_child(this._scrollView);

        this._panel.connect('notify::width', () => this._syncGlass());
        this._panel.connect('notify::height', () => this._syncGlass());

        Main.layoutManager.uiGroup.add_child(this.actor);
        Main.layoutManager.connectObject('monitors-changed', () => {
            if (this._open)
                this._relayout();
        }, this);
    }

    _loadProviders() {
        this._providers = RemoteSearch.loadRemoteSearchProviders(this._searchSettings);
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

        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        this._open = true;

        if (Main.overview.visible)
            Main.overview.hide();

        this._relayout();
        this.actor.get_parent().set_child_above_sibling(this.actor, null);
        this.actor.show();

        // Like macOS, reopening keeps the last query, fully selected.
        global.stage.set_key_focus(this._entry.clutter_text);
        this._entry.clutter_text.set_selection(0, this._entry.text.length);
        this._resize(false);

        const duration = animationTime(OPEN_DURATION);
        this._panel.opacity = 0;
        this._panel.set_scale(0.96, 0.96);
        this._panel.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (!this._open)
            return;
        this._open = false;
        this._cancelSearch();

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        this._panel.ease({
            opacity: 0,
            scale_x: 0.97,
            scale_y: 0.97,
            duration: animationTime(CLOSE_DURATION),
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (!this._open)
                    this.actor.hide();
            },
        });
    }

    destroy() {
        this.actor.destroy();
    }

    _onDestroy() {
        this._cancelSearch();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._searchSettings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
    }

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, monitor.height);

        const width = Math.min(PANEL_WIDTH, monitor.width - 32);
        this._panel.set_width(width);
        this._panel.set_position(Math.round((monitor.width - width) / 2),
            Math.round(monitor.height * PANEL_TOP));
        this._panel.set_pivot_point(0.5, 0);
        this._syncGlass();
    }

    _syncGlass() {
        const [width, height] = this._panel.get_size();
        this._glassEffect.setSize(width, height);
        this._glassClone.set_position(-(this.actor.x + this._panel.x),
            -(this.actor.y + this._panel.y));
    }

    // Grow or shrink the panel to fit the current results.
    _resize(animate = true) {
        const width = this._panel.width;
        const hasResults = this._rows.length > 0;
        this._separator.visible = hasResults;
        this._scrollView.visible = hasResults;

        this._scrollView.set_height(-1);
        let [, height] = this._content.get_preferred_height(width);
        if (hasResults) {
            const [, resultsHeight] = this._results.get_preferred_height(width);
            const clamped = Math.min(resultsHeight, MAX_RESULTS_HEIGHT);
            this._scrollView.set_height(clamped);
            [, height] = this._content.get_preferred_height(width);
        }

        this._panel.remove_transition('height');
        if (animate && this._open) {
            this._panel.ease({
                height,
                duration: animationTime(RESIZE_DURATION),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._panel.height = height;
        }
    }

    _queueSearch() {
        if (this._searchId)
            GLib.source_remove(this._searchId);
        this._searchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY, () => {
            this._searchId = 0;
            this._search().catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelSearch() {
        if (this._searchId) {
            GLib.source_remove(this._searchId);
            this._searchId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    async _search() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const text = this._entry.text.trim();
        const terms = text.split(/\s+/).filter(t => t.length > 0);
        this._terms = terms;

        if (terms.length === 0) {
            this._activateWhenReady = false;
            this._sections = [];
            this._render();
            return;
        }

        const sections = [];
        this._sections = sections;
        this._userSelected = false;

        // Apps first: they're local and instant.
        const appSection = await this._searchApps(terms, cancellable);
        if (cancellable.is_cancelled())
            return;
        sections.push(...appSection);
        sections.push(this._webSection(text));
        this._render();

        if (this._activateWhenReady) {
            this._activateWhenReady = false;
            if (this._selected)
                this.activate(this._selected.result);
            return;
        }

        // Then each search provider, in the user's configured order, filling
        // in as it answers.
        const pending = this._providers.map(async (provider, order) => {
            const section = await this._searchProvider(provider, terms, cancellable);
            if (cancellable.is_cancelled() || !section)
                return;
            section.order = order;
            const web = sections.pop();
            sections.push(section);
            sections.sort((a, b) => (a.order ?? -1) - (b.order ?? -1));
            sections.push(web);
            this._render();
        });
        await Promise.all(pending);
    }

    async _searchApps(terms, cancellable) {
        let ids;
        try {
            ids = await this._appProvider.getInitialResultSet(terms, cancellable);
        } catch (e) {
            logError(e);
            return [];
        }
        ids = ids.slice(0, MAX_APP_RESULTS + 1);
        const metas = await this._appProvider.getResultMetas(ids, cancellable);

        const results = metas.map(meta => {
            const isApp = meta.id.endsWith('.desktop');
            const app = isApp ? Shell.AppSystem.get_default().lookup_app(meta.id) : null;
            return {
                key: `app:${meta.id}`,
                name: meta.name,
                description: isApp ? app?.get_description() ?? '' : '',
                kind: isApp ? 'Uygulama' : 'Sistem',
                createIcon: meta.createIcon,
                activate: () => {
                    if (app)
                        app.activate();
                    else
                        this._systemActions.activateAction(meta.id);
                },
            };
        });

        if (results.length === 0)
            return [];

        const [top, ...rest] = results;
        const sections = [{title: 'En İyi Sonuç', results: [top], topHit: true}];
        if (rest.length > 0)
            sections.push({title: 'Uygulamalar', results: rest.slice(0, MAX_APP_RESULTS - 1)});
        return sections;
    }

    async _searchProvider(provider, terms, cancellable) {
        try {
            let ids = await provider.getInitialResultSet(terms, cancellable);
            if (cancellable.is_cancelled() || ids.length === 0)
                return null;
            ids = provider.filterResults(ids, MAX_PROVIDER_RESULTS);
            const metas = await provider.getResultMetas(ids, cancellable);
            if (cancellable.is_cancelled() || metas.length === 0)
                return null;

            const providerName = provider.appInfo.get_name();
            return {
                title: providerName,
                results: metas.map(meta => ({
                    key: `${provider.id}:${meta.id}`,
                    name: meta.name,
                    description: meta.description ?? '',
                    createIcon: size => meta.createIcon(size) ??
                        new St.Icon({gicon: provider.appInfo.get_icon(), icon_size: size}),
                    activate: () => provider.activateResult(meta.id, terms),
                })),
            };
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, `Spotlight: ${provider.id}`);
            return null;
        }
    }

    _webSection(text) {
        return {
            title: 'Web',
            results: [{
                key: 'web',
                name: `“${text}” için web'de ara`,
                description: '',
                createIcon: size => new St.Icon({
                    icon_name: 'web-browser-symbolic',
                    icon_size: size,
                    style_class: 'macos-spotlight-web-icon',
                }),
                activate: () => {
                    const uri = `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
                    Gio.AppInfo.launch_default_for_uri_async(uri,
                        global.create_app_launch_context(0, -1), null, null);
                },
            }],
        };
    }

    _render() {
        const previousKey = this._selected?.result.key;
        this._results.destroy_all_children();
        this._rows = [];
        this._selected = null;

        for (const section of this._sections) {
            if (section.results.length === 0)
                continue;
            this._results.add_child(new St.Label({
                style_class: 'macos-spotlight-section',
                text: section.title,
            }));
            for (const result of section.results) {
                const row = new ResultRow(this, result, section.topHit);
                this._rows.push(row);
                this._results.add_child(row.actor);
            }
        }

        // Once the user has picked a row, late results must not steal the
        // selection; until then the best result stays selected.
        const keep = this._userSelected
            ? this._rows.find(r => r.result.key === previousKey) : null;
        this.selectRow(keep ?? this._rows[0] ?? null, false);
        this._resize();
    }

    selectRow(row, scroll = true, byUser = false) {
        if (byUser)
            this._userSelected = true;
        if (this._selected)
            this._selected.selected = false;
        this._selected = row;
        if (!row)
            return;
        row.selected = true;
        if (scroll)
            this._scrollToRow(row);
    }

    _scrollToRow(row) {
        const adjustment = this._scrollView.vadjustment;
        const box = row.actor.get_allocation_box();
        const [value, , , , , pageSize] = adjustment.get_values();
        if (box.y1 < value + 24)
            adjustment.value = Math.max(0, box.y1 - 24);
        else if (box.y2 > value + pageSize)
            adjustment.value = box.y2 - pageSize + 6;
    }

    _moveSelection(delta) {
        if (this._rows.length === 0)
            return;
        const index = this._rows.indexOf(this._selected);
        const next = Math.max(0, Math.min(this._rows.length - 1, index + delta));
        this.selectRow(this._rows[next], true, true);
    }

    activate(result) {
        try {
            result.activate();
        } catch (e) {
            logError(e, 'Spotlight');
        }
        this.close();
    }

    _onKeyPress(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            if (this._entry.text !== '')
                this._entry.text = '';
            else
                this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            // Results lag the text by SEARCH_DELAY; run the search now so a
            // quick type-and-enter still hits the right thing.
            if (this._searchId) {
                this._cancelSearch();
                this._activateWhenReady = true;
                this._search().catch(logError);
            } else if (this._selected) {
                this.activate(this._selected.result);
            }
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._moveSelection(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            const back = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
            this._moveSelection(back ? -1 : 1);
            return Clutter.EVENT_STOP;
        }
        }
        return Clutter.EVENT_PROPAGATE;
    }
}

export default class MacosSpotlightExtension extends Extension {
    enable() {
        this._spotlight = new Spotlight();

        // Super+Space, like Cmd+Space on macOS. It is normally the input
        // source switcher; with more than one layout configured we leave
        // that alone and only take Super+Space when it would do nothing.
        const sources = getInputSourceManager();
        Main.wm.setCustomKeybindingHandler(KEYBINDING,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            (display, window, event, binding) => {
                if (this._spotlight.isOpen || sources._mruSources.length < 2)
                    this._spotlight.toggle();
                else
                    sources._switchInputSource(display, window, event, binding);
            });
    }

    disable() {
        const sources = getInputSourceManager();
        Main.wm.setCustomKeybindingHandler(KEYBINDING,
            Shell.ActionMode.ALL,
            sources._switchInputSource.bind(sources));

        this._spotlight.destroy();
        this._spotlight = null;
    }
}
