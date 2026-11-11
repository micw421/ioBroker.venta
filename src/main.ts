import * as utils from '@iobroker/adapter-core';

interface VentaConfig extends ioBroker.AdapterConfig {
    host: string;
    pollInterval: number;
    timeout: number;
}

interface Telemetry {
    Header: { DeviceType: number; ProtocolV: string };
    Action: { Power: number; FanSpeed: number; TargetHum: number; SleepMode: number; Automatic: number; BaLi: number };
    Info: { OperationT: number; ServiceT: number; ServiceMax: number; Warnings: number; SWMain: string; HwIndexMB: number };
    Measure: { Temperature: number; Humidity: number };
}

class Venta extends utils.Adapter {
    private timer?: ReturnType<typeof setTimeout>;
    private readonly definitions: Array<[string, string, string, boolean, string, string?]> = [
        ['control.Power', 'Power', 'boolean', true, 'switch.power'],
        ['control.FanSpeed', 'Fan speed', 'number', true, 'level.speed'],
        ['control.Automatic', 'Automatic mode', 'boolean', true, 'switch.mode.auto'],
        ['control.TargetHum', 'Target humidity', 'number', true, 'level.humidity', '%'],
        ['control.SleepMode', 'Sleep mode', 'number', false, 'value'],
        ['control.BaLi', 'BaLi', 'number', false, 'value'],
        ['measurements.Temperature', 'Temperature', 'number', false, 'value.temperature', '°C'],
        ['measurements.Humidity', 'Humidity', 'number', false, 'value.humidity', '%'],
        ['info.OperationT', 'Operating time', 'number', false, 'value'],
        ['info.ServiceT', 'Service counter', 'number', false, 'value'],
        ['info.ServiceMax', 'Service maximum', 'number', false, 'value'],
        ['info.DaysToService', 'Days until service', 'number', false, 'value', 'days'],
        ['info.Warnings', 'Warnings', 'number', false, 'value'],
        ['info.SWMain', 'Software version', 'string', false, 'text'],
        ['info.HwIndexMB', 'Hardware index', 'number', false, 'value'],
        ['info.DeviceType', 'Device type', 'number', false, 'value'],
        ['info.ProtocolV', 'Protocol version', 'string', false, 'text'],
    ];

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'venta' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        for (const channel of ['control', 'measurements', 'info']) {
            await this.setObjectNotExistsAsync(channel, { type: 'channel', common: { name: channel }, native: {} });
        }
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state', common: { name: 'Connected to Venta', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false }, native: {},
        });
        for (const [id, name, type, write, role, unit] of this.definitions) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { name, type: type as 'boolean' | 'number' | 'string', role, read: true, write, ...(unit ? { unit } : {}) },
                native: {},
            });
        }
        this.subscribeStates('control.*');
        await this.setStateAsync('info.connection', false, true);
        await this.poll();
    }

    private async request(body?: Record<string, unknown>): Promise<Telemetry> {
        const config = this.config as VentaConfig;
        const host = config.host.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
        if (!host) throw new Error('Venta host is not configured');
        const timeout = Math.max(500, Number(config.timeout) || 2000);
        const response = await fetch(`http://${host}/api/telemetry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json: unknown = await response.json();
        if (!json || typeof json !== 'object' || !('Action' in json) || !('Info' in json) || !('Measure' in json) || !('Header' in json)) {
            throw new Error('Unexpected telemetry response');
        }
        return json as Telemetry;
    }

    private async updateTelemetry(data: Telemetry): Promise<void> {
        const values: Record<string, string | number | boolean> = {
            'control.Power': data.Action.Power === 1,
            'control.FanSpeed': data.Action.FanSpeed,
            'control.Automatic': data.Action.Automatic === 1,
            'control.TargetHum': data.Action.TargetHum,
            'control.SleepMode': data.Action.SleepMode,
            'control.BaLi': data.Action.BaLi,
            'measurements.Temperature': data.Measure.Temperature,
            'measurements.Humidity': data.Measure.Humidity,
            'info.OperationT': data.Info.OperationT,
            'info.ServiceT': data.Info.ServiceT,
            'info.ServiceMax': data.Info.ServiceMax,
            'info.DaysToService': Math.ceil((data.Info.ServiceMax - data.Info.ServiceT) / 144),
            'info.Warnings': data.Info.Warnings,
            'info.SWMain': data.Info.SWMain,
            'info.HwIndexMB': data.Info.HwIndexMB,
            'info.DeviceType': data.Header.DeviceType,
            'info.ProtocolV': data.Header.ProtocolV,
        };
        for (const [id, value] of Object.entries(values)) await this.setStateAsync(id, value, true);
        await this.setStateAsync('info.connection', true, true);
    }

    private async poll(): Promise<void> {
        try {
            await this.updateTelemetry(await this.request());
        } catch (error) {
            this.log.warn(`Venta polling failed: ${String(error)}`);
            await this.setStateAsync('info.connection', false, true);
        } finally {
            const seconds = Math.max(10, Number((this.config as VentaConfig).pollInterval) || 60);
            this.timer = setTimeout(() => { void this.poll(); }, seconds * 1000);
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || !id.startsWith(`${this.namespace}.control.`)) return;
        const key = id.slice(this.namespace.length + '.control.'.length);
        if (!['Power', 'FanSpeed', 'Automatic', 'TargetHum'].includes(key)) return;
        try {
            const current = await this.request();
            let command: Record<string, unknown>;
            if (key === 'Power') {
                command = {
                    Power: state.val ? 1 : 0,
                    FanSpeed: current.Action.FanSpeed,
                    SleepMode: 0,
                    Automatic: current.Action.Automatic,
                };
            } else if (key === 'FanSpeed') {
                if (typeof state.val !== 'number' || !Number.isInteger(state.val) || state.val < 0) {
                    throw new Error('Expected non-negative integer fan speed');
                }
                command = { Power: 1, FanSpeed: state.val, Automatic: 0 };
            } else if (key === 'Automatic') {
                command = { Power: 1, Automatic: state.val ? 1 : 0 };
            } else {
                if (typeof state.val !== 'number' || !Number.isFinite(state.val) || state.val < 0 || state.val > 100) {
                    throw new Error('Expected target humidity between 0 and 100');
                }
                command = { TargetHum: state.val };
            }
            const result = await this.request({ ...command, Action: 'control' });
            await this.updateTelemetry(result);
        } catch (error) {
            this.log.warn(`Venta control failed (${key}): ${String(error)}`);
            await this.setStateAsync('info.connection', false, true);
        }
    }

    private onUnload(callback: () => void): void {
        if (this.timer) clearTimeout(this.timer);
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> = {}): Venta => new Venta(options);
} else {
    new Venta();
}
