/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { LazyComponent } from "@utils/lazyReact";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { FluxDispatcher, MediaEngineStore, React, RunningGameStore, Select, TextInput, useEffect, useMemo, useState, useStateFromStores } from "@webpack/common";

const Native = VencordNative.pluginHelpers.AudioProfileSwitcher as PluginNative<typeof import("./native")>;

type Kind = "input" | "output";

interface AudioSetup {
    input: string; //        "" = don't change
    inputProfile: string; // "" = don't change
    output: string; //       "" = don't change
}

interface Profile extends AudioSetup {
    id: string;
    name: string;
    triggers: string[];
}

const DESKTOP_ID = "desktop";

// Same as in native.ts. Ignoring ".exe" lets one trigger match on both Windows and Linux
const normalizeName = (n: string) => n.trim().toLowerCase().replace(/\.exe$/, "");

// Values Discord uses internally for Settings → Voice & Video → Input Profile
const PROFILE_OPTIONS = [
    { label: "Don't change", value: "" },
    { label: "Voice Isolation", value: "VOICE_ISOLATION" },
    { label: "Studio", value: "STUDIO" },
    { label: "Custom", value: "CUSTOM" }
];

const emptySetup = (): AudioSetup => ({ input: "", inputProfile: "", output: "" });
const newId = () => Math.random().toString(36).slice(2, 10);

const settings = definePluginSettings({
    detection: {
        type: OptionType.SELECT,
        description: "How trigger apps are found",
        options: [
            { label: "Apps Discord detects (games, and anything you add under Registered Games)", value: "discord", default: true },
            { label: "Any running program (needed for background VR software like SteamVR's vrserver)", value: "processes" }
        ],
        onChange: () => restart()
    },
    ui: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => <SettingsPanel />
    },
    profiles: { type: OptionType.CUSTOM, default: [] as Profile[] },
    desktop: { type: OptionType.CUSTOM, default: emptySetup() },
    checkInterval: {
        type: OptionType.NUMBER,
        description: "How often to check running programs, in seconds (only for \"Any running program\")",
        default: 3,
        onChange: () => restart()
    },
});

let activeId: string | null = null;

// Settings proxies nested inside new objects can't be cloned over IPC, so always work on plain copies
const plainCopy = <T,>(v: T): T => v == null ? v : JSON.parse(JSON.stringify(v));
const getProfiles = (): Profile[] => plainCopy(settings.store.profiles as Profile[]) ?? [];
const getDesktop = (): AudioSetup => plainCopy(settings.store.desktop as AudioSetup) ?? emptySetup();

const audioChanged = (patch: object) => "input" in patch || "output" in patch || "inputProfile" in patch;

function updateProfile(id: string, patch: Partial<Profile>) {
    settings.store.profiles = getProfiles().map(p => p.id === id ? { ...p, ...patch } : p);
    if (id === activeId && audioChanged(patch)) applySetup(setupFor(id));
}

function updateDesktop(patch: Partial<AudioSetup>) {
    settings.store.desktop = { ...getDesktop(), ...patch };
    if (activeId === DESKTOP_ID && audioChanged(patch)) applySetup(getDesktop());
}

/* ---------- applying audio settings ---------- */

function getDevices(kind: Kind): Record<string, { id: string; name: string; }> {
    const store = MediaEngineStore as any;
    return (kind === "input" ? store.getInputDevices() : store.getOutputDevices()) ?? {};
}

function setDevice(kind: Kind, id: string) {
    if (!id) return;
    // Skip devices that aren't plugged in right now, so Discord isn't pointed at nothing
    if (!getDevices(kind)[id]) {
        console.warn(`[AudioProfileSwitcher] ${kind} device not connected, leaving as is:`, id);
        return;
    }
    const store = MediaEngineStore as any;
    const oldId = kind === "input" ? store.getInputDeviceId() : store.getOutputDeviceId();
    if (oldId === id) return;
    // Same action Discord's own Voice & Video settings fire
    FluxDispatcher.dispatch({
        type: kind === "input" ? "AUDIO_SET_INPUT_DEVICE" : "AUDIO_SET_OUTPUT_DEVICE",
        id,
        oldId
    });
}

function setInputProfile(profile: string) {
    if (!profile) return;
    if ((MediaEngineStore as any).getActiveInputProfile?.() === profile) return;
    FluxDispatcher.dispatch({ type: "AUDIO_SET_ACTIVE_INPUT_PROFILE", inputProfile: profile });
}

