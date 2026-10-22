# F.R.I.D.A.Y

A multi-server Discord bot for moderation, support tickets, verification, voice rooms, and staff activity tracking.

**Built with:** Node.js 22 · discord.js v14 · Firebase Firestore

## Features

- **ModMail:** Private support tickets through DMs, with server selection and ticket logs.
- **Moderation:** Warnings, strikes, timeouts, kicks, bans, message purging, channel controls, and bad-word filtering.
- **AutoMod:** Configurable protection against spam, repeated messages, mass mentions, emoji spam, invites, links, and excessive caps.
- **Anti-Nuke:** Protection against destructive server actions, with trusted-user management and configurable responses.
- **Verification:** Captcha-based verification with automatic role assignment.
- **Temporary Voice Rooms:** Automatically create personal voice channels with owner controls.
- **Active Time:** Staff activity tracking and daily reports.
- **Utilities:** AFK, quotes, avatars, user and server information, and more.
- **YouTube Alerts:** Optional upload notifications for each server.
- **Custom Prefixes:** Each server can configure its own command prefix.
- **Server-Specific Configuration:** Configure channels, roles, and features independently in every server.

## Getting Started

### 1. Configure the server

Administrators with **Manage Server** permission can use:

| Command | Purpose |
|---|---|
| `.config` | Open the configuration menu |
| `.config view` | View current settings |
| `.config set <key> <value>` | Configure a channel, role, or setting |
| `.config clear <key>` | Clear a setting |
| `.prefix <prefix>` | Change the server's command prefix |
| `.setup` | Open the setup wizard |
| `.help` | View available commands |

Replace the example prefix `.` with your server's configured prefix when necessary.

### 2. Configure key features

Examples:

- `.config set logs #mod-logs`
- `.config set staffRole @Staff`
- `.config set verifyChannel #verify`
- `.config set verifiedRole @Verified`
- `.setupverify` — post the verification panel

Use `.config` to access the available settings and configure the channels and roles your server needs.

### 3. Enable protection

- `.automod` — configure AutoMod rules and actions.
- `.antinuke` — manage Anti-Nuke protection and trusted users.

Follow the instructions in each panel to configure the features and required permissions.

## Permissions

Depending on the enabled features, F.R.I.D.A.Y may need permissions such as:

- Manage Channels and Manage Roles
- Manage Messages and Moderate Members
- Kick Members and Ban Members
- View Audit Log
- View Channels, Send Messages, and Embed Links
- Read Message History
- Connect and Move Members

Grant only the permissions required for your server's enabled features, and ensure the bot's role is positioned above the roles it needs to manage.

## Privacy and Configuration

- Each server has its own settings and command prefix.
- Server-specific configuration keeps channels, roles, and feature settings separate.
- Moderation, support, and activity features depend on the permissions and configuration provided by each server.

## Technology

F.R.I.D.A.Y uses Node.js, discord.js, and Firebase Firestore to provide its Discord features.

For setup assistance or bug reports, contact the bot's maintainer.
