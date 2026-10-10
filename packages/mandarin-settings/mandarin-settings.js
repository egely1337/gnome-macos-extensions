#!/usr/bin/env -S gjs -m
// mandarinOS System Settings, in the style of macOS 27: a floating sidebar of
// coloured tiles, and grouped lists on the right. It configures the mandarinOS extensions
// in this repository through their GSettings schemas, a few GNOME settings
// that make the desktop feel like a Mac, and hands everything else
// (Wi-Fi, Bluetooth, sound...) to GNOME Settings.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import system from 'system';

const APP_ID = 'io.github.egely1337.MandarinSettings';
const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const ROOT = GLib.path_get_dirname(HERE);
const OS_NAME = 'mandarinOS';
const OS_LOGO = `${ROOT}/branding/mandarinos.svg`;

const EXTENSIONS = [
    {uuid: 'mandarin-menubar@egely1337', schema: 'org.gnome.shell.extensions.mandarin-menubar'},
    {uuid: 'mandarin-dock@egely1337', schema: 'org.gnome.shell.extensions.mandarin-dock'},
    {uuid: 'mandarin-animations@egely1337', schema: 'org.gnome.shell.extensions.mandarin-animations'},
    {uuid: 'mandarin-spotlight@egely1337'},
    {uuid: 'performance-stats@egely1337'},
];

const THUMB_WIDTH = 168;
const THUMB_HEIGHT = 105;

// ---------------------------------------------------------------------------
// Settings plumbing

const interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
const wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
const backgroundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
const searchSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
const shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
const mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});

function hasKey(settings, key) {
    return settings.settings_schema.has_key(key);
}

// The extensions ship their schemas next to their code, so they are not in
// the system schema source; look them up in the extension directories.
function extensionSettings(uuid, schemaId) {
    const dirs = [
        `${ROOT}/${uuid}/schemas`,
        `${GLib.get_user_data_dir()}/gnome-shell/extensions/${uuid}/schemas`,
        `/usr/share/gnome-shell/extensions/${uuid}/schemas`,
    ];
    for (const dir of dirs) {
        if (!GLib.file_test(`${dir}/gschemas.compiled`, GLib.FileTest.EXISTS))
            continue;
        const source = Gio.SettingsSchemaSource.new_from_directory(
            dir, Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(schemaId, false);
        if (schema)
            return new Gio.Settings({settings_schema: schema});
    }
    return null;
}

function extensionMetadata(uuid) {
    for (const dir of [`${ROOT}/${uuid}`, `${GLib.get_user_data_dir()}/gnome-shell/extensions/${uuid}`,
        `/usr/share/gnome-shell/extensions/${uuid}`]) {
        try {
            const [, bytes] = GLib.file_get_contents(`${dir}/metadata.json`);
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            // try the next place
        }
    }
    return null;
}

const dock = extensionSettings('mandarin-dock@egely1337', 'org.gnome.shell.extensions.mandarin-dock');
const animations = extensionSettings('mandarin-animations@egely1337', 'org.gnome.shell.extensions.mandarin-animations');
const menubar = extensionSettings('mandarin-menubar@egely1337', 'org.gnome.shell.extensions.mandarin-menubar');

function spawn(argv) {
    try {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    } catch (e) {
        logError(e, `Could not run ${argv.join(' ')}`);
    }
}

function openGnomeSettings(...panel) {
    spawn(['gnome-control-center', ...panel]);
}

function readText(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

function commandOutput(command) {
    try {
        const [ok, out] = GLib.spawn_command_line_sync(command);
        return ok ? new TextDecoder().decode(out).trim() : '';
    } catch {
        return '';
    }
}

function formatBytes(bytes) {
    return GLib.format_size_full(bytes, GLib.FormatSizeFlags.IEC_UNITS);
}

// ---------------------------------------------------------------------------
// Row builders. Everything a page shows is an Adw row in an inset group,
// which is as close to macOS's grouped forms as GTK gets.

function group(title = null, description = null) {
    return new Adw.PreferencesGroup({title: title ?? '', description: description ?? ''});
}

function missingRow(what) {
    return new Adw.ActionRow({
        title: `${what} kurulu değil`,
        subtitle: 'Uzantının şeması bulunamadı. install.sh betiğini çalıştırın.',
        css_classes: ['error'],
    });
}

function switchRow(title, subtitle, settings, key, {invert = false} = {}) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
    if (!settings || !hasKey(settings, key)) {
        row.sensitive = false;
        return row;
    }
    settings.bind(key, row, 'active',
        invert ? Gio.SettingsBindFlags.DEFAULT | Gio.SettingsBindFlags.INVERT_BOOLEAN
            : Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// options: [[label, value], ...]; value is a string, number or boolean and
// is read and written with the matching GSettings accessor.
function comboRow(title, subtitle, settings, key, options) {
    const row = new Adw.ComboRow({
        title,
        subtitle: subtitle ?? '',
        model: Gtk.StringList.new(options.map(([label]) => label)),
    });
    if (!settings || !hasKey(settings, key)) {
        row.sensitive = false;
        return row;
    }

    const kind = settings.get_value(key).get_type_string();
    const read = () => {
        switch (kind) {
        case 'b': return settings.get_boolean(key);
        case 'i': return settings.get_int(key);
        case 'u': return settings.get_uint(key);
        case 'd': return settings.get_double(key);
        default: return settings.get_string(key);
        }
    };
    const write = value => {
        switch (kind) {
        case 'b': settings.set_boolean(key, value); break;
        case 'i': settings.set_int(key, value); break;
        case 'u': settings.set_uint(key, value); break;
        case 'd': settings.set_double(key, value); break;
        default: settings.set_string(key, value);
        }
    };

    let syncing = false;
    const sync = () => {
        const current = read();
        let index = options.findIndex(([, value]) =>
            typeof value === 'number' ? Math.abs(value - current) < 0.001 : value === current);
        if (index < 0)
            index = 0;
        syncing = true;
        row.selected = index;
        syncing = false;
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        if (!syncing && row.selected < options.length)
            write(options[row.selected][1]);
    });
    return row;
}

// A slider with small captions at either end, like macOS's "Small ... Large".
function sliderRow(title, settings, key, {min, max, step, left = '', right = ''}) {
    const row = new Adw.ActionRow({title, activatable: false});
    row.add_css_class('slider-row');

    const adjustment = new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step});
    const scale = new Gtk.Scale({
        adjustment,
        draw_value: false,
        hexpand: true,
        width_request: 260,
        digits: step < 1 ? 2 : 0,
    });

    const captions = new Gtk.CenterBox({css_classes: ['slider-captions']});
    captions.set_start_widget(new Gtk.Label({label: left, css_classes: ['caption', 'dim-label']}));
    captions.set_end_widget(new Gtk.Label({label: right, css_classes: ['caption', 'dim-label']}));

    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, margin_top: 6, margin_bottom: 6});
    box.append(scale);
    box.append(captions);
    row.add_suffix(box);

    if (!settings || !hasKey(settings, key)) {
        row.sensitive = false;
        return row;
    }

    const isInt = settings.get_value(key).get_type_string() === 'i';
    let syncing = false;
    const sync = () => {
        syncing = true;
        adjustment.value = isInt ? settings.get_int(key) : settings.get_double(key);
        syncing = false;
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    adjustment.connect('value-changed', () => {
        if (syncing)
            return;
        if (isInt)
            settings.set_int(key, Math.round(adjustment.value));
        else
            settings.set_double(key, Math.round(adjustment.value / step) * step);
    });
    return {row, scale};
}

