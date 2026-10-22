# F.R.I.D.A.Y

A multi-server Discord bot for support tickets, moderation, verification, voice rooms and staff activity tracking. Every server configures its own channels, roles and prefix, so nothing is hardcoded.

Built with Node 22, discord.js v14 and Firebase (Firestore).

---

## Features

- **Support tickets (ModMail):** members DM the bot to open a numbered private ticket in one shared ModMail category. Every ticket is handled by one configured Support Role. Members who share several servers with the bot choose which server to contact.
- **Moderation:** warnings, strikes, mute/kick/ban, purge, lock/hide, snipe, bad-word filter (per-server word lists).
- **AutoMod:** spam, repeats, mass mentions, emoji spam, invites, links and caps, switched on and tuned with buttons.
- **Anti-Nuke:** stops a rogue or compromised admin from mass-deleting channels/roles, mass-banning, adding bots and more, then repairs the damage.
- **Verification:** captcha button panel that gives a verified role.
- **Join-to-create voice rooms:** personal temporary rooms with owner controls.
- **Active Time:** tracks staff online/voice/message activity and posts a daily report.
- **AFK, quotes, avatar/user/server info and other utilities.**
- **YouTube upload alerts:** optional, per server.
- **Per-server prefix** shared by every command.
- **Owner-only access:** only servers approved by the bot owner can keep the bot.
- **No-prefix access:** the owner can let trusted users run commands without typing the prefix.

---

## Setting up a server

