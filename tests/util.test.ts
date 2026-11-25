import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { change, daily, firstDm, hourBucket, matchCommentReply, matchDmRule, matchesKeyword, parseCommentRules, pickLine, summarize, readSigned, signValue, verifySignature, withinWindow } from "../lib/util.ts";

test("keywords", () => {
  assert.ok(matchesKeyword("anything", ""));
  assert.ok(matchesKeyword("Send me the LINK please", "link, repo"));
  assert.ok(matchesKeyword("repo!", "link, repo"));
  assert.ok(!matchesKeyword("linkedin", "link"));
  assert.ok(matchesKeyword("please send code now", "send code"));
  assert.ok(!matchesKeyword("nice video", "link"));
});

test("webhook signature", () => {
  const body = '{"object":"instagram"}';
  const sig = "sha256=" + createHmac("sha256", "s2").update(body).digest("hex");
  assert.ok(verifySignature(body, sig, [undefined, "s1", "s2"]));
  assert.ok(!verifySignature(body + " ", sig, ["s2"]));
  assert.ok(!verifySignature(body, null, ["s2"]));
  assert.ok(!verifySignature(body, sig, [undefined]));
});

test("signed session", () => {
  const v = signValue("12345", "secret");
  assert.equal(readSigned(v, "secret"), "12345");
  assert.equal(readSigned(v, "other"), null);
  assert.equal(readSigned("12345.deadbeef", "secret"), null);
  assert.equal(readSigned(undefined, "secret"), null);
});

test("first DM", () => {
  const rule = { replyText: "Hey {username}!", linkMessage: "https://x.dev", followGate: false };
  assert.deepEqual(firstDm(rule, "sam"), { text: "Hey sam!\n\nhttps://x.dev", withButton: false });
  assert.deepEqual(firstDm({ ...rule, followGate: true }, "sam"), { text: "Hey sam!", withButton: true });
  assert.equal(firstDm({ ...rule, replyText: "" }, "sam").text, "https://x.dev");
});

test("summarize", () => {
  const s = summarize([
    { at: 1, igsid: "a", username: "amy", text: "link pls", status: "button_sent" },
    { at: 2, igsid: "a", status: "follow_asked" },
    { at: 3, igsid: "a", status: "link_sent" },
    { at: 4, igsid: "b", username: "bob", text: "nice", status: "no_match" },
    { at: 5, igsid: "a", username: "amy", text: "thanks", status: "no_match" },
  ]);
  assert.equal(s.comments, 3);
  assert.equal(s.dmsSent, 3);
  assert.equal(s.linksDelivered, 1);
  assert.deepEqual(s.rows.map((r) => [r.username, r.status, r.text]), [["amy", "link_sent", "thanks"], ["bob", "no_match", "nice"]]);
});

test("daily + change", () => {
  const DAY = 86_400_000;
  const now = 10 * DAY + 5;
  const d = daily(
    [
      { at: 10 * DAY + 1, igsid: "a", text: "x", status: "link_sent" },
      { at: 9 * DAY, igsid: "b", status: "follow_asked" },
      { at: 1 * DAY, igsid: "c", text: "old", status: "no_match" },
    ],
    3,
    now,
  );
  assert.deepEqual(d.map((x) => [x.comments, x.dms]), [[0, 0], [0, 1], [1, 1]]);
  assert.equal(change(15, 10), 50);
  assert.equal(change(5, 0), null);
});

test("pickLine", () => {
  assert.equal(pickLine("a\n\n b \nc", () => 0.5), "b");
  assert.equal(pickLine("  \n", () => 0), null);
});

// --- Plus: DM auto-reply rules ---------------------------------------------------

test("matchDmRule: specific keyword beats the catch-all", () => {
  const rules = [
    { id: "default", enabled: true, keywords: "", reply: "hello!" },
    { id: "price", enabled: true, keywords: "price, cost", reply: "₹499" },
    { id: "off", enabled: false, keywords: "link", reply: "never" },
  ];
  assert.equal(matchDmRule(rules, "what is the price?")?.id, "price");
  assert.equal(matchDmRule(rules, "hi there")?.id, "default");
  assert.equal(matchDmRule(rules, "send link")?.id, "default"); // disabled rule never wins
  assert.equal(matchDmRule([{ id: "x", enabled: true, keywords: "price", reply: "₹499" }], "hello"), null);
  assert.equal(matchDmRule([{ id: "x", enabled: true, keywords: "price", reply: "   " }], "price?"), null); // empty reply ignored
});

test("withinWindow: Meta's 24-hour reply window", () => {
  const now = 100_000_000_000;
  const HOUR = 3_600_000;
  assert.ok(withinWindow(now - 23 * HOUR, now));
  assert.ok(!withinWindow(now - 25 * HOUR, now));
  assert.ok(withinWindow(now - 24 * HOUR, now)); // exactly at the edge still counts
  assert.ok(withinWindow(undefined, now));
  assert.ok(withinWindow(now + 30_000, now)); // small clock skew is tolerated
});

test("hourBucket", () => {
  assert.equal(hourBucket(3_600_000), 1);
  assert.equal(hourBucket(3_600_000 + 5), 1);
  assert.equal(hourBucket(7_200_000), 2);
});

// --- Plus: comment auto-reply rules ----------------------------------------------

test("parseCommentRules", () => {
  assert.deepEqual(parseCommentRules("price, cost => ₹499\n\nno arrow here\nhi => Hello!\nempty =>   "), [
    { keywords: "price, cost", reply: "₹499" },
    { keywords: "hi", reply: "Hello!" },
  ]);
  assert.deepEqual(parseCommentRules(""), []);
});

test("matchCommentReply", () => {
  const rules = "price => ₹499\nprice => Starting at ₹499!\nhi, hello => Hey there 🙌";
  assert.equal(matchCommentReply(rules, "what is the price?", () => 0), "₹499");
  assert.equal(matchCommentReply(rules, "what is the price?", () => 0.99), "Starting at ₹499!");
  assert.equal(matchCommentReply(rules, "hello!", () => 0), "Hey there 🙌");
  assert.equal(matchCommentReply(rules, "nice video", () => 0), null);
  assert.equal(matchCommentReply("", "price?", () => 0), null);
});

test("summarize counts the new Plus statuses", () => {
  const s = summarize([
    { at: 1, igsid: "a", text: "hi", status: "dm_replied" },
    { at: 2, igsid: "b", text: "price?", status: "dm_no_match" },
    { at: 3, igsid: "c", text: "nice", status: "comment_replied" },
    // A secondary event without text (e.g. comment reply after a DM) must not inflate the comment count.
    { at: 4, igsid: "c", status: "comment_replied" },
  ]);
  assert.equal(s.comments, 3);
  assert.equal(s.dmsSent, 1);
  assert.deepEqual(s.rows.map((r) => r.status), ["comment_replied", "dm_no_match", "dm_replied"]);
});
