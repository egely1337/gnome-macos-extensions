import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

// The frosted glass behind the bar: blur, then the saturation boost that
// gives macOS materials their "vibrancy".
const BLUR_RADIUS = 36;
const GLASS_SATURATION = 1.9;
const GLASS_BRIGHTNESS = 0.92;
// The glass is blurred this far past the bar's bottom edge and then cut off,
// so the blur doesn't fade out towards the edge.
const GLASS_BLEED = 40;

const OVERVIEW_FADE = 250;
const INTRO_DURATION = 560;
const INTRO_STAGGER = 45;
const INTRO_DROP = 10;
const TITLE_FADE = 110;
const TITLE_SHIFT = 4;
const ABOUT_POP_DURATION = 320;

const ABOUT_LOGO_SIZE = 104;

// Control Center: GNOME's quick settings, on a thicker pane of glass.
// CONTROL_CENTER_RADIUS must match .macos-control-center .quick-settings.
const CONTROL_CENTER_RADIUS = 22;
const CONTROL_CENTER_BLUR = 44;
const CONTROL_CENTER_SATURATION = 2.0;
const CONTROL_CENTER_BRIGHTNESS = 0.82;

const SPOTLIGHT_UUID = 'macos-spotlight@egely1337';
// Clicking the desktop focuses no app; like Finder on macOS, the file
// manager then owns the bar.
const DESKTOP_APP_ID = 'org.gnome.Nautilus.desktop';

function animationTime(ms) {
    const settings = St.Settings.get();
    if (!settings.enable_animations)
        return 0;
    return Math.round(ms * settings.slow_down_factor);
}

function readFile(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return '';
    }
}

function launchApp(id) {
    const app = Shell.AppSystem.get_default().lookup_app(id);
    if (app) {
        app.activate();
        Main.overview.hide();
    }
    return app !== null;
}

function toggleSpotlight() {
    const spotlight = Main.extensionManager.lookup(SPOTLIGHT_UUID)?.stateObj?._spotlight;
    if (spotlight)
        spotlight.toggle();
    else
        Main.overview.toggle();
}

// Our menus drop straight down from the left edge of their button, without
// GNOME's pointer arrow.
function styleMenu(menu) {
    menu.actor.add_style_class_name('macos-menubar-menu');
    menu._arrowAlignment = 0;
    menu.setSourceAlignment(0);
}

// Fills a menu right before it opens, so it always shows the current state.
// This can't wait for open-state-changed: an empty menu never opens.
function rebuildOnOpen(menu, rebuild) {
    const open = menu.open.bind(menu);
    menu.open = animate => {
        rebuild();
        open(animate);
    };
}

function addMenuItem(menu, label, callback, shortcut = null) {
    const item = new PopupMenu.PopupMenuItem(label);
    if (shortcut) {
        item.add_child(new St.Label({
            style_class: 'macos-menubar-shortcut',
            text: shortcut,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        }));
    }
    item.connect('activate', callback);
    menu.addMenuItem(item);
    return item;
}

function addSeparator(menu) {
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
}

// Saturates and brightens the blurred glass, and lays a faint sheen along
// the top edge where light would catch it.
const MenubarGlassEffect = GObject.registerClass({
    GTypeName: 'MacMenubarGlassEffect',
}, class MenubarGlassEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._barHeightLocation = this.get_uniform_location('bar_height');
        this.set_uniform_float(this.get_uniform_location('saturation'), 1, [GLASS_SATURATION]);
        this.set_uniform_float(this.get_uniform_location('brightness'), 1, [GLASS_BRIGHTNESS]);
        this.setBarHeight(1);
    }

    setBarHeight(height) {
        this._barHeight = Math.max(height, 1);
        this.set_uniform_float(this._barHeightLocation, 1, [this._barHeight]);
    }

    vfunc_build_pipeline() {
        const declarations = `
            uniform float bar_height;
            uniform float saturation;
            uniform float brightness;
        `;
        const code = `
            vec3 c = cogl_color_out.rgb;
            float gray = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c = mix(vec3(gray), c, saturation) * brightness;

            float y = cogl_tex_coord_in[0].y * (bar_height + ${GLASS_BLEED.toFixed(1)});
            c += vec3(0.07) * (1.0 - smoothstep(0.0, bar_height, y));

            cogl_color_out = vec4(clamp(c, 0.0, 1.0), cogl_color_out.a);
        `;
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, false);
    }
});