function linkRow(title, subtitle, onActivate, {external = true} = {}) {
    const row = new Adw.ActionRow({title, subtitle: subtitle ?? '', activatable: true});
    row.add_suffix(new Gtk.Image({
        icon_name: external ? 'adw-external-link-symbolic' : 'go-next-symbolic',
        css_classes: ['dim-label'],
    }));
    row.connect('activated', onActivate);
    return row;
}

function infoRow(title, value) {
    const row = new Adw.ActionRow({title, activatable: false});
    row.add_suffix(new Gtk.Label({
        label: value || '—',
        selectable: true,
        wrap: true,
        natural_wrap_mode: Gtk.NaturalWrapMode.NONE,
        xalign: 1,
        max_width_chars: 36,
        css_classes: ['dim-label'],
    }));
    return row;
}

// The coloured rounded square every macOS settings pane has as its icon.
function tile(icon, color, size = 'small') {
    const box = new Gtk.Box({
        css_classes: ['tile', `tile-${color}`, `tile-${size}`],
        hexpand: false,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    });
    box.append(new Gtk.Image({
        icon_name: icon,
        pixel_size: size === 'large' ? 36 : 14,
        hexpand: true,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    }));
    return box;
}

// The banner at the top of each page: big tile, title and a sentence.
function pageHeader(pane) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
        css_classes: ['page-header'],
    });
    box.append(tile(pane.icon, pane.color, 'large'));
    box.append(new Gtk.Label({label: pane.title, css_classes: ['title-2']}));
    if (pane.blurb) {
        box.append(new Gtk.Label({
            label: pane.blurb,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            max_width_chars: 52,
            css_classes: ['dim-label'],
        }));
    }
    const g = group();
    g.add(box);
    return g;
}

// ---------------------------------------------------------------------------
// Panes

