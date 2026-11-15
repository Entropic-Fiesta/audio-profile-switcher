/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "child_process";
import { IpcMainInvokeEvent } from "electron";
import { readdir, readFile } from "fs/promises";

function windowsProcessNames(): Promise<string[]> {
    return new Promise(resolve => {
        // CSV rows look like: "vrserver.exe","1234","Console","1","50,000 K"
        execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve([]);
            resolve(stdout.split(/\r?\n/)
                .map(line => line.match(/^"([^"]+)"/)?.[1])
                .filter((n): n is string => !!n));
        });
    });
}

// comm is cut to 15 characters, so also use argv[0], which also gives Wine/Proton programs their .exe name
async function linuxProcessNames(): Promise<string[]> {
    const names: string[] = [];
    const pids = (await readdir("/proc").catch(() => [] as string[])).filter(d => /^\d+$/.test(d));

    await Promise.all(pids.map(async pid => {
        const [cmdline, comm] = await Promise.all([
            readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
            readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")
        ]);
        const argv0 = cmdline.split("\0")[0];
        const fromPath = argv0?.split(/[\\/]/).pop()?.trim();
        if (fromPath) names.push(fromPath);
        if (comm.trim()) names.push(comm.trim());
    }));

    return names;
}

const getProcessNames = () => process.platform === "win32" ? windowsProcessNames() : linuxProcessNames();

// Ignoring ".exe" lets one trigger match on both Windows and Linux
const normalizeName = (n: string) => n.trim().toLowerCase().replace(/\.exe$/, "");

export async function listRunningApps(_: IpcMainInvokeEvent): Promise<string[]> {
    const seen = new Map<string, string>();
    for (const n of await getProcessNames()) {
        const key = n.toLowerCase();
        if (!seen.has(key)) seen.set(key, n);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export async function whichRunning(_: IpcMainInvokeEvent, wanted: string[]): Promise<string[]> {
    const want = new Set(wanted.map(normalizeName).filter(Boolean));
    if (!want.size) return [];
    const running = new Set((await getProcessNames()).map(normalizeName));
    return [...want].filter(n => running.has(n));
}