// A live, blurred copy of whatever is under the bar. It sits just below the
// panel and follows it: hidden with it over fullscreen windows, and faded out
// in the overview, where GNOME's own bar turns transparent.
class MenubarGlass {
    constructor() {
        const panelBox = Main.layoutManager.panelBox;

        this.actor = new St.Widget({
            name: 'macosMenubarGlass',
            clip_to_allocation: true,
        });
        // Follows panelBox from _sync(); a BindConstraint wouldn't copy its
        // position.
        this._bindings = ['visible', 'translation-y'].map(property =>
            panelBox.bind_property(property, this.actor, property,
                GObject.BindingFlags.SYNC_CREATE));

        this._glass = new Clutter.Actor({clip_to_allocation: true});
        this._clone = new Clutter.Clone({source: global.window_group});
        this._glass.add_child(this._clone);
        this._effect = new MenubarGlassEffect();
        this._glass.add_effect(this._effect);
        this._glass.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS,
            brightness: 1,
        }));
        this.actor.add_child(this._glass);

        this._tint = new St.Widget({style_class: 'macos-menubar'});
        this.actor.add_child(this._tint);

        panelBox.connectObject(
            'notify::x', () => this._sync(),
            'notify::y', () => this._sync(),
            'notify::width', () => this._sync(),
            'notify::height', () => this._sync(),
            this);

        Main.overview.connectObject(
            'showing', () => this._fade(0),
            'hiding', () => this._fade(255),
            this);
        this.actor.opacity = Main.overview.visible ? 0 : 255;

        Main.layoutManager.uiGroup.insert_child_below(this.actor, panelBox);
        this._sync();
    }

    _sync() {
        const panelBox = Main.layoutManager.panelBox;
        const [width, height] = panelBox.get_size();
        this.actor.set_position(panelBox.x, panelBox.y);
        this.actor.set_size(width, height);
        this._glass.set_size(width, height + GLASS_BLEED);
        this._tint.set_size(width, height);
        this._effect.setBarHeight(height);
        this._clone.set_position(-panelBox.x, -panelBox.y);
    }

    _fade(opacity) {
        this.actor.ease({
            opacity,
            duration: animationTime(OVERVIEW_FADE),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    destroy() {
        this._bindings.forEach(binding => binding.unbind());
        Main.layoutManager.panelBox.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this.actor.destroy();
    }
}

// Masks the blurred Control Center glass to a rounded rectangle and saturates
// it. Shell.BlurEffect can only blur rectangles.
const ControlCenterGlassEffect = GObject.registerClass({
    GTypeName: 'MacControlCenterGlassEffect',
}, class ControlCenterGlassEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._sizeLocation = this.get_uniform_location('size');
        this.set_uniform_float(this.get_uniform_location('radius'), 1, [CONTROL_CENTER_RADIUS]);
        this.set_uniform_float(this.get_uniform_location('saturation'), 1, [CONTROL_CENTER_SATURATION]);
        this.set_uniform_float(this.get_uniform_location('brightness'), 1, [CONTROL_CENTER_BRIGHTNESS]);
        this.setSize(1, 1);
    }

    setSize(width, height) {
        this.set_uniform_float(this._sizeLocation, 2, [Math.max(width, 1), Math.max(height, 1)]);
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

// Turns GNOME's quick settings into macOS's Control Center: the stylesheet
// restyles the toggles into modules, and this lays live frosted glass under
// the menu. The glass is a sibling of the menu's box pointer that copies its
// geometry and open/close animation, so it never touches GNOME's layout.
class ControlCenter {
    constructor(extension) {
        this._extension = extension;
        this._menu = Main.panel.statusArea.quickSettings.menu;
        this._boxPointer = this._menu._boxPointer;

        // On the menu's root, so the toggles' sub-menus, which live in an
        // overlay next to the box pointer, are styled too.
        this._menu.actor.add_style_class_name('macos-control-center');

        // Positioned by _sync(): a BindConstraint here only copies the box
        // pointer's size, leaving the glass in the screen's top-left corner.
        this._mirror = new Clutter.Actor();
        this._bindings = ['visible', 'opacity', 'pivot-point', 'scale-x', 'scale-y',
            'translation-x', 'translation-y'].map(property =>
            this._boxPointer.bind_property(property, this._mirror, property,
                GObject.BindingFlags.SYNC_CREATE));

        // St skips the shadow of a see-through widget, so this one is solid;
        // the glass on top hides everything but the shadow.
        this._shadow = new St.Widget({style_class: 'macos-control-center-shadow'});
        this._mirror.add_child(this._shadow);

        this._glass = new Clutter.Actor({clip_to_allocation: true});
        this._clone = new Clutter.Clone({source: global.window_group});
        this._glass.add_child(this._clone);
        this._effect = new ControlCenterGlassEffect();
        this._glass.add_effect(this._effect);
        this._glass.add_effect(new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: CONTROL_CENTER_BLUR,
            brightness: 1,
        }));
        this._mirror.add_child(this._glass);
        this._menu.actor.insert_child_below(this._mirror, this._boxPointer);

        // The box pointer places itself inside its own allocation without
        // announcing it, so the glass catches up once each frame is laid out.
        // Tied to the mirror, which goes when GNOME tears the menu down.
        global.stage.connectObject('after-update', () => this._sync(), this._mirror);

        rebuildOnOpen(this._menu, () => this._addAboutButton());
    }

    _sync() {
        const boxPointer = this._boxPointer;
        if (!boxPointer.mapped)
            return;

        const box = this._menu.box;
        const x = boxPointer.bin.x + box.x;
        const y = boxPointer.bin.y + box.y;
        const [width, height] = box.get_size();
        const root = this._menu.actor;
        const geometry = [boxPointer.x, boxPointer.y, boxPointer.width, boxPointer.height,
            x, y, width, height, root.x, root.y].join();
        // Moving anything schedules another frame, so only move on change.
        if (geometry === this._geometry)
            return;
        this._geometry = geometry;

        this._mirror.set_position(boxPointer.x, boxPointer.y);
        this._mirror.set_size(boxPointer.width, boxPointer.height);
        for (const actor of [this._shadow, this._glass]) {
            actor.set_position(x, y);
            actor.set_size(width, height);
        }
        this._effect.setSize(width, height);
        this._clone.set_position(-(root.x + boxPointer.x + x),
            -(root.y + boxPointer.y + y));
    }

    // With the system menu gone from the bar, About This Computer sits in
    // the row with Settings and Lock. GNOME builds that row asynchronously,
    // so it's added on the first open.
    _addAboutButton() {
        const systemItem = Main.panel.statusArea.quickSettings._system?._systemItem;
        if (this._aboutButton || !systemItem)
            return;

        this._aboutButton = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            accessible_name: 'Bu Bilgisayar Hakkında',
            child: new St.Icon({icon_name: 'help-about-symbolic'}),
        });
        this._aboutButton.connect('clicked', () => {
            Main.panel.closeQuickSettings();
            this._extension.showAbout();
        });
        systemItem.child.insert_child_below(this._aboutButton, systemItem._desktopSpacer);
    }

    destroy() {
        global.stage.disconnectObject(this._mirror);
        delete this._menu.open;
        this._bindings.forEach(binding => binding.unbind());
        this._aboutButton?.destroy();
        this._mirror.destroy();
        this._menu.actor.remove_style_class_name('macos-control-center');
    }
}