function generalPane(pane) {
    const page = new Adw.PreferencesPage();
    page.add(pageHeader(pane));

    const osRelease = Object.fromEntries(readText('/etc/os-release').split('\n')
        .map(line => line.match(/^(\w+)=["']?(.*?)["']?$/))
        .filter(Boolean)
        .map(m => [m[1], m[2]]));
    const cpu = readText('/proc/cpuinfo').match(/^model name\s*:\s*(.*)$/m)?.[1]
        ?.replace(/\s+/g, ' ');
    const cores = GLib.get_num_processors();
    const memKb = Number(readText('/proc/meminfo').match(/^MemTotal:\s*(\d+)/m)?.[1] ?? 0);
    const gpu = commandOutput('sh -c "lspci 2>/dev/null | grep -iE \'vga|3d|display\' | head -n1 | cut -d: -f3-"');
    const shell = commandOutput('gnome-shell --version').replace(/^GNOME Shell\s*/, '');

    let disk = '';
    try {
        const info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::free', null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        disk = `${formatBytes(free)} boş / ${formatBytes(size)}`;
    } catch {
        // leave it blank
    }

    // "About This Mac", in miniature.
    const about = group('Hakkında');
    const hero = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, css_classes: ['about-hero']});
    hero.append(new Gtk.Image({
        file: OS_LOGO,
        pixel_size: 88,
        css_classes: ['about-logo'],
    }));
    hero.append(new Gtk.Label({label: OS_NAME, css_classes: ['title-1']}));
    // Until mandarinOS ships its own os-release, name the base it runs on.
    const base = osRelease.PRETTY_NAME || osRelease.NAME || 'Linux';
    const baseNote = base.toLowerCase().startsWith(OS_NAME.toLowerCase()) ? '' : ` · ${base} tabanlı`;
    hero.append(new Gtk.Label({
        label: `GNOME ${shell}${baseNote}`,
        css_classes: ['dim-label'],
    }));
    const heroRow = new Adw.PreferencesRow({activatable: false, child: hero});
    about.add(heroRow);
    about.add(infoRow('Ad', GLib.get_host_name()));
    about.add(infoRow('İşlemci', cpu ? `${cpu} (${cores} çekirdek)` : `${cores} çekirdek`));
    about.add(infoRow('Grafik', gpu));
    about.add(infoRow('Bellek', memKb ? formatBytes(memKb * 1024) : ''));
    about.add(infoRow('Depolama', disk));
    about.add(infoRow('Çekirdek', readText('/proc/sys/kernel/osrelease').trim()));
    page.add(about);

    const more = group();
    more.add(linkRow('Yazılım Güncelleme', 'Sistem ve uygulama güncellemelerini denetle',
        () => spawn(['gnome-software', '--mode=updates'])));
    more.add(linkRow('Tarih ve Saat', null, () => openGnomeSettings('system', 'datetime')));
    more.add(linkRow('Dil ve Bölge', null, () => openGnomeSettings('system', 'region')));
    more.add(linkRow('Paylaşma', 'Ekran paylaşımı, dosya paylaşımı, uzaktan oturum', () => openGnomeSettings('sharing')));
    more.add(linkRow('Başlangıç Uygulamaları', null, () => openGnomeSettings('applications')));
    page.add(more);
    return page;
}

// A mini desktop drawn with CSS, for the Light / Dark choice.
function appearanceCard(label, scheme, kind, toggleGroup) {
    const preview = new Gtk.Box({
        css_classes: ['appearance-preview', `appearance-${kind}`],
        orientation: Gtk.Orientation.VERTICAL,
        width_request: 112,
        height_request: 72,
    });
    const bar = new Gtk.Box({css_classes: ['mini-menubar'], height_request: 6});
    const win = new Gtk.Box({
        css_classes: ['mini-window'],
        orientation: Gtk.Orientation.VERTICAL,
        margin_start: 14, margin_end: 22, margin_top: 10,
        vexpand: true,
    });
    const lights = new Gtk.Box({spacing: 2, margin_start: 4, margin_top: 4});
    for (const c of ['red', 'yellow', 'green'])
        lights.append(new Gtk.Box({css_classes: ['mini-light', `mini-${c}`], width_request: 4, height_request: 4}));
    win.append(lights);
    preview.append(bar);
    preview.append(win);

    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    content.append(preview);
    content.append(new Gtk.Label({label}));

    const button = new Gtk.ToggleButton({child: content, css_classes: ['appearance-card', 'flat']});
    if (toggleGroup)
        button.set_group(toggleGroup);

    const sync = () => {
        const current = interfaceSettings.get_string('color-scheme');
        const dark = current === 'prefer-dark';
        button.active = kind === 'dark' ? dark : !dark;
    };
    sync();
    interfaceSettings.connect('changed::color-scheme', sync);
    button.connect('toggled', () => {
        if (button.active && interfaceSettings.get_string('color-scheme') !== scheme)
            interfaceSettings.set_string('color-scheme', scheme);
    });
    return button;
}

const ACCENTS = [
    ['blue', 'Mavi'], ['purple', 'Mor'], ['pink', 'Pembe'], ['red', 'Kırmızı'],
    ['orange', 'Turuncu'], ['yellow', 'Sarı'], ['green', 'Yeşil'], ['teal', 'Turkuaz'], ['slate', 'Arduvaz'],
];

function accentRow() {
    const row = new Adw.ActionRow({title: 'Vurgu rengi', activatable: false});
    const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
    const name = new Gtk.Label({css_classes: ['caption', 'dim-label'], width_chars: 8, xalign: 1});
    let first = null;
    const buttons = new Map();
    for (const [id, label] of ACCENTS) {
        const button = new Gtk.ToggleButton({
            css_classes: ['accent-swatch', `accent-${id}`],
            tooltip_text: label,
            valign: Gtk.Align.CENTER,
        });
        button.set_child(new Gtk.Image({icon_name: 'object-select-symbolic', pixel_size: 10}));
        if (first)
            button.set_group(first);
        else
            first = button;
        button.connect('toggled', () => {
            if (button.active && interfaceSettings.get_string('accent-color') !== id)
                interfaceSettings.set_string('accent-color', id);
        });
        buttons.set(id, button);
        box.append(button);
    }
    const sync = () => {
        const id = interfaceSettings.get_string('accent-color');
        const button = buttons.get(id);
        if (button)
            button.active = true;
        name.label = ACCENTS.find(([a]) => a === id)?.[1] ?? '';
    };
    sync();
    interfaceSettings.connect('changed::accent-color', sync);
    row.add_suffix(name);
    row.add_suffix(box);
    return row;
}

function appearancePane(pane) {
    const page = new Adw.PreferencesPage();
    page.add(pageHeader(pane));

    const look = group('Görünüm');
    const cards = new Gtk.Box({spacing: 18, halign: Gtk.Align.CENTER, margin_top: 12, margin_bottom: 12});
    const light = appearanceCard('Açık', 'prefer-light', 'light', null);
    cards.append(light);
    cards.append(appearanceCard('Koyu', 'prefer-dark', 'dark', light));
    const cardsRow = new Adw.PreferencesRow({activatable: false, child: cards});
    look.add(cardsRow);
    if (hasKey(interfaceSettings, 'accent-color'))
        look.add(accentRow());
    page.add(look);

    const text = group();
    text.add(comboRow('Metin boyutu', 'Sistem genelindeki yazı ölçeği', interfaceSettings, 'text-scaling-factor', [
        ['Küçük', 0.9], ['Varsayılan', 1.0], ['Büyük', 1.15], ['Daha büyük', 1.3],
    ]));
    text.add(comboRow('Kaydırma çubuklarını göster', null, interfaceSettings, 'overlay-scrolling', [
        ['Kaydırırken otomatik', true], ['Her zaman', false],
    ]));
    if (hasKey(interfaceSettings, 'font-antialiasing')) {
        text.add(comboRow('Yazı tipi yumuşatma', null, interfaceSettings, 'font-antialiasing', [
            ['Standart (gri tonlamalı)', 'grayscale'], ['Alt piksel (LCD)', 'rgba'], ['Yok', 'none'],
        ]));
    }
    page.add(text);

    const windows = group('Pencereler');
    windows.add(comboRow('Pencere düğmeleri', 'mandarinOS pencere düğmelerini sol üst köşede kullanır',
        wmSettings, 'button-layout', [
            ['Solda (mandarinOS)', 'close,minimize,maximize:appmenu'],
            ['Sağda (GNOME)', 'appmenu:minimize,maximize,close'],
            ['Yalnızca kapat, sağda', 'appmenu:close'],
        ]));
    windows.add(comboRow('Başlık çubuğuna çift tıklandığında', null,
        wmSettings, 'action-double-click-titlebar', [
            ['Büyüt', 'toggle-maximize'], ['Küçült', 'minimize'], ['Hiçbir şey yapma', 'none'],
        ]));
    page.add(windows);
    return page;
}

function menuBarPane(pane) {
    const page = new Adw.PreferencesPage();
    page.add(pageHeader(pane));

    const bar = group('Menü çubuğu');
    if (!menubar)
        bar.add(missingRow('mandarinOS Menü Çubuğu'));
    bar.add(switchRow('Spotlight düğmesini göster', 'Menü çubuğundaki büyüteç', menubar, 'show-spotlight-button'));
    bar.add(switchRow('Pencere menüsünü göster', 'Uygulama menüsünün yanındaki “Pencere” menüsü', menubar, 'show-window-menu'));
    bar.add(switchRow('Pil yüzdesini göster', null, interfaceSettings, 'show-battery-percentage'));
    page.add(bar);

    const clock = group('Saat');
    clock.add(switchRow('Haftanın gününü göster', null, interfaceSettings, 'clock-show-weekday'));
    clock.add(switchRow('Tarihi göster', null, interfaceSettings, 'clock-show-date'));
    clock.add(switchRow('Saniyeleri göster', null, interfaceSettings, 'clock-show-seconds'));
    clock.add(comboRow('Saat biçimi', null, interfaceSettings, 'clock-format', [['24 saat', '24h'], ['12 saat (ÖÖ/ÖS)', '12h']]));
    page.add(clock);

    const center = group('Denetim Merkezi', 'Denetim Merkezi, GNOME hızlı ayarlarının buzlu cam görünümüdür.');
    center.add(linkRow('Bildirimler', null, () => openGnomeSettings('notifications')));
    center.add(linkRow('Arka planda çalışan uygulamalar', null, () => openGnomeSettings('applications')));
    page.add(center);
    return page;
}

function desktopDockPane(pane) {
    const page = new Adw.PreferencesPage();
    page.add(pageHeader(pane));

    const dockGroup = group('Dock');
    if (!dock)
        dockGroup.add(missingRow('mandarinOS Dock'));
    dockGroup.add(sliderRow('Boyut', dock, 'icon-size', {
        min: 32, max: 80, step: 1, left: 'Küçük', right: 'Büyük',
    }).row);

    const magnifyToggle = switchRow('Büyütme', 'İmlecin altındaki simgeleri büyüt', dock, 'magnification');
    dockGroup.add(magnifyToggle);
    const magnify = sliderRow('Büyütme miktarı', dock, 'magnification-scale', {
        min: 1.2, max: 2.5, step: 0.05, left: 'Az', right: 'Çok',
    });
    if (dock)
        dock.bind('magnification', magnify.row, 'sensitive', Gio.SettingsBindFlags.GET);
    dockGroup.add(magnify.row);

    dockGroup.add(comboRow('Küçültme efekti', 'Pencereler Dock’a nasıl küçülsün', animations, 'minimize-effect', [
        ['Cin efekti', 'genie'], ['Ölçek efekti', 'scale'],
    ]));
    dockGroup.add(switchRow('Pencereleri uygulama simgesine küçült', null, dock, 'minimize-into-app'));
    dockGroup.add(switchRow('Açılan uygulamaları canlandır', 'Uygulama başlarken simgesi zıplasın', dock, 'bounce-on-launch'));
    dockGroup.add(switchRow('Büyütülmüş pencerelerde Dock’u küçült', null, dock, 'compact-when-maximized'));
    dockGroup.add(switchRow('Çöp Sepeti’ni göster', null, dock, 'show-trash'));
    dockGroup.add(switchRow('Cam üzerinde imleç ışığı', 'İmlecin altında yumuşak bir parıltı', dock, 'pointer-glow'));
    page.add(dockGroup);

    const windows = group('Pencereler');
    if (!animations)
        windows.add(missingRow('mandarinOS Pencere Animasyonları'));
    windows.add(switchRow('Açılış ve kapanış animasyonları', 'Pencereler yakınlaşarak açılır, uzaklaşarak kapanır',
        animations, 'open-close-animations'));
    windows.add(sliderRow('Animasyon hızı', animations, 'speed', {
        min: 0.5, max: 2.0, step: 0.05, left: 'Yavaş', right: 'Hızlı',
    }).row);
    windows.add(switchRow('Hareketi azalt', 'Tüm sistem animasyonlarını kapat', interfaceSettings, 'enable-animations', {invert: true}));
    if (hasKey(mutterSettings, 'edge-tiling'))
        windows.add(switchRow('Pencereleri ekran kenarına sürükleyerek döşe', null, mutterSettings, 'edge-tiling'));
    page.add(windows);

    const launchpad = group('Launchpad ve Etkin Köşeler');
    launchpad.add(switchRow('Super tuşu Launchpad’i açar', 'Kapalıyken Super tuşu GNOME Genel Bakış’ını açar',
        dock, 'super-opens-launchpad'));
    launchpad.add(switchRow('Etkin köşe', 'İmleci sol üst köşeye götürmek Genel Bakış’ı açar',
        interfaceSettings, 'enable-hot-corners'));
    launchpad.add(linkRow('Çoklu görev ve çalışma alanları', null, () => openGnomeSettings('multitasking')));
    page.add(launchpad);
    return page;
}

function searchProviders() {
    const dirs = [...GLib.get_system_data_dirs(), GLib.get_user_data_dir()]
        .map(d => `${d}/gnome-shell/search-providers`);
    const seen = new Set();
    const providers = [];
    for (const dir of dirs) {
        let names;
        try {
            const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
            names = [...enumerator].map(info => info.get_name()).filter(n => n.endsWith('.ini'));
        } catch {
            continue;
        }
        for (const name of names) {
            const keyFile = new GLib.KeyFile();
            try {
                keyFile.load_from_file(`${dir}/${name}`, GLib.KeyFileFlags.NONE);
                const group = 'Shell Search Provider';
                const desktopId = keyFile.get_string(group, 'DesktopId');
                if (seen.has(desktopId))
                    continue;
                let defaultDisabled = false;
                try {
                    defaultDisabled = keyFile.get_boolean(group, 'DefaultDisabled');
                } catch {
                    // the key is optional
                }
                const app = GioUnix.DesktopAppInfo.new(desktopId);
                if (!app)
                    continue;
                seen.add(desktopId);
                providers.push({desktopId, app, defaultDisabled});
            } catch {
                // not a provider we can show
            }
        }
    }
    return providers.sort((a, b) => a.app.get_name().localeCompare(b.app.get_name()));
}

function providerEnabled({desktopId, defaultDisabled}) {
    if (defaultDisabled)
        return searchSettings.get_strv('enabled').includes(desktopId);
    return !searchSettings.get_strv('disabled').includes(desktopId);
}

function setProviderEnabled({desktopId, defaultDisabled}, enabled) {
    const key = defaultDisabled ? 'enabled' : 'disabled';
    const add = defaultDisabled ? enabled : !enabled;
    const list = searchSettings.get_strv(key).filter(id => id !== desktopId);
    if (add)
        list.push(desktopId);
    searchSettings.set_strv(key, list);
}

function spotlightPane(pane) {
    const page = new Adw.PreferencesPage();
    page.add(pageHeader(pane));

    const shortcut = group();
    const keys = new Adw.ActionRow({title: 'Spotlight’ı aç', activatable: false});
    keys.add_suffix(new Gtk.ShortcutLabel({accelerator: '<Super>space', valign: Gtk.Align.CENTER}));
    shortcut.add(keys);
    const launchpadKeys = new Adw.ActionRow({title: 'Launchpad’i aç', activatable: false});
    launchpadKeys.add_suffix(new Gtk.ShortcutLabel({accelerator: '<Super>a', valign: Gtk.Align.CENTER}));
    shortcut.add(launchpadKeys);
    page.add(shortcut);

    const results = group('Arama sonuçları',
        'Yalnızca seçili kategoriler Spotlight arama sonuçlarında görünür. Uygulamalar her zaman gösterilir.');
    results.add(switchRow('Uygulama sonuçlarını göster', 'Dosyalar, ayarlar, hesap makinesi ve diğer sağlayıcılar',
        searchSettings, 'disable-external', {invert: true}));

    const providers = searchProviders();
    const rows = [];
    for (const provider of providers) {
        const row = new Adw.ActionRow({title: provider.app.get_name(), activatable: true});
        const check = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
        row.add_prefix(check);
        row.set_activatable_widget(check);
        const icon = provider.app.get_icon();
        if (icon)
            row.add_suffix(new Gtk.Image({gicon: icon, pixel_size: 24}));
        let syncing = false;
        const sync = () => {
            syncing = true;
            check.active = providerEnabled(provider);
            syncing = false;
        };
        sync();
        check.connect('toggled', () => {
            if (!syncing)
                setProviderEnabled(provider, check.active);
        });
        rows.push({row, sync});
        results.add(row);
    }
    const syncAll = () => {
        const external = !searchSettings.get_boolean('disable-external');
        for (const {row, sync} of rows) {
            row.sensitive = external;
            sync();
        }
    };
    searchSettings.connect('changed', syncAll);
    syncAll();
    page.add(results);

    const more = group();
    more.add(linkRow('Arama konumları ve sıralaması', 'GNOME Ayarlar’da', () => openGnomeSettings('search')));
    page.add(more);
    return page;
}

// Wallpapers come in light/dark pairs (foo-l / foo-d); like a macOS dynamic
// wallpaper, the pair is set as one and follows the appearance.
function findWallpapers() {
    const roots = ['/usr/share/backgrounds', `${GLib.get_user_data_dir()}/backgrounds`,
        `${GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir()}/Wallpapers`];
    const exts = /\.(png|jpe?g|webp|jxl|svg|avif)$/i;
    const files = [];
    const walk = (path, depth) => {
        let enumerator;
        try {
            enumerator = Gio.File.new_for_path(path).enumerate_children('standard::name,standard::type', 0, null);
        } catch {
            return;
        }
        for (const info of enumerator) {
            const child = `${path}/${info.get_name()}`;
            if (info.get_file_type() === Gio.FileType.DIRECTORY && depth > 0)
                walk(child, depth - 1);
            else if (exts.test(info.get_name()))
                files.push(child);
        }
    };
    roots.forEach(root => walk(root, 2));
    files.sort();

    const byBase = new Map();
    for (const file of files) {
        const m = file.match(/^(.*)-([ld])\.[^.]+$/);
        if (m) {
            const entry = byBase.get(m[1]) ?? {};
            entry[m[2] === 'l' ? 'light' : 'dark'] = file;
            byBase.set(m[1], entry);
        } else {
            byBase.set(file, {light: file});
        }
    }
    return [...byBase.values()].map(e => ({light: e.light ?? e.dark, dark: e.dark ?? e.light}));
}

// GNOME already keeps thumbnails of most pictures; fall back to decoding
// in a thread.
function loadThumbnail(path, picture, done) {
    const file = Gio.File.new_for_path(path);
    file.query_info_async('thumbnail::path-large,thumbnail::path', 0, GLib.PRIORITY_LOW, null, (f, res) => {
        let source = path;
        try {
            const info = f.query_info_finish(res);
            source = info.get_attribute_byte_string('thumbnail::path-large') ??
                info.get_attribute_byte_string('thumbnail::path') ?? path;
        } catch {
            // decode the original
        }
        Gio.File.new_for_path(source).read_async(GLib.PRIORITY_LOW, null, (sf, sres) => {
            try {
                const stream = sf.read_finish(sres);
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, THUMB_WIDTH * 2, THUMB_HEIGHT * 2, true, null,
                    (s, pres) => {
                        try {
                            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(pres);
                            picture.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf));
                        } catch {
                            picture.get_parent()?.add_css_class('thumb-failed');
                        }
                        stream.close(null);
                        done();
                    });
            } catch {
                done();
            }
        });
    });
}