function applySetup(setup: AudioSetup) {
    setDevice("input", setup.input);
    setDevice("output", setup.output);
    setInputProfile(setup.inputProfile);
}

function setupFor(id: string): AudioSetup {
    return id === DESKTOP_ID ? getDesktop() : getProfiles().find(p => p.id === id) ?? getDesktop();
}

/* ---------- watching for trigger apps ---------- */

const usesDiscordDetection = () => settings.store.detection !== "processes";

const exeName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function discordDetectedApps(): string[] {
    const games = (RunningGameStore.getRunningGames() ?? []) as { name?: string; exePath?: string; }[];
    return games.flatMap(g => [g.exePath && exeName(g.exePath), g.name]).filter((n): n is string => !!n);
}

async function runningTriggers(triggers: string[]): Promise<string[]> {
    if (!usesDiscordDetection()) return Native.whichRunning(triggers);
    const running = new Set(discordDetectedApps().map(normalizeName));
    return triggers.map(normalizeName).filter(t => running.has(t));
}

interface PickOption { label: string; value: string; }

// Everything Discord has ever detected (Registered Games), running ones first
function discordPickableApps(): PickOption[] {
    type Game = { name?: string; exePath?: string; };
    const running = (RunningGameStore.getRunningGames() ?? []) as Game[];
    const seen = (RunningGameStore.getGamesSeen() ?? []) as Game[];
    const runningExes = new Set(running.map(g => g.exePath && normalizeName(exeName(g.exePath))));

    const options = new Map<string, PickOption & { running: boolean; }>();
    for (const g of [...running, ...seen]) {
        if (!g.exePath) continue;
        const exe = exeName(g.exePath);
        const key = normalizeName(exe);
        if (options.has(key)) continue;
        const isRunning = runningExes.has(key);
        const name = g.name && normalizeName(g.name) !== key ? `${g.name} (${exe})` : exe;
        options.set(key, { label: isRunning ? `${name} · running` : name, value: exe, running: isRunning });
    }

    return [...options.values()]
        .sort((a, b) => Number(b.running) - Number(a.running) || a.label.localeCompare(b.label))
        .map(({ label, value }) => ({ label, value }));
}

async function listPickableApps(): Promise<PickOption[]> {
    if (usesDiscordDetection()) return discordPickableApps();
    return (await Native.listRunningApps()).map(n => ({ label: n, value: n }));
}

let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;
const listeners = new Set<() => void>();

function setActive(id: string | null) {
    activeId = id;
    listeners.forEach(l => l());
}

async function check() {
    if (checking) return;
    checking = true;
    try {
        const profiles = getProfiles();
        const running = new Set(await runningTriggers(profiles.flatMap(p => p.triggers)));
        // First profile in the list with a running trigger app wins
        const match = profiles.find(p => p.triggers.some(t => running.has(normalizeName(t))));
        const id = match?.id ?? DESKTOP_ID;
        if (id !== activeId) {
            setActive(id);
            applySetup(setupFor(id));
        }
    } catch (e) {
        console.error("[AudioProfileSwitcher] check failed", e);
    } finally {
        checking = false;
    }
}

/* ---------- settings UI ---------- */

const heading = { color: "var(--header-primary)", fontWeight: 700, fontSize: 16, margin: 0 } as const;
const label = { color: "var(--header-secondary)", fontWeight: 600, fontSize: 12, textTransform: "uppercase", margin: "12px 0 6px" } as const;
const muted = { color: "var(--text-muted)", fontSize: 14, margin: "4px 0 0" } as const;
const card = { padding: 16, borderRadius: 8, background: "var(--background-secondary)", marginBottom: 12 } as const;
const row = { display: "flex", gap: 8, alignItems: "center" } as const;