// Everything "About This Mac" shows, read from the running system.
function systemInfo() {
    const dmi = name => readFile(`/sys/devices/virtual/dmi/id/${name}`);
    const vendor = dmi('sys_vendor');
    // Lenovo keeps the marketing name in product_version, everyone else in
    // product_name. Strip placeholder suffixes like "16-ap0xxx".
    let model = vendor === 'LENOVO' ? dmi('product_version') : dmi('product_name');
    model = model.replace(/[-\s]\w*x{2,}\w*$/i, '').trim();

    const cpuinfo = readFile('/proc/cpuinfo');
    const cpu = cpuinfo.match(/^model name\s*:\s*(.+)$/m)?.[1].trim() ?? '';
    const threads = GLib.get_num_processors();

    const memKb = Number(readFile('/proc/meminfo').match(/^MemTotal:\s*(\d+)/m)?.[1] ?? 0);
    // MemTotal leaves out what the firmware and GPU reserve; round up to
    // what is actually installed.
    const memGb = Math.ceil(memKb / 1024 / 1024 / 2) * 2;

    const monitor = Main.layoutManager.primaryMonitor;
    const scale = monitor?.geometry_scale ?? 1;
    const display = monitor
        ? `${Math.round(monitor.width * scale)} × ${Math.round(monitor.height * scale)}`
        : '';

    const uptimeSeconds = Math.floor(Number(readFile('/proc/uptime').split(' ')[0]) || 0);
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor(uptimeSeconds % 86400 / 3600);
    const minutes = Math.floor(uptimeSeconds % 3600 / 60);
    const uptime = [
        days ? `${days} gün` : '',
        hours ? `${hours} sa` : '',
        `${minutes} dk`,
    ].filter(Boolean).join(' ');

    return {
        model: model || GLib.get_host_name(),
        subtitle: [vendor, GLib.get_host_name()].filter(Boolean).join(' · '),
        rows: [
            ['İşlemci', cpu ? `${cpu} (${threads} iş parçacığı)` : `${threads} iş parçacığı`],
            ['Grafik', '…'],
            ['Bellek', memGb ? `${memGb} GB` : '—'],
            ['Ekran', display],
            ['Sistem', GLib.get_os_info('PRETTY_NAME') ?? 'Linux'],
            ['Masaüstü', `GNOME ${Config.PACKAGE_VERSION}`],
            ['Çekirdek', readFile('/proc/sys/kernel/osrelease')],
            ['Açık Kalma', uptime],
        ],
    };
}