function uriOf(path) {
    return Gio.File.new_for_path(path).get_uri();
}

function wallpaperPane(pane, window) {
    const page = new Adw.PreferencesPage();
    page.add(pageHeader(pane));

    const current = group();
    const currentRow = new Adw.ActionRow({activatable: false});
    const currentPicture = new Gtk.Picture({
        content_fit: Gtk.ContentFit.COVER,
        width_request: 160,
        height_request: 100,
        css_classes: ['wallpaper-current'],
        margin_top: 8,
        margin_bottom: 8,
    });
    currentRow.add_prefix(currentPicture);
    const syncCurrent = () => {
        const dark = interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        const uri = backgroundSettings.get_string(dark ? 'picture-uri-dark' : 'picture-uri');
        const path = GLib.filename_from_uri(uri)[0];
        currentRow.title = GLib.path_get_basename(path).replace(/(-[ld])?\.[^.]+$/, '');
        currentRow.subtitle = dark ? 'Koyu görünüm için' : 'Açık görünüm için';
        loadThumbnail(path, currentPicture, () => {});
    };
    try {
        syncCurrent();
    } catch {
        // no wallpaper set
    }
    backgroundSettings.connect('changed', () => {
        try {
            syncCurrent();
        } catch {
            // ignore
        }
    });

    current.add(currentRow);

    const fit = comboRow('Yerleşim', null, backgroundSettings, 'picture-options', [
        ['Ekranı doldur', 'zoom'], ['Ekrana sığdır', 'scaled'], ['Ortala', 'centered'],
        ['Uzat', 'stretched'], ['Döşe', 'wallpaper'],
    ]);
    current.add(fit);

    const add = new Gtk.Button({label: 'Fotoğraf Ekle…', valign: Gtk.Align.CENTER, css_classes: ['pill-small']});
    add.connect('clicked', () => {
        const filter = new Gtk.FileFilter({name: 'Resimler'});
        filter.add_mime_type('image/*');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({title: 'Duvar kağıdı seç', filters});
        dialog.open(window, null, (d, res) => {
            try {
                const file = d.open_finish(res);
                backgroundSettings.set_string('picture-uri', file.get_uri());
                backgroundSettings.set_string('picture-uri-dark', file.get_uri());
            } catch {
                // cancelled
            }
        });
    });
    current.set_header_suffix(add);
    page.add(current);

    const gallery = group('Duvar kağıtları', 'Açık ve koyu sürümü olanlar görünüme göre otomatik değişir.');
    const flow = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        min_children_per_line: 2,
        max_children_per_line: 4,
        row_spacing: 12,
        column_spacing: 12,
        css_classes: ['wallpaper-grid'],
    });
    const queue = [];
    for (const wallpaper of findWallpapers()) {
        const picture = new Gtk.Picture({
            content_fit: Gtk.ContentFit.COVER,
            width_request: THUMB_WIDTH,
            height_request: THUMB_HEIGHT,
        });
        const button = new Gtk.Button({
            child: picture,
            css_classes: ['wallpaper-thumb', 'flat'],
            tooltip_text: GLib.path_get_basename(wallpaper.light).replace(/(-[ld])?\.[^.]+$/, ''),
        });
        if (wallpaper.light !== wallpaper.dark) {
            const overlay = new Gtk.Overlay({child: button});
            overlay.add_overlay(new Gtk.Image({
                icon_name: 'weather-clear-night-symbolic',
                halign: Gtk.Align.END,
                valign: Gtk.Align.END,
                margin_end: 8,
                margin_bottom: 8,
                css_classes: ['dynamic-badge'],
                can_target: false,
            }));
            flow.append(overlay);
        } else {
            flow.append(button);
        }
        button.connect('clicked', () => {
            backgroundSettings.set_string('picture-uri', uriOf(wallpaper.light));
            backgroundSettings.set_string('picture-uri-dark', uriOf(wallpaper.dark));
        });
        queue.push([wallpaper.light, picture]);
    }
    // One at a time, so the gallery fills in without stalling the UI.
    const next = () => {
        const item = queue.shift();
        if (item)
            loadThumbnail(...item, next);
    };
    next();
    next();

    const flowRow = new Adw.PreferencesRow({activatable: false, child: flow});
    gallery.add(flowRow);
    page.add(gallery);
    return page;
}

