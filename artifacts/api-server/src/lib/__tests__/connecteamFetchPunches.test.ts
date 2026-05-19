import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchPunchesForWeek,
  type ConnecteamTimeClock,
} from "../connecteam.js";

function makeClock(
  id: number,
  name: string,
  isArchived = false,
): ConnecteamTimeClock {
  return { id, name, isArchived };
}

function makeShift(startEpochSec: number, endEpochSec: number) {
  return {
    start: { timestamp: startEpochSec },
    end: { timestamp: endEpochSec },
  };
}

const startIso = "2026-01-04";
const endIso = "2026-01-10";
const day = "2026-01-05T13:00:00Z";
const epoch = Math.floor(new Date(day).getTime() / 1000);

test("fetchPunchesForWeek: dynamic clocks, alias merging, per-clock counts", async () => {
  const clocks = [makeClock(100, "Main"), makeClock(200, "Shuster")];
  const activitiesByClock: Record<number, unknown> = {
    100: {
      data: {
        timeActivitiesByUsers: [
          { userId: 11, shifts: [makeShift(epoch, epoch + 3600)] },
          { userId: 99, shifts: [makeShift(epoch, epoch + 7200)] }, // unresolved
        ],
      },
    },
    200: {
      data: {
        timeActivitiesByUsers: [
          { userId: 22, shifts: [makeShift(epoch, epoch + 1800)] }, // aliased -> kfi-A
        ],
      },
    },
  };

  const ctUserIdToKfi = new Map<number, string>([[11, "kfi-A"]]);
  const ctUserAliases = new Map<number, string>([[22, "kfi-A"]]);

  const result = await fetchPunchesForWeek(
    startIso,
    endIso,
    ctUserIdToKfi,
    new Map(),
    ctUserAliases,
    {
      listClocks: async () => clocks,
      fetchActivities: async (path: string) => {
        const m = path.match(/time-clocks\/(\d+)\//);
        if (!m) throw new Error(`bad path: ${path}`);
        return activitiesByClock[Number(m[1])];
      },
    },
  );

  assert.equal(result.failures.length, 0);
  assert.equal(result.perClock.length, 2);
  const perClockById = new Map(result.perClock.map((c) => [c.clockId, c]));
  assert.equal(perClockById.get(100)?.shiftCount, 1);
  assert.equal(perClockById.get(200)?.shiftCount, 1);
  // Aliased + native both attribute to kfi-A
  const kfiAPunches = result.punches.filter((p) => p.kfiId === "kfi-A");
  assert.equal(kfiAPunches.length, 2);
  // Unresolved user 99 surfaced with shift count
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].ctUserId, 99);
  assert.equal(result.unresolved[0].shiftCount, 1);
  assert.deepEqual(result.unresolved[0].clockIds, [100]);
});

test("fetchPunchesForWeek: per-clock failure is isolated", async () => {
  const clocks = [makeClock(1, "Good"), makeClock(2, "Bad")];
  const result = await fetchPunchesForWeek(
    startIso,
    endIso,
    new Map([[7, "kfi-X"]]),
    new Map(),
    new Map(),
    {
      listClocks: async () => clocks,
      fetchActivities: async (path: string) => {
        if (path.includes("/time-clocks/2/")) {
          throw new Error("upstream 503");
        }
        return {
          data: {
            timeActivitiesByUsers: [
              { userId: 7, shifts: [makeShift(epoch, epoch + 3600)] },
            ],
          },
        };
      },
    },
  );

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].clockId, 2);
  assert.match(result.failures[0].error, /503/);
  // Good clock still produced punches
  assert.equal(result.punches.length, 1);
  assert.equal(result.punches[0].kfiId, "kfi-X");
  // Both clocks still listed in perClock (Bad with shiftCount 0)
  assert.equal(result.perClock.length, 2);
  assert.equal(
    result.perClock.find((c) => c.clockId === 2)?.shiftCount,
    0,
  );
});

test("fetchPunchesForWeek: listClocks failure throws", async () => {
  await assert.rejects(
    fetchPunchesForWeek(startIso, endIso, new Map(), new Map(), new Map(), {
      listClocks: async () => {
        throw new Error("auth failed");
      },
      fetchActivities: async () => ({}),
    }),
    /Failed to list Connecteam time-clocks.*auth failed/,
  );
});
