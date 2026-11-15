# AudioProfileSwitcher

An auto audio switcher for Discord, as a [Vencord](https://vencord.dev) plugin.

It changes your microphone, speakers and input profile when certain apps open, and changes them back when they close.

I made it for VR. Every time I put my headset on I had to go into Discord's Voice & Video settings and swap to the headset's mic and speakers, then swap back afterwards. With a Quest and a SteamVR headset that would be three different setups. This plugin does it for you. It isn't tied to VR though, so it works for anything: a game, a streaming app, a DAW.

## Features

- **Profiles.** One per setup (e.g. *Quest*, *SteamVR*, *Streaming*), each with its own mic, speakers and input profile.
- **Trigger apps.** A profile switches on while any of its apps is running.
- **Desktop profile.** Used when nothing is running.
- **Input profile per mic.** Voice Isolation, Studio or Custom, same as Discord's own setting.
- **Priority.** If apps from several profiles are open, the one highest in the list wins. Reorder with ↑ ↓.
- **Safe with unplugged devices.** If a saved device isn't connected, it's left alone instead of switching to nothing.

## Finding apps

Pick how the plugin finds trigger apps at the top of its settings:

| Mode | What it can see | Good for |
|---|---|---|
| **Apps Discord detects** (default) | Only what Discord already detects as games, plus anything you add under *Settings → Registered Games*. You pick from Discord's detection history. | Games, and anyone who doesn't want a plugin looking at their running programs. |
| **Any running program** | Every running program, checked every few seconds. | Background software without a window, like SteamVR (`vrserver.exe`). |

SteamVR runs in the background and Discord doesn't detect it, so for SteamVR use **Any running program** with `vrserver.exe` as the trigger.

Names match with or without `.exe`, so `vrserver.exe` works on Linux too.

## Install

This is a third-party plugin, so you need Vencord built from source. Vencord's [custom plugins guide](https://docs.vencord.dev/installing/custom-plugins/) covers the setup.

1. Clone this repo into Vencord's `src/userplugins` folder:
   ```
   cd Vencord/src/userplugins
   git clone https://github.com/Entropic-Fiesta/audio-profile-switcher audioProfileSwitcher.discordDesktop
   ```
2. Build and install from the Vencord folder:
   ```
   pnpm build
   pnpm inject
   ```
3. Fully quit Discord (tray icon → Quit Discord) and reopen it.
4. Go to *Settings → Vencord → Plugins*, enable **AudioProfileSwitcher**, and open its settings.

## Platforms

- **Windows**: what it was built and used on.
- **Linux**: should work. Program detection reads `/proc`, so long names and Wine/Proton programs show up correctly. Discord's device switching on Linux hasn't been tested yet.
- **macOS**: not supported.

Only works in the Discord desktop app, not in the browser or Vesktop.

## How it works

- Device changes use the same actions as Discord's Voice & Video settings, so nothing about your account or Discord's files is modified.
- **Apps Discord detects** reads Discord's own list of running games, and needs no extra access.
- **Any running program** reads the process list (`tasklist` on Windows, `/proc` on Linux) to get program names. Nothing is stored or sent anywhere.

## Credits

Made by lip_biter, with [Claude](https://claude.ai) (Anthropic's AI) writing most of the code from my ideas and testing.

## License

GPL-3.0-or-later, same as Vencord.