function setExtensionEnabled(uuid, enabled) {
    Gio.DBus.session.call(
        'org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions',
        enabled ? 'EnableExtension' : 'DisableExtension',
        new GLib.Variant('(s)', [uuid]), null, Gio.DBusCallFlags.NONE, -1, null,
        (conn, res) => {
            try {
                conn.call_finish(res);
            } catch (e) {
                logError(e, `Could not toggle ${uuid}`);
            }
        });
}

function extensionsPane(pane) {
    const page = new Adw.PreferencesPage();
    page.add(pageHeader(pane));

    const list = group('mandarinOS uzantıları', 'Değişiklikler hemen uygulanır. Kod güncellemeleri için oturumu kapatıp açın.');
    for (const {uuid} of EXTENSIONS) {
        const meta = extensionMetadata(uuid);
        const row = new Adw.SwitchRow({
            title: meta?.name ?? uuid,
            subtitle: meta?.description ?? '',
            subtitle_lines: 2,
        });
        let syncing = false;
        const sync = () => {
            syncing = true;
            row.active = shellSettings.get_strv('enabled-extensions').includes(uuid);
            syncing = false;
        };
        sync();
        shellSettings.connect('changed::enabled-extensions', sync);
        row.connect('notify::active', () => {
            if (!syncing)
                setExtensionEnabled(uuid, row.active);
        });
        if (!meta)
            row.sensitive = false;
        list.add(row);
    }
    page.add(list);

    const more = group();
    more.add(switchRow('Kullanıcı uzantılarına izin ver', null, shellSettings, 'disable-user-extensions', {invert: true}));
    more.add(linkRow('Uzantı Yöneticisi', 'Diğer tüm GNOME uzantıları', () => {
        const app = GioUnix.DesktopAppInfo.new('com.mattjakeman.ExtensionManager.desktop') ??
            GioUnix.DesktopAppInfo.new('org.gnome.Extensions.desktop');
        app?.launch([], null);
    }));
    page.add(more);
    return page;
}