function useActiveId() {
    const [, force] = useState(0);
    useEffect(() => {
        const l = () => force(x => x + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
    return activeId;
}

function Picker({ text, value, options, onChange }: { text: string; value: string; options: { label: string; value: string; }[]; onChange(v: string): void; }) {
    return (
        <div>
            <div style={label}>{text}</div>
            <Select options={options} isSelected={(v: string) => v === value} select={onChange} serialize={String} />
        </div>
    );
}

function DeviceSelect({ text, kind, value, onChange }: { text: string; kind: Kind; value: string; onChange(v: string): void; }) {
    const devices = useStateFromStores([MediaEngineStore], () => getDevices(kind));
    const options = useMemo(() => {
        const opts = [
            { label: "Don't change", value: "" },
            ...Object.values(devices).map(d => ({ label: d.name, value: d.id }))
        ];
        if (value && !devices[value]) opts.push({ label: "(saved device, not connected right now)", value });
        return opts;
    }, [devices, value]);
    return <Picker text={text} value={value} options={options} onChange={onChange} />;
}

function AudioFields({ setup, onChange }: { setup: AudioSetup; onChange(patch: Partial<AudioSetup>): void; }) {
    return (
        <>
            <DeviceSelect text="Microphone" kind="input" value={setup.input} onChange={input => onChange({ input })} />
            <Picker text="Input profile" value={setup.inputProfile} options={PROFILE_OPTIONS} onChange={inputProfile => onChange({ inputProfile })} />
            <DeviceSelect text="Speakers" kind="output" value={setup.output} onChange={output => onChange({ output })} />
        </>
    );
}

function TriggerEditor({ profile, runningApps, refresh }: { profile: Profile; runningApps: PickOption[]; refresh(): void; }) {
    const [typed, setTyped] = useState("");
    const has = (n: string) => profile.triggers.some(t => normalizeName(t) === normalizeName(n));
    const add = (n: string) => {
        n = n.trim();
        if (n && !has(n)) updateProfile(profile.id, { triggers: [...profile.triggers, n] });
    };
    const remove = (n: string) => updateProfile(profile.id, { triggers: profile.triggers.filter(t => t !== n) });
    const addable = useMemo(
        () => runningApps.filter(o => !has(o.value)),
        [runningApps, profile.triggers]
    );

    return (
        <>
            <div style={label}>Trigger apps</div>
            {profile.triggers.length === 0 && <p style={{ ...muted, marginBottom: 6 }}>None yet, so this profile never switches on.</p>}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                {profile.triggers.map(t => (
                    <span key={t} style={{ ...row, gap: 6, padding: "4px 6px 4px 10px", borderRadius: 999, background: "var(--background-tertiary)", color: "var(--text-normal)", fontFamily: "var(--font-code)", fontSize: 13 }}>
                        {t}
                        <Button size="min" variant="dangerSecondary" onClick={() => remove(t)} aria-label={`Remove ${t}`}>✕</Button>
                    </span>
                ))}
            </div>
            <div style={row}>
                <div style={{ flex: 1 }}>
                    <Select
                        options={addable}
                        placeholder={usesDiscordDetection() ? "Add an app Discord has detected…" : "Add a running program…"}
                        isSelected={() => false}
                        select={(v: string) => add(v)}
                        serialize={String}
                    />
                </div>
                <Button size="small" variant="secondary" onClick={refresh}>Refresh</Button>
            </div>
            <div style={{ ...row, marginTop: 8 }}>
                <div style={{ flex: 1 }}>
                    <TextInput placeholder="…or type a name, e.g. vrserver.exe" value={typed} onChange={setTyped} spellCheck={false} />
                </div>
                <Button size="small" variant="secondary" onClick={() => { add(typed); setTyped(""); }}>Add</Button>
            </div>
        </>
    );
}

// Only saves on blur/Enter, since every settings write saves the whole settings file
function NameInput({ value, onCommit }: { value: string; onCommit(v: string): void; }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    const commit = () => text !== value && onCommit(text.trim());
    return (
        <TextInput
            value={text}
            onChange={setText}
            onBlur={commit}
            onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && commit()}
            placeholder="Profile name, e.g. Quest"
            spellCheck={false}
        />
    );
}

// Discord's React isn't ready when this file first loads, so the memoized card is created on first use
const ProfileCard = LazyComponent(() => React.memo(function ProfileCard({ profile, index, count, active, runningApps, refresh }: {
    profile: Profile; index: number; count: number; active: boolean; runningApps: PickOption[]; refresh(): void;
}) {
    const move = (dir: -1 | 1) => {
        const list = [...getProfiles()];
        const [p] = list.splice(index, 1);
        list.splice(index + dir, 0, p);
        settings.store.profiles = list;
    };
    const remove = () => settings.store.profiles = getProfiles().filter(p => p.id !== profile.id);

    return (
        <div style={{ ...card, outline: active ? "2px solid var(--brand-500, #5865f2)" : "none" }}>
            <div style={{ ...row, justifyContent: "space-between" }}>
                <div style={{ flex: 1 }}>
                    <NameInput value={profile.name} onCommit={name => updateProfile(profile.id, { name })} />
                </div>
                {active && <span style={{ color: "var(--text-positive, #23a55a)", fontWeight: 600, fontSize: 13 }}>Active</span>}
                <Button size="small" variant="secondary" disabled={index === 0} onClick={() => move(-1)} aria-label="Move up">↑</Button>
                <Button size="small" variant="secondary" disabled={index === count - 1} onClick={() => move(1)} aria-label="Move down">↓</Button>
                <Button size="small" variant="dangerSecondary" onClick={remove}>Delete</Button>
            </div>
            <TriggerEditor profile={profile} runningApps={runningApps} refresh={refresh} />
            <AudioFields setup={profile} onChange={patch => updateProfile(profile.id, patch)} />
        </div>
    );
}, (a, b) =>
    a.index === b.index && a.count === b.count && a.active === b.active && a.runningApps === b.runningApps &&
    JSON.stringify(a.profile) === JSON.stringify(b.profile)
));

const WATCHED_KEYS = ["profiles", "desktop", "detection"] as const;
const refreshRunning = (set: (v: PickOption[]) => void) => listPickableApps().then(set).catch(() => set([]));

const SettingsPanel = ErrorBoundary.wrap(function SettingsPanel() {
    settings.use(WATCHED_KEYS as any);
    const active = useActiveId();
    const [runningApps, setRunningApps] = useState<PickOption[]>([]);
    const { detection } = settings.store;
    const refresh = React.useCallback(() => { refreshRunning(setRunningApps); }, []);
    useEffect(refresh, [detection]);

    const list = getProfiles();
    const desktop = getDesktop();
    const activeName = active === null ? "checking…" : active === DESKTOP_ID ? "Desktop" : list.find(p => p.id === active)?.name || "Unnamed profile";

    const addProfile = () => settings.store.profiles = [...list, { id: newId(), name: "", triggers: [], ...emptySetup() }];

    return (
        <div>
            <div style={{ ...card, color: "var(--text-normal)" }}>
                <b>Now using:</b> {activeName}
                <p style={muted}>
                    Each profile switches on while any of its trigger apps is running. If apps from several profiles are running,
                    the one highest in the list wins. When none are running, the Desktop profile is used.
                </p>
                {detection !== "processes" && (
                    <p style={muted}>
                        The list shows every app Discord has detected, running ones first. If an app isn't listed, add it under Discord's
                        Settings → Registered Games, or switch "How trigger apps are found" at the top to "Any running program".
                    </p>
                )}
            </div>

            {list.map((p, i) => (
                <ProfileCard key={p.id} profile={p} index={i} count={list.length} active={active === p.id} runningApps={runningApps} refresh={refresh} />
            ))}
            <div style={{ marginBottom: 20 }}>
                <Button onClick={addProfile}>Add profile</Button>
            </div>

            <div style={{ ...card, outline: active === DESKTOP_ID ? "2px solid var(--brand-500, #5865f2)" : "none" }}>
                <div style={{ ...row, justifyContent: "space-between" }}>
                    <h3 style={heading}>Desktop</h3>
                    {active === DESKTOP_ID && <span style={{ color: "var(--text-positive, #23a55a)", fontWeight: 600, fontSize: 13 }}>Active</span>}
                </div>
                <p style={muted}>Used when none of the trigger apps above are running.</p>
                <AudioFields setup={desktop} onChange={updateDesktop} />
            </div>
        </div>
    );
}, { noop: false });

/* ---------- plugin ---------- */

export default definePlugin({
    name: "AudioProfileSwitcher",
    description: "Automatically switches your mic, speakers and input profile when chosen apps open, e.g. a VR headset's software, and back when they close",
    tags: ["Voice", "Utility"],
    authors: [{ name: "lip_biter", id: 133057831921254401n }],
    settings,

    flux: {
        RUNNING_GAMES_CHANGE() {
            if (usesDiscordDetection()) check();
        }
    },

    start() {
        startWatching();
    },

    stop() {
        stopWatching();
        if (activeId && activeId !== DESKTOP_ID) applySetup(getDesktop());
        setActive(null);
    }
});

function startWatching() {
    setActive(null);
    check();
    if (!usesDiscordDetection())
        timer = setInterval(check, Math.max(1, settings.store.checkInterval) * 1000);
}

function stopWatching() {
    if (timer) clearInterval(timer);
    timer = null;
}

// Keeps activeId so devices only change if the result differs
function restart() {
    if (activeId === null) return;
    stopWatching();
    check();
    if (!usesDiscordDetection())
        timer = setInterval(check, Math.max(1, settings.store.checkInterval) * 1000);
}