1. The bot owner approves the server (see [Owner access](#owner-access)), then invites the bot.
2. An admin (needs **Manage Server**) configures it:

```
.config                      open the setup menu: pick channels and roles from dropdowns (no IDs)
.config view                 list every setting
.config keys                 describe every setting
.config set <key> <value>    or type it: value = #channel or @role
.config clear <key>          remove a setting
.prefix <new prefix>         change the prefix (max 5 characters)
```

Examples:

```
.config set logs #mod-logs
.config set staffRole @Staff
.config set verifyChannel #verify
.config set verifiedRole @Verified
.setupverify                 posts the verification panel
```

### Settings

| Key | Type | What it does |
| --- | --- | --- |
| `prefix` | text | Command prefix (default `.`) |
| `logs` | text channel | Moderation, filter, verification and daily-report logs |
| `staffRole` | role | Can use moderation commands |
| `activityRole` | role | Tracked by Active Time (defaults to `staffRole`) |
| `atlogsRole` | role | Can view/manage Active Time logs |
| `verifyChannel` | text channel | Where the verification panel is posted |
| `verifiedRole` | role | Given on verification |
| `unverifiedRole` | role | Removed on verification (optional) |
| `voiceCreate` | voice channel | Joining it creates a personal room |
| `voiceCategory` | category | Where rooms are created (optional) |
| `ticketCategory` | category | ModMail category containing numbered ticket channels (created as `mod-mail`) |
| `ticketLogs` | text channel | ModMail ticket logs and transcripts |
| `supportRole` | role | One shared role for all ModMail tickets |
| `slowmodeChannel` | text channel | Gets automatic slowmode during bursts |
| `youtubeChannel`, `youtubeUrl` | text channel, URL | YouTube upload alerts |
| `ipMessage` | text | What the `ip` command replies with |

Settings are stored in Firestore (`guild_configs/{serverId}`).

The `.setup` wizard includes **Setup All** to create missing required resources and **Clear All** to undo only resources and settings recorded as created by Setup All. Existing ticket channels and manually selected channels or roles are preserved.

---

## AutoMod

Run `<prefix>automod` (needs **Manage Server**) to open the control panel. Everything is a button:

- **Rule buttons:** Spam, Repeats, Mentions, Emojis, Invites, Links, Caps and Bad words (your word list).
- **AutoMod: ON/OFF:** master switch for all rules except Bad words, which has its own button.
- **Action:** *Log only* (just report), *Delete*, or *Delete + timeout*. **Timeout** picks 2, 5, 10, 30 or 60 minutes.
- **Spam:** Low (more than 15 messages in 5 seconds), Medium (8) or High (5).
- **Ignored channels / roles:** pickers for places and people AutoMod should skip. Ignoring a category covers its channels.
- **Reset** puts everything back to the defaults (and switches AutoMod off).

It starts **off**. A safe way to roll it out: switch it on with *Log only*, watch the log channel for a day, then switch to *Delete*. Admins, members with Manage Messages, and the staff role are never checked. Hits are reported in the `logs` channel.

## Anti-Nuke

Run `<prefix>antinuke` to open the panel. **Only the server owner can use it**, so a compromised admin can't switch it off.

It watches the audit log and reacts when someone who is **not trusted** crosses the threshold:

| Button | Protects against |
| --- | --- |
| Channel delete / create | mass deleting or spamming channels |
| Role delete / create | mass deleting or spamming roles |
| Bans / Kicks | mass banning or kicking |
| Webhooks | new webhooks (deleted straight away) |
| Bot add | bots added by someone untrusted (removed) |
| Role perms | dangerous permissions given to a role (reverted) |

- **Punish:** *Strip roles* (removes their dangerous roles, the gentlest), *Kick* or *Ban*.
- **Trigger:** 3, 5 or 10 mass actions within 10 seconds.
- **Restore:** puts back the channels and roles the offender deleted, and removes what they spammed.
- **Trusted users:** pick people or bots that are never punished. Add your ticket bots and security bots here. The server owner and this bot are always trusted. `<prefix>antinuke trust <@user>` also adds or removes someone.

The bot needs **View Audit Log** (the panel warns if it's missing), plus Manage Roles / Manage Channels / Kick / Ban / Manage Webhooks for the matching responses. **Keep the bot's role above the roles it has to manage**, or punishments will fail (the alert tells you when that happens). Alerts go to the `logs` channel and are DMed to the server owner.

If another security bot is already protecting the server, keep only one Anti-Nuke active, or add that bot to the trusted list.

## Prefix

Every command uses the server's prefix. If someone forgets it, **@mentioning the bot** always works as a prefix (for example `@F.R.I.D.A.Y help`), and mentioning the bot on its own shows the current prefix.

Run `<prefix>help` for the full command list.

---

## Owner access

Only servers the bot owner has approved may keep the bot. If the bot is added anywhere else it leaves and DMs the owner.

| Command | What it does |
| --- | --- |
| `<prefix>addserver <serverId>` | Approve a server (do this **before** inviting) |
| `<prefix>removeserver <serverId>` | Revoke approval and leave that server |
| `<prefix>servers` | List current servers and approved-but-not-joined ones |

The owner is whoever `OWNER_ID` names (your Discord user ID; several IDs can be comma-separated). If `OWNER_ID` isn't set, the bot falls back to the Discord application's owner. On the first run after updating, every server the bot is already in is approved automatically.

### No-prefix access

Only the owner can turn it on or off for a user. A listed user can type `help` instead of `.help` in any server; everyone else still needs the prefix.

| Command | What it does |
| --- | --- |
| `<prefix>np add <@user or id>` | Turn no-prefix on for a user |
| `<prefix>np remove <@user or id>` | Turn it off |
| `<prefix>np list` | Show who has it |

`noprefix` works as a longer name for `np`.

A listed user triggers a command whenever a message *starts* with a command word (for example `ban`, `help`, `role`), so give it to people you trust. The list is stored in Firestore (`noprefix_users`) and follows the user into every server.

---

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token |
| `FIREBASE_KEY` | yes | Firebase service-account JSON (one line) |
| `PORT` | no | Health-check server port (default 3000) |
| `OWNER_ID` | recommended | Your Discord user ID. Controls the owner-only commands (`addserver`, `removeserver`, `servers`, `noprefix`). Falls back to the application's owner if unset |
| `DEFAULT_PREFIX` | no | Prefix for servers that haven't set one (default `.`) |
| `CONSOLE_LOG_CHANNEL_ID` | no | Mirror the bot's console into one Discord channel (owner debugging) |

See `.env.example`.

---

## Installation

```bash
git clone https://github.com/twirlyowes/F.R.I.D.A.Y.git
cd F.R.I.D.A.Y
npm install
cp .env.example .env     # then fill it in
node --env-file=.env index.js
```

Required bot permissions: Manage Channels, Manage Roles, Manage Messages, Kick/Ban Members, Moderate Members, View Channels, Send Messages, Embed Links, Read Message History, Connect/Move Members. Enable the **Message Content**, **Server Members** and **Presence** privileged intents in the Developer Portal.

---

## Upgrading from the single-server version

Warnings, AFK and Active Time used to be stored per user only. They are now stored per server and user. Copy existing records once for each server that had data:

```bash
node scripts/migrate-to-multiserver.js <serverId>            # dry run
node scripts/migrate-to-multiserver.js <serverId> --apply    # copy records
node scripts/migrate-to-multiserver.js <serverId> --apply --delete-old
```

Then run `.config` in each server to set its channels and roles. Command changes: every command now needs the prefix (including `help`, `afk`, `purge`, `snipe`, `role`), and `+strike` / `-strike` became `strike`, `strikes` and `unstrike`.

---

## Project structure

```
.
├── index.js            entry point, slash commands, auto-slowmode, module loading
├── settings.js         config + prefix commands
├── access.js           owner-only server approval
├── noprefix.js         owner-managed no-prefix users
├── help.js             help card and ticket (ModMail) system
├── mod.js, warn.js, strike.js, badwords.js   moderation
├── automod.js          AutoMod rules and button panel
├── antinuke.js         Anti-Nuke protection and button panel
├── verify.js           captcha verification
├── voicesystem.js      join-to-create voice rooms
├── activetime.js       staff activity tracking and daily report
├── afk.js, misc.js, quote.js                 utilities
├── YouTube.js          upload alerts
├── console.js          optional console mirroring
├── firebase.js         Firestore connection
├── lib/
│   ├── guildConfig.js  per-server settings (the only place channel/role IDs live)
│   ├── protection.js   AutoMod + Anti-Nuke settings
│   ├── prefix.js       shared command parser
│   ├── owners.js       who the bot owner is (OWNER_ID)
│   ├── noprefix.js     no-prefix user list (Firestore)
│   └── pixelVillaUI.js shared Components V2 cards
└── scripts/
    └── migrate-to-multiserver.js
```

### Adding a feature

- Read channels and roles from `lib/guildConfig.js`, never hardcode IDs.
- Parse commands with `parseCommand(message)` from `lib/prefix.js`, never match a literal prefix.
- Scope stored data by server (`{guildId}_{userId}` or similar) so servers never share records.