// ---------------------------------------------------------------------------
// The sidebar, grouped like macOS: network, then personal, then system.

const PANES = [
    [
        {id: 'wifi', title: 'Wi‑Fi', icon: 'network-wireless-symbolic', color: 'blue', panel: ['wifi']},
        {id: 'bluetooth', title: 'Bluetooth', icon: 'bluetooth-active-symbolic', color: 'blue', panel: ['bluetooth']},
        {id: 'network', title: 'Ağ', icon: 'network-wired-symbolic', color: 'blue', panel: ['network'], keywords: 'ethernet vpn proxy'},
    ],
    [
        {id: 'battery', title: 'Pil', icon: 'battery-full-symbolic', color: 'green', panel: ['power'], keywords: 'güç enerji power'},
    ],
    [
        {id: 'general', title: 'Genel', icon: 'emblem-system-symbolic', color: 'gray', build: generalPane,
            blurb: 'Bu bilgisayarı yönetin: donanım bilgileri, güncellemeler, dil ve tarih.',
            keywords: 'mandarinos hakkında about işlemci bellek güncelleme'},
        {id: 'accessibility', title: 'Erişilebilirlik', icon: 'preferences-desktop-accessibility-symbolic', color: 'blue', panel: ['universal-access']},
        {id: 'appearance', title: 'Görünüm', icon: 'preferences-desktop-appearance-symbolic', color: 'black', build: appearancePane,
            blurb: 'Açık ya da koyu görünüm, vurgu rengi, metin boyutu ve pencere düğmeleri.',
            keywords: 'koyu açık dark light tema vurgu renk yazı font pencere düğme'},
        {id: 'menubar', title: 'Menü Çubuğu', icon: 'focus-top-bar-symbolic', color: 'gray', build: menuBarPane,
            blurb: 'Menü çubuğunda ve Denetim Merkezi’nde neyin görüneceğini seçin.',
            keywords: 'denetim merkezi control center saat tarih pil spotlight'},
        {id: 'desktop', title: 'Masaüstü ve Dock', icon: 'focus-windows-symbolic', color: 'black', build: desktopDockPane,
            blurb: 'Dock’un boyutu ve davranışı, pencere animasyonları ve Launchpad.',
            keywords: 'dock büyütme cin genie küçült animasyon launchpad etkin köşe çöp'},
        {id: 'displays', title: 'Ekranlar', icon: 'video-display-symbolic', color: 'blue', panel: ['display'], keywords: 'çözünürlük monitör gece ışığı'},
        {id: 'spotlight', title: 'Spotlight', icon: 'system-search-symbolic', color: 'gray', build: spotlightPane,
            blurb: 'Spotlight, bilgisayarınızdaki her şeyi hızla bulmanıza yardımcı olur. Hangi sonuçların görüneceğini seçin.',
            keywords: 'arama search'},
        {id: 'wallpaper', title: 'Duvar Kağıdı', icon: 'preferences-desktop-wallpaper-symbolic', color: 'cyan', build: wallpaperPane,
            blurb: 'Masaüstünüz için bir resim seçin.',
            keywords: 'arka plan background resim'},
    ],
    [
        {id: 'notifications', title: 'Bildirimler', icon: 'preferences-system-notifications-symbolic', color: 'red', panel: ['notifications']},
        {id: 'sound', title: 'Ses', icon: 'audio-volume-high-symbolic', color: 'pink', panel: ['sound']},
        {id: 'wellbeing', title: 'Ekran Süresi', icon: 'org.gnome.Settings-wellbeing-symbolic', color: 'indigo', panel: ['wellbeing']},
    ],
    [
        {id: 'privacy', title: 'Gizlilik ve Güvenlik', icon: 'channel-secure-symbolic', color: 'blue', panel: ['privacy']},
        {id: 'users', title: 'Kullanıcılar ve Gruplar', icon: 'system-users-symbolic', color: 'blue', panel: ['system', 'users']},
        {id: 'accounts', title: 'İnternet Hesapları', icon: 'org.gnome.Settings-online-accounts-symbolic', color: 'blue', panel: ['online-accounts']},
    ],
    [
        {id: 'keyboard', title: 'Klavye', icon: 'input-keyboard-symbolic', color: 'gray', panel: ['keyboard'], keywords: 'kısayol shortcut'},
        {id: 'mouse', title: 'Fare ve İzleme Dörtgeni', icon: 'input-mouse-symbolic', color: 'gray', panel: ['mouse'], keywords: 'touchpad trackpad'},
        {id: 'printers', title: 'Yazıcılar', icon: 'printer-symbolic', color: 'gray', panel: ['printers']},
    ],
    [
        {id: 'extensions', title: 'mandarinOS Uzantıları', icon: 'application-x-addon-symbolic', color: 'purple', build: extensionsPane,
            blurb: 'Menü çubuğu, Dock, Spotlight ve animasyon uzantılarını açıp kapatın.',
            keywords: 'extension eklenti mandarin'},
    ],
];