async function graphicsInfo() {
    const proc = new Gio.Subprocess({
        argv: ['lspci', '-mm'],
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    proc.init(null);
    const [stdout] = await proc.communicate_utf8_async(null, null);
    const vendors = [[/AMD|ATI/, 'AMD'], [/NVIDIA/i, 'NVIDIA'], [/Intel/, 'Intel']];
    return stdout.split('\n')
        .map(line => [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]))
        .filter(([cls]) => /VGA|3D|Display/.test(cls ?? ''))
        .map(([, vendor, device]) => {
            // "Krackan [Radeon 840M / 860M Graphics]" → the bracketed name.
            const name = device.match(/\[(.+)\]/)?.[1] ?? device;
            const brand = vendors.find(([re]) => re.test(vendor))?.[1];
            return brand && !name.includes(brand) ? `${brand} ${name}` : name;
        })
        .join('\n');
}

function osLogo() {
    const logo = GLib.get_os_info('LOGO');
    for (const path of [`/usr/share/icons/${logo}.svg`, `/usr/share/pixmaps/${logo}.svg`,
        `/usr/share/pixmaps/${logo}.png`]) {
        if (logo && GLib.file_test(path, GLib.FileTest.EXISTS))
            return Gio.icon_new_for_string(path);
    }
    return new Gio.ThemedIcon({names: [logo ?? '', 'distributor-logo', 'computer']});
}

const AboutDialog = GObject.registerClass(
class AboutDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({styleClass: 'macos-about'});

        const info = systemInfo();
        const box = new St.BoxLayout({
            style_class: 'macos-about-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.contentLayout.add_child(box);

        box.add_child(new St.Icon({
            style_class: 'macos-about-logo',
            gicon: osLogo(),
            icon_size: ABOUT_LOGO_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            style_class: 'macos-about-title',
            text: info.model,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            style_class: 'macos-about-subtitle',
            text: info.subtitle,
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const grid = new Clutter.GridLayout({
            orientation: Clutter.Orientation.VERTICAL,
        });
        const table = new St.Widget({
            style_class: 'macos-about-table',
            layout_manager: grid,
            x_align: Clutter.ActorAlign.CENTER,
        });
        grid.hookup_style(table);
        box.add_child(table);

        info.rows.forEach(([key, value], row) => {
            grid.attach(new St.Label({
                style_class: 'macos-about-key',
                text: key,
                x_align: Clutter.ActorAlign.END,
            }), 0, row, 1, 1);
            const label = new St.Label({
                style_class: 'macos-about-value',
                text: value,
                x_align: Clutter.ActorAlign.START,
            });
            label.clutter_text.line_wrap = true;
            grid.attach(label, 1, row, 1, 1);
            if (key === 'Grafik')
                this._graphicsLabel = label;
        });

        graphicsInfo().then(text => {
            if (this._graphicsLabel)
                this._graphicsLabel.text = text || '—';
        }).catch(() => {
            if (this._graphicsLabel)
                this._graphicsLabel.text = '—';
        });
        this.connect('destroy', () => (this._graphicsLabel = null));

        box.add_child(new St.Label({
            style_class: 'macos-about-footer',
            text: '™ ve © GNOME Projesi ve katkıda bulunanlar.',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        this.addButton({
            label: 'Daha Fazla Bilgi…',
            action: () => {
                this.close();
                launchApp('org.gnome.Settings.desktop');
            },
        });
        this.addButton({
            label: 'Tamam',
            action: () => this.close(),
            key: Clutter.KEY_Escape,
            default: true,
        });
    }

    open() {
        if (!super.open())
            return false;
        const dialog = this.dialogLayout;
        dialog.set_pivot_point(0.5, 0.5);
        dialog.set_scale(0.86, 0.86);
        dialog.ease({
            scale_x: 1,
            scale_y: 1,
            duration: animationTime(ABOUT_POP_DURATION),
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        return true;
    }
});

// The GNOME foot where macOS has its Apple menu: about, settings and the
// session's power actions.
const LogoMenuButton = GObject.registerClass(
class LogoMenuButton extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'GNOME');
        this.add_style_class_name('macos-menubar-logo-button');
        this.add_child(new St.Icon({
            style_class: 'macos-menubar-logo',
            icon_name: 'start-here-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        styleMenu(this.menu);

        const actions = SystemActions.getDefault();
        addMenuItem(this.menu, 'Bu Bilgisayar Hakkında', () => extension.showAbout());
        addSeparator(this.menu);
        addMenuItem(this.menu, 'Sistem Ayarları…', () => launchApp('org.gnome.Settings.desktop'));
        if (Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop'))
            addMenuItem(this.menu, 'Yazılım…', () => launchApp('org.gnome.Software.desktop'));
        addSeparator(this.menu);
        addMenuItem(this.menu, 'Uyku', () => actions.activateSuspend());
        addMenuItem(this.menu, 'Yeniden Başlat…', () => actions.activateRestart());
        addMenuItem(this.menu, 'Kapat…', () => actions.activatePowerOff());
        addSeparator(this.menu);
        addMenuItem(this.menu, 'Ekranı Kilitle', () => actions.activateLockScreen());
        addMenuItem(this.menu, 'Oturumu Kapat…', () => actions.activateLogout());
    }
});

// The bold name of the focused app, with that app's menu.
const AppMenuButton = GObject.registerClass(
class AppMenuButton extends PanelMenu.Button {
    _init() {
        super._init(0.0, null, true);
        this.add_style_class_name('macos-menubar-app');

        this._label = new St.Label({
            style_class: 'macos-menubar-app-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);
        this.label_actor = this._label;

        this._menu = new AppMenu(this, St.Side.TOP, {
            favoritesSection: true,
            showSingleWindows: true,
        });
        styleMenu(this._menu);
        this.setMenu(this._menu);
        this._addHideItems();

        this._app = undefined;
        this._tracker = Shell.WindowTracker.get_default();
        this._tracker.connectObject('notify::focus-app', () => this._sync(), this);
        Shell.AppSystem.get_default().connectObject(
            'app-state-changed', () => this._sync(), this);
        this._sync();
    }

    // macOS's Hide and Hide Others, slotted in just above Quit.
    _addHideItems() {
        const section = new PopupMenu.PopupMenuSection();
        addMenuItem(section, 'Gizle', () => {
            for (const window of this._app?.get_windows() ?? [])
                window.minimize();
        });
        addMenuItem(section, 'Diğerlerini Gizle', () => {
            const workspace = global.workspace_manager.get_active_workspace();
            for (const window of workspace.list_windows()) {
                if (this._tracker.get_window_app(window) !== this._app && !window.skip_taskbar)
                    window.minimize();
            }
        });
        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._hideSection = section;

        const items = this._menu._getMenuItems();
        const quitIndex = items.indexOf(this._menu._quitItem);
        this._menu.addMenuItem(section, quitIndex < 0 ? undefined : quitIndex);
    }

    _sync() {
        const app = this._tracker.focus_app ??
            Shell.AppSystem.get_default().lookup_app(DESKTOP_APP_ID);
        this.visible = app !== null;
        this._hideSection.actor.visible = app?.state === Shell.AppState.RUNNING;
        if (app === this._app)
            return;

        const first = this._app === undefined;
        this._app = app;
        this._menu.setApp(app);
        const name = app?.get_name() ?? '';

        if (first) {
            this._label.text = name;
            return;
        }

        // The old name lifts away, the new one settles in from below.
        this._label.remove_all_transitions();
        this._label.ease({
            opacity: 0,
            translation_y: -TITLE_SHIFT,
            duration: animationTime(TITLE_FADE),
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._label.text = name;
                this._label.translation_y = TITLE_SHIFT;
                this._label.ease({
                    opacity: 255,
                    translation_y: 0,
                    duration: animationTime(TITLE_FADE * 1.6),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            },
        });
    }

    _onDestroy() {
        this._tracker.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        super._onDestroy();
    }
});

// macOS's Window menu: arrange, fill, float on top, and every window of the
// focused app.
const WindowMenuButton = GObject.registerClass(
class WindowMenuButton extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Pencere');
        this.add_child(new St.Label({
            style_class: 'macos-menubar-title',
            text: 'Pencere',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        styleMenu(this.menu);

        rebuildOnOpen(this.menu, () => this._rebuild());
        global.display.connectObject('notify::focus-window', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const window = global.display.focus_window;
        this.visible = window !== null && !window.skip_taskbar;
    }

    _rebuild() {
        const menu = this.menu;
        menu.removeAll();
        const window = global.display.focus_window;
        if (!window)
            return;

        const minimize = addMenuItem(menu, 'Küçült', () => window.minimize(), '⌘H');
        minimize.setSensitive(window.can_minimize());
        const zoom = addMenuItem(menu, window.is_maximized() ? 'Önceki Boyut' : 'Büyüt', () => {
            if (window.is_maximized())
                window.unmaximize();
            else
                window.maximize();
        }, '⌘↑');
        zoom.setSensitive(window.can_maximize());
        addSeparator(menu);

        // Maximized windows report themselves as fixed, but arranging
        // unmaximizes them first.
        const canArrange = window.is_maximized() ||
            (window.allows_move() && window.allows_resize());
        const arrange = (label, rect) => {
            const item = addMenuItem(menu, label, () => {
                if (window.is_maximized())
                    window.unmaximize();
                if (window.is_fullscreen())
                    window.unmake_fullscreen();
                const area = window.get_work_area_current_monitor();
                const r = rect(area);
                window.move_resize_frame(true, r.x, r.y, r.width, r.height);
            });
            item.setSensitive(canArrange);
        };
        arrange('Sola Yasla', a => ({x: a.x, y: a.y, width: Math.floor(a.width / 2), height: a.height}));
        arrange('Sağa Yasla', a => ({
            x: a.x + Math.ceil(a.width / 2), y: a.y,
            width: Math.floor(a.width / 2), height: a.height,
        }));
        arrange('Ekranı Doldur', a => a);
        arrange('Ortala', a => {
            const frame = window.get_frame_rect();
            const width = Math.min(frame.width, a.width);
            const height = Math.min(frame.height, a.height);
            return {
                x: a.x + Math.round((a.width - width) / 2),
                y: a.y + Math.round((a.height - height) / 2),
                width, height,
            };
        });
        addSeparator(menu);

        const fullscreen = addMenuItem(menu, 'Tam Ekran', () => {
            if (window.is_fullscreen())
                window.unmake_fullscreen();
            else
                window.make_fullscreen();
        });
        fullscreen.setOrnament(window.is_fullscreen()
            ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        const above = addMenuItem(menu, 'Her Zaman Üstte', () => {
            if (window.is_above())
                window.unmake_above();
            else
                window.make_above();
        });
        above.setOrnament(window.is_above()
            ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);

        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const windows = (app?.get_windows() ?? []).filter(w => !w.skip_taskbar);
        if (windows.length > 1) {
            addSeparator(menu);
            addMenuItem(menu, 'Tümünü Öne Getir', () => {
                const time = global.get_current_time();
                for (const w of [...windows].reverse())
                    w.raise();
                Main.activateWindow(window, time);
            });
        }
        if (windows.length > 0) {
            addSeparator(menu);
            for (const w of windows) {
                const item = addMenuItem(menu, w.get_title() || app.get_name(),
                    () => Main.activateWindow(w));
                item.setOrnament(w === window ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }
        }

        addSeparator(menu);
        const close = addMenuItem(menu, 'Pencereyi Kapat',
            () => window.delete(global.get_current_time()), '⌘W');
        close.setSensitive(window.can_close());
    }

    _onDestroy() {
        global.display.disconnectObject(this);
        super._onDestroy();
    }
});

const SpotlightButton = GObject.registerClass(
class SpotlightButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Spotlight', true);
        this.add_style_class_name('macos-menubar-spotlight');
        this.add_child(new St.Icon({
            style_class: 'system-status-icon',
            icon_name: 'system-search-symbolic',
        }));

        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => toggleSpotlight());
        this.add_action(click);
    }

    vfunc_key_release_event(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_space) {
            toggleSpotlight();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});

// Replaces GNOME's centred clock text with macOS's "Thu 8 Oct  14:32".
// The calendar menu itself is kept.
class MenubarClock {
    constructor(dateMenu) {
        this._original = dateMenu._clockDisplay;

        this._label = new St.Label({
            style_class: 'clock macos-menubar-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._original.get_parent().insert_child_above(this._label, this._original);
        this._original.hide();

        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._settings.connectObject(
            'changed::clock-format', () => this._update(),
            'changed::clock-show-seconds', () => this._update(),
            this);
        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connectObject('notify::clock', () => this._update(), this);
        this._update();
    }

    _update() {
        const twelveHour = this._settings.get_string('clock-format') === '12h';
        const seconds = this._settings.get_boolean('clock-show-seconds') ? ':%S' : '';
        const time = twelveHour ? `%-I:%M${seconds} %p` : `%H:%M${seconds}`;
        this._label.text = GLib.DateTime.new_now_local().format(`%a %-d %b  ${time}`);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._wallClock.disconnectObject(this);
        this._wallClock.run_dispose();
        this._label.destroy();
        this._original.show();
    }
}

export default class MacosMenubarExtension extends Extension {
    enable() {
        const panel = Main.panel;
        panel.add_style_class_name('macos-menubar-panel');

        this._glass = new MenubarGlass();

        this._logoButton = new LogoMenuButton(this);
        this._appButton = new AppMenuButton();
        this._windowButton = new WindowMenuButton();
        panel.addToStatusArea(`${this.uuid}-logo`, this._logoButton, 0, 'left');
        panel.addToStatusArea(`${this.uuid}-app`, this._appButton, 1, 'left');
        panel.addToStatusArea(`${this.uuid}-window`, this._windowButton, 2, 'left');

        this._spotlightButton = new SpotlightButton();
        const quickSettings = panel.statusArea.quickSettings?.container;
        const index = Math.max(panel._rightBox.get_children().indexOf(quickSettings), 0);
        panel.addToStatusArea(`${this.uuid}-spotlight`, this._spotlightButton, index, 'right');

        this._clock = panel.statusArea.dateMenu ? new MenubarClock(panel.statusArea.dateMenu) : null;
        this._controlCenter = panel.statusArea.quickSettings ? new ControlCenter(this) : null;

        this._arrangePanel();
        Main.sessionMode.connectObject('updated', () => this._arrangePanel(), this);

        this._playIntro();
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        const panel = Main.panel;

        for (const actor of this._introActors ?? []) {
            actor.remove_all_transitions();
            actor.opacity = 255;
            actor.translation_y = 0;
        }
        this._introActors = null;

        this._about?.destroy();
        this._about = null;

        this._clock?.destroy();
        this._clock = null;
        this._controlCenter?.destroy();
        this._controlCenter = null;

        for (const button of [this._logoButton, this._appButton, this._windowButton, this._spotlightButton])
            button.destroy();
        this._logoButton = this._appButton = this._windowButton = this._spotlightButton = null;

        const activities = panel.statusArea.activities?.container;
        if (activities && Main.sessionMode.panel.left.includes('activities'))
            activities.show();

        this._glass.destroy();
        this._glass = null;
        panel.remove_style_class_name('macos-menubar-panel');
    }

    showAbout() {
        if (this._about)
            return;
        this._about = new AboutDialog();
        this._about.connect('destroy', () => (this._about = null));
        this._about.open();
    }

    // GNOME puts its items back whenever the session mode changes, so this
    // runs again then.
    _arrangePanel() {
        Main.panel.statusArea.activities?.container.hide();
    }

    // The bar's items drop into place one after another, from both ends
    // towards the middle, where the clock lands last.
    _playIntro() {
        if (Main.layoutManager._startingUp || animationTime(INTRO_DURATION) === 0)
            return;

        const panel = Main.panel;
        const visible = box => box.get_children().filter(actor => actor.visible);
        const left = visible(panel._leftBox);
        const right = visible(panel._rightBox).reverse();
        const center = visible(panel._centerBox);
        this._introActors = [...left, ...right, ...center];

        const drop = (actor, i) => {
            actor.opacity = 0;
            actor.translation_y = -INTRO_DROP;
            actor.ease({
                opacity: 255,
                translation_y: 0,
                delay: animationTime(i * INTRO_STAGGER),
                duration: animationTime(INTRO_DURATION),
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        };
        left.forEach(drop);
        right.forEach(drop);
        const last = Math.max(left.length, right.length);
        center.forEach((actor, i) => drop(actor, last + i));

        const glass = this._glass.actor;
        if (glass.opacity > 0) {
            glass.opacity = 0;
            glass.ease({
                opacity: 255,
                duration: animationTime(INTRO_DURATION),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }
}
