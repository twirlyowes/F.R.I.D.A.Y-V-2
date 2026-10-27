"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachDashboardEvents } = require("../lib/dashboardEvents");

const GUILD_ID = "200000000000000001";
const CHANNEL_ID = "300000000000000001";

function createStore() {
  const writes = [];
  const deletes = [];
  const state = new Map();

  const store = {
    collection(name) {
      if (name === "voiceChannels") {
        return {
          doc() {
            return {
              get: async () => ({
                exists: true,
                data: () => ({ guildId: GUILD_ID })
              })
            };
          }
        };
      }

      if (name === "voice_room_state") {
        return {
          doc(guildId) {
            return {
              collection() {
                return {
                  doc(channelId) {
                    const key = guildId + ":" + channelId;
                    return {
                      set: async (data) => {
                        writes.push({ key, data });
                        state.set(key, data);
                      },
                      delete: async () => {
                        deletes.push(key);
                        state.delete(key);
                      }
                    };
                  }
                };
              }
            };
          }
        };
      }

      throw new Error("Unexpected collection in test: " + name);
    }
  };

  return { store, writes, deletes, state };
}

function setup() {
  const client = new EventEmitter();
  const { store, writes, deletes, state } = createStore();
  attachDashboardEvents(client, store);
  const channel = {
    isVoiceBased: () => true,
    members: new Map([["100000000000000001", {}], ["100000000000000002", {}]])
  };
  const guild = {
    id: GUILD_ID,
    channels: {
      cache: new Map([[CHANNEL_ID, channel]]),
      fetch: async () => channel
    }
  };
  const handler = client.listeners("voiceStateUpdate")[0];
  const update = () => handler(
    { guild, channelId: null },
    { guild, channelId: CHANNEL_ID }
  );
  return { client, channel, guild, update, writes, deletes, state };
}

test("only voice-state sync is attached; live audit-log listeners are disabled", () => {
  const { client } = setup();
  assert.deepEqual(client.eventNames(), ["voiceStateUpdate"]);
});

test("voice room state is not rewritten when its member list is unchanged", async () => {
  const { update, writes } = setup();
  await update();
  await update();
  assert.equal(writes.length, 1);
});

test("voice room state is written when membership actually changes", async () => {
  const { channel, update, writes } = setup();
  await update();
  channel.members.set("100000000000000003", {});
  await update();

  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].data.memberIds, [
    "100000000000000001",
    "100000000000000002",
    "100000000000000003"
  ]);
});