const PaneRow = GObject.registerClass(
class PaneRow extends Gtk.ListBoxRow {
    _init(pane, section) {
        super._init({css_classes: ['pane-row']});
        this.pane = pane;
        this.section = section;
        const box = new Gtk.Box({spacing: 10});
        box.append(tile(pane.icon, pane.color));
        box.append(new Gtk.Label({label: pane.title, xalign: 0, hexpand: true, ellipsize: 3}));
        if (pane.panel) {
            box.append(new Gtk.Image({
                icon_name: 'adw-external-link-symbolic',
                pixel_size: 12,
                css_classes: ['dim-label', 'external-hint'],
                tooltip_text: 'GNOME Ayarlar’da açılır',
            }));
        }
        this.set_child(box);
    }

    matches(query) {
        if (!query)
            return true;
        const haystack = `${this.pane.title} ${this.pane.keywords ?? ''}`.toLocaleLowerCase('tr');
        return haystack.includes(query);
    }
});

const SettingsWindow = GObject.registerClass(
class SettingsWindow extends Adw.ApplicationWindow {
    _init(app) {
        super._init({
            application: app,
            title: 'Sistem Ayarları',
            icon_name: 'mandarinos',
            default_width: 980,
            default_height: 700,
            width_request: 360,
            height_request: 300,
        });
        this._pages = new Map();

        this._split = new Adw.NavigationSplitView({
            min_sidebar_width: 230,
            max_sidebar_width: 270,
            sidebar_width_fraction: 0.28,
        });
        this._split.set_sidebar(this._buildSidebar());
        this.set_content(this._split);

        const breakpoint = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 640sp')});
        breakpoint.add_setter(this._split, 'collapsed', true);
        this.add_breakpoint(breakpoint);

        const key = new Gtk.EventControllerKey();
        key.connect('key-pressed', (c, keyval, code, state) => {
            const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
            if (ctrl && keyval === Gdk.KEY_f) {
                this._search.grab_focus();
                return true;
            }
            if (ctrl && (keyval === Gdk.KEY_w || keyval === Gdk.KEY_q)) {
                this.close();
                return true;
            }
            return false;
        });
        this.add_controller(key);

        this._select('appearance');
    }

    _buildSidebar() {
        const header = new Adw.HeaderBar({show_title: false, css_classes: ['flat']});

        this._search = new Gtk.SearchEntry({placeholder_text: 'Ara', margin_start: 10, margin_end: 10, margin_bottom: 6});
        this._search.connect('search-changed', () => {
            this._query = this._search.text.trim().toLocaleLowerCase('tr');
            this._list.invalidate_filter();
            this._list.invalidate_headers();
        });
        this._search.connect('activate', () => {
            const first = this._rows.find(r => r.matches(this._query));
            if (first)
                this._activateRow(first);
        });

        this._list = new Gtk.ListBox({
            css_classes: ['navigation-sidebar', 'settings-sidebar'],
            selection_mode: Gtk.SelectionMode.SINGLE,
        });
        this._rows = [];
        PANES.forEach((section, i) => {
            for (const pane of section) {
                const row = new PaneRow(pane, i);
                this._rows.push(row);
                this._list.append(row);
            }
        });
        this._list.set_filter_func(row => row.matches(this._query ?? ''));
        this._list.set_header_func((row, before) => {
            if (this._query)
                row.set_header(null);
            else if (before && before.section !== row.section)
                row.set_header(new Gtk.Box({css_classes: ['section-gap']}));
            else
                row.set_header(null);
        });
        this._list.connect('row-activated', (list, row) => this._activateRow(row));

        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vexpand: true,
            child: this._list,
        });

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(this._search);
        box.append(this._accountCard());
        box.append(scroller);

        const toolbar = new Adw.ToolbarView({content: box});
        toolbar.add_top_bar(header);

        const floating = new Gtk.Box({css_classes: ['floating-sidebar']});
        toolbar.hexpand = true;
        floating.append(toolbar);
        return new Adw.NavigationPage({title: 'Sistem Ayarları', child: floating, tag: 'sidebar'});
    }

    // The Apple Account card at the top of the sidebar; here, the local user.
    _accountCard() {
        const name = GLib.get_real_name() && GLib.get_real_name() !== 'Unknown'
            ? GLib.get_real_name() : GLib.get_user_name();
        const avatar = new Adw.Avatar({size: 40, text: name, show_initials: true});
        for (const path of [`/var/lib/AccountsService/icons/${GLib.get_user_name()}`, `${GLib.get_home_dir()}/.face`]) {
            try {
                if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                    avatar.custom_image = Gdk.Texture.new_from_filename(path);
                    break;
                }
            } catch {
                // keep the initials
            }
        }
        const labels = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER});
        labels.append(new Gtk.Label({label: name, xalign: 0, css_classes: ['heading'], ellipsize: 3}));
        labels.append(new Gtk.Label({label: 'Hesap', xalign: 0, css_classes: ['caption', 'dim-label']}));
        const box = new Gtk.Box({spacing: 10});
        box.append(avatar);
        box.append(labels);
        const button = new Gtk.Button({child: box, css_classes: ['flat', 'account-card']});
        button.connect('clicked', () => openGnomeSettings('system', 'users'));
        return button;
    }

    _select(id) {
        const row = this._rows.find(r => r.pane.id === id);
        if (row)
            this._activateRow(row);
    }

    _activateRow(row) {
        const pane = row.pane;
        if (pane.panel) {
            // Not ours to configure: hand it to GNOME Settings and keep the
            // current page selected.
            openGnomeSettings(...pane.panel);
            if (this._current)
                this._list.select_row(this._current);
            else
                this._list.unselect_all();
            return;
        }
        this._current = row;
        this._list.select_row(row);

        let page = this._pages.get(pane.id);
        if (!page) {
            const toolbar = new Adw.ToolbarView();
            const header = new Adw.HeaderBar({show_title: false, css_classes: ['flat']});
            header.pack_start(new Gtk.Label({label: pane.title, css_classes: ['page-title']}));
            toolbar.add_top_bar(header);
            toolbar.set_content(pane.build(pane, this));
            page = new Adw.NavigationPage({title: pane.title, child: toolbar, tag: pane.id});
            this._pages.set(pane.id, page);
        }
        this._split.set_content(page);
        this._split.show_content = true;
    }
});

// ---------------------------------------------------------------------------

const app = new Adw.Application({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
app.connect('startup', () => {
    const provider = new Gtk.CssProvider();
    provider.load_from_path(`${HERE}/style.css`);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
});
app.connect('activate', () => {
    (app.active_window ?? new SettingsWindow(app)).present();
});
app.run([system.programInvocationName, ...ARGV]);
