import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const UPDATE_INTERVAL_SECONDS = 2;
const HISTORY = 30;
const HOT_THRESHOLD = 85;

const COLORS = {
    power: [0.97, 0.83, 0.18],
    cpu: [0.38, 0.63, 0.92],
    ram: [0.75, 0.38, 0.80],
};

const decoder = new TextDecoder();

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

function readNumber(path) {
    const text = readFile(path);
    if (text === null)
        return null;
    const n = Number(text.trim());
    return Number.isFinite(n) ? n : null;
}

function listDir(path) {
    const names = [];
    try {
        const dir = GLib.Dir.open(path, 0);
        let name;
        while ((name = dir.read_name()) !== null)
            names.push(name);
        dir.close();
    } catch {}
    return names;
}

const Graph = GObject.registerClass(
class Graph extends St.DrawingArea {
    _init(color, autoScaleMin = 0) {
        super._init({
            style_class: 'pstats-graph',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._color = color;
        // 0 means a fixed 0-100 scale, otherwise scale to max(history, autoScaleMin).
        this._autoScaleMin = autoScaleMin;
        this._values = [];
        this.connect('repaint', () => this._draw());
    }

    push(value) {
        this._values.push(value);
        if (this._values.length > HISTORY)
            this._values.shift();
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const [r, g, b] = this._color;

        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        const values = this._values;
        if (values.length > 1) {
            const max = this._autoScaleMin
                ? Math.max(this._autoScaleMin, ...values) * 1.1
                : 100;
            const step = w / (HISTORY - 1);
            const x0 = w - (values.length - 1) * step;
            const y = v => h - Math.min(Math.max(v / max, 0), 1) * (h - 1);

            cr.moveTo(x0, h);
            values.forEach((v, i) => cr.lineTo(x0 + i * step, y(v)));
            cr.lineTo(w, h);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.35);
            cr.fill();

            cr.moveTo(x0, y(values[0]));
            values.forEach((v, i) => cr.lineTo(x0 + i * step, y(v)));
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(1.2);
            cr.stroke();
        }

        cr.$dispose();
    }
});

class Sampler {
    constructor() {
        this._prevCpu = null;
        this._prevProcTicks = new Map();
        this._appKeyCache = new Map();
        this._battery = this._findBattery();
    }

    _findBattery() {
        const base = '/sys/class/power_supply';
        for (const name of listDir(base)) {
            const dir = `${base}/${name}`;
            if (readFile(`${dir}/type`)?.trim() !== 'Battery')
                continue;
            if (readFile(`${dir}/scope`)?.trim() === 'Device')
                continue;
            return dir;
        }
        return null;
    }

    // Watts, positive. Returns {watts, charging} or null if unavailable.
    power() {
        if (!this._battery)
            return null;
        const status = readFile(`${this._battery}/status`)?.trim() ?? '';
        let watts = null;
        const powerNow = readNumber(`${this._battery}/power_now`);
        if (powerNow !== null) {
            watts = Math.abs(powerNow) / 1e6;
        } else {
            const current = readNumber(`${this._battery}/current_now`);
            const voltage = readNumber(`${this._battery}/voltage_now`);
            if (current !== null && voltage !== null)
                watts = Math.abs(current * voltage) / 1e12;
        }
        if (watts === null)
            return null;
        return {watts, charging: status === 'Charging', onAc: status !== 'Discharging'};
    }

    // Returns {cpuPercent, totalDelta} using /proc/stat.
    cpu() {
        const line = readFile('/proc/stat')?.split('\n', 1)[0];
        if (!line)
            return {cpuPercent: 0, totalDelta: 0};
        const f = line.trim().split(/\s+/).slice(1, 9).map(Number);
        const idle = f[3] + f[4];
        const total = f.reduce((a, v) => a + v, 0);
        let cpuPercent = 0, totalDelta = 0;
        if (this._prevCpu) {
            totalDelta = total - this._prevCpu.total;
            const idleDelta = idle - this._prevCpu.idle;
            if (totalDelta > 0)
                cpuPercent = 100 * (totalDelta - idleDelta) / totalDelta;
        }
        this._prevCpu = {total, idle};
        return {cpuPercent, totalDelta};
    }

    ram() {
        const text = readFile('/proc/meminfo') ?? '';
        const get = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
        const total = get('MemTotal');
        const available = get('MemAvailable');
        if (!total)
            return {percent: 0, usedGiB: 0};
        return {
            percent: 100 * (total - available) / total,
            usedGiB: (total - available) / 1048576,
        };
    }

    // Group key for a process: the app scope systemd put it in, or its comm.
    _appKey(pid, comm) {
        let key = this._appKeyCache.get(pid);
        if (key === undefined) {
            const cgroup = readFile(`/proc/${pid}/cgroup`) ?? '';
            const matches = [...cgroup.matchAll(/\/app-(?:gnome-|flatpak-)?([^/]+?)-\d+\.scope/g)];
            key = matches.length
                ? `app:${matches.at(-1)[1].replace(/\\x2d/g, '-')}`
                : `comm:${comm}`;
            this._appKeyCache.set(pid, key);
        }
        return key;
    }

    // Returns {key, percent} of the group using the most CPU since last call.
    topApp(totalDelta) {
        const ticks = new Map();
        const usage = new Map();

        for (const name of listDir('/proc')) {
            if (!/^\d+$/.test(name))
                continue;
            const stat = readFile(`/proc/${name}/stat`);
            if (!stat)
                continue;
            const open = stat.indexOf('(');
            const close = stat.lastIndexOf(')');
            const comm = stat.slice(open + 1, close);
            const rest = stat.slice(close + 2).split(' ');
            const t = Number(rest[11]) + Number(rest[12]);
            const pid = Number(name);
            ticks.set(pid, t);

            const prev = this._prevProcTicks.get(pid);
            if (prev === undefined || t <= prev)
                continue;
            const key = this._appKey(pid, comm);
            usage.set(key, (usage.get(key) ?? 0) + t - prev);
        }

        for (const pid of this._appKeyCache.keys()) {
            if (!ticks.has(pid))
                this._appKeyCache.delete(pid);
        }
        this._prevProcTicks = ticks;

        let best = null;
        for (const [key, delta] of usage) {
            if (!best || delta > best.delta)
                best = {key, delta};
        }
        if (!best || totalDelta <= 0)
            return null;
        return {key: best.key, percent: 100 * best.delta / totalDelta};
    }
}

const StatsIndicator = GObject.registerClass(
class StatsIndicator extends PanelMenu.Button {
    _init(iconDir) {
        super._init(0.0, 'Performance Stats', true);

        this._sampler = new Sampler();
        this._appInfoCache = new Map();

        const box = new St.BoxLayout({style_class: 'pstats-box'});
        this.add_child(box);

        const makeItem = (iconName, color, autoScaleMin) => {
            const item = new St.BoxLayout({style_class: 'pstats-item'});
            item.add_child(new St.Icon({
                gicon: Gio.icon_new_for_string(`${iconDir}/pstats-${iconName}-symbolic.svg`),
                icon_size: 14,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const graph = new Graph(color, autoScaleMin);
            const label = new St.Label({
                style_class: 'pstats-label',
                y_align: Clutter.ActorAlign.CENTER,
                text: '…',
            });
            item.add_child(graph);
            item.add_child(label);
            box.add_child(item);
            return {item, graph, label};
        };

        const appItem = new St.BoxLayout({style_class: 'pstats-item'});
        this._appIcon = new St.Icon({
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
            icon_name: 'application-x-executable-symbolic',
        });
        this._appLabel = new St.Label({
            style_class: 'pstats-label pstats-app-label',
            y_align: Clutter.ActorAlign.CENTER,
            text: '…',
        });
        this._appLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        appItem.add_child(this._appIcon);
        appItem.add_child(this._appLabel);
        box.add_child(appItem);

        this._power = makeItem('power', COLORS.power, 10);
        this._cpu = makeItem('cpu', COLORS.cpu, 0);
        this._ram = makeItem('ram', COLORS.ram, 0);

        if (!this._sampler._battery)
            this._power.item.hide();

        this._update();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            UPDATE_INTERVAL_SECONDS, () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _setHot(label, hot) {
        if (hot)
            label.add_style_class_name('pstats-hot');
        else
            label.remove_style_class_name('pstats-hot');
    }

    _resolveApp(key) {
        let info = this._appInfoCache.get(key);
        if (info)
            return info;

        const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
        let app = null;
        if (kind === 'app') {
            const appSystem = Shell.AppSystem.get_default();
            app = appSystem.lookup_app(`${id}.desktop`) ??
                appSystem.lookup_desktop_wmclass(id) ??
                appSystem.lookup_startup_wmclass(id);
        }
        info = app
            ? {name: app.get_name(), gicon: app.get_icon()}
            : {name: kind === 'app' ? id.split('.').at(-1) : id, gicon: null};
        this._appInfoCache.set(key, info);
        return info;
    }

    _update() {
        try {
            const power = this._sampler.power();
            if (power) {
                const {watts, charging, onAc} = power;
                this._power.graph.push(watts);
                this._power.label.text = onAc && !charging && watts < 0.05
                    ? 'AC'
                    : `${charging ? '+' : ''}${watts.toFixed(1)}W`;
                if (charging)
                    this._power.label.add_style_class_name('pstats-charging');
                else
                    this._power.label.remove_style_class_name('pstats-charging');
            }

            const {cpuPercent, totalDelta} = this._sampler.cpu();
            this._cpu.graph.push(cpuPercent);
            this._cpu.label.text = `${Math.round(cpuPercent)}%`;
            this._setHot(this._cpu.label, cpuPercent >= HOT_THRESHOLD);

            const ram = this._sampler.ram();
            this._ram.graph.push(ram.percent);
            this._ram.label.text = `${ram.usedGiB.toFixed(1)}G`;
            this._setHot(this._ram.label, ram.percent >= HOT_THRESHOLD);

            const top = this._sampler.topApp(totalDelta);
            if (top) {
                const info = this._resolveApp(top.key);
                if (info.gicon)
                    this._appIcon.gicon = info.gicon;
                else
                    this._appIcon.icon_name = 'application-x-executable-symbolic';
                this._appLabel.text = `${info.name} ${Math.round(top.percent)}%`;
            }
        } catch (e) {
            console.error(`[performance-stats] ${e}`);
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super.destroy();
    }
});

export default class PerformanceStatsExtension extends Extension {
    enable() {
        this._indicator = new StatsIndicator(this.path + '/icons');
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
