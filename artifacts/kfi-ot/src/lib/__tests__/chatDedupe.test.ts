import test from "node:test";
import assert from "node:assert/strict";
import { dedupeChatMessages } from "../chatDedupe.ts";
import type { CustomerUploadChatMessage } from "@workspace/api-client-react";

function msg(
  partial: Partial<CustomerUploadChatMessage> &
    Pick<CustomerUploadChatMessage, "id" | "role" | "content" | "createdAt">,
): CustomerUploadChatMessage {
  return {
    chatId: 1,
    proposedFix: null,
    proposedLesson: null,
    fileEvidence: null,
    appliedAt: null,
    appliedByEmail: null,
    dismissedAt: null,
    dismissedByEmail: null,
    authorEmail: null,
    ...partial,
  };
}

test("dedupe collapses optimistic (negative id) + server pair to the persisted row", () => {
  const t0 = "2031-05-04T12:00:00.000Z";
  const t1 = "2031-05-04T12:00:01.000Z";
  const out = dedupeChatMessages([
    msg({ id: -1234, role: "user", content: "Hi Claude", createdAt: t0 }),
    msg({ id: 42, role: "user", content: "Hi Claude", createdAt: t1 }),
    msg({ id: 43, role: "assistant", content: "Hello", createdAt: t1 }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 42);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].id, 43);
});

test("dedupe pairs even when the server row appears before the optimistic one", () => {
  const t0 = "2031-05-04T12:00:00.000Z";
  const t1 = "2031-05-04T12:00:01.000Z";
  const out = dedupeChatMessages([
    msg({ id: 42, role: "user", content: "Hi", createdAt: t0 }),
    msg({ id: -1234, role: "user", content: "Hi", createdAt: t1 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 42);
});

test("dedupe leaves distinct content alone", () => {
  const t0 = "2031-05-04T12:00:00.000Z";
  const out = dedupeChatMessages([
    msg({ id: -1, role: "user", content: "A", createdAt: t0 }),
    msg({ id: 2, role: "user", content: "B", createdAt: t0 }),
  ]);
  assert.equal(out.length, 2);
});

test("dedupe ignores duplicates outside the 60s window", () => {
  const t0 = "2031-05-04T12:00:00.000Z";
  const t1 = "2031-05-04T12:05:00.000Z"; // 5 min later
  const out = dedupeChatMessages([
    msg({ id: -1, role: "user", content: "ping", createdAt: t0 }),
    msg({ id: 2, role: "user", content: "ping", createdAt: t1 }),
  ]);
  assert.equal(out.length, 2);
});

test("dedupe leaves two persisted user rows with same content alone (legit repeat)", () => {
  const t0 = "2031-05-04T12:00:00.000Z";
  const t1 = "2031-05-04T12:00:05.000Z";
  const out = dedupeChatMessages([
    msg({ id: 10, role: "user", content: "ok", createdAt: t0 }),
    msg({ id: 11, role: "user", content: "ok", createdAt: t1 }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 10);
  assert.equal(out[1].id, 11);
});

test("dedupe leaves two persisted assistant rows with same content alone", () => {
  const t0 = "2031-05-04T12:00:00.000Z";
  const t1 = "2031-05-04T12:00:02.000Z";
  const out = dedupeChatMessages([
    msg({ id: 10, role: "assistant", content: "Got it.", createdAt: t0 }),
    msg({ id: 11, role: "assistant", content: "Got it.", createdAt: t1 }),
  ]);
  assert.equal(out.length, 2);
});

test("dedupe keeps unmatched optimistic row visible (server echo not yet present)", () => {
  const t0 = "2031-05-04T12:00:00.000Z";
  const out = dedupeChatMessages([
    msg({ id: 5, role: "assistant", content: "earlier", createdAt: t0 }),
    msg({ id: -99, role: "user", content: "in flight", createdAt: t0 }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].id, -99);
});

test("dedupe does not collide across different authors with same content", () => {
  const t0 = "2031-05-04T12:00:00.000Z";
  const t1 = "2031-05-04T12:00:01.000Z";
  const out = dedupeChatMessages([
    msg({
      id: -1,
      role: "user",
      content: "Hi",
      createdAt: t0,
      authorEmail: "alice@kfi.local",
    }),
    msg({
      id: 50,
      role: "user",
      content: "Hi",
      createdAt: t1,
      authorEmail: "bob@kfi.local",
    }),
  ]);
  // Different authors → pair must NOT collapse. Both rows stay.
  assert.equal(out.length, 2);
});

test("dedupe pairs nearest persisted row when several share content", () => {
  // Two persisted "ping" rows already exist (legit repeat). A new
  // optimistic row should pair with the *nearest* one, leaving the
  // other persisted row untouched.
  const out = dedupeChatMessages([
    msg({ id: 10, role: "user", content: "ping", createdAt: "2031-05-04T12:00:00.000Z" }),
    msg({ id: 11, role: "user", content: "ping", createdAt: "2031-05-04T12:00:30.000Z" }),
    msg({ id: -99, role: "user", content: "ping", createdAt: "2031-05-04T12:00:31.000Z" }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 10);
  assert.equal(out[1].id, 11);
});

test("dedupe pairs each optimistic row with a distinct persisted row", () => {
  // Two in-flight optimistic rows + two persisted echoes — each
  // optimistic should consume a different persisted row.
  const out = dedupeChatMessages([
    msg({ id: -1, role: "user", content: "a", createdAt: "2031-05-04T12:00:00.000Z" }),
    msg({ id: -2, role: "user", content: "a", createdAt: "2031-05-04T12:00:02.000Z" }),
    msg({ id: 50, role: "user", content: "a", createdAt: "2031-05-04T12:00:00.500Z" }),
    msg({ id: 51, role: "user", content: "a", createdAt: "2031-05-04T12:00:02.500Z" }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 50);
  assert.equal(out[1].id, 51);
});
