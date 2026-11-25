// Pure helpers (no imports from the app) so they can be unit-tested with plain `node --test`.
import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Meta signs webhook bodies: X-Hub-Signature-256: sha256=<hmac of raw body>. Any listed secret may match. */
export function verifySignature(rawBody: string, header: string | null, secrets: (string | undefined)[]) {
  if (!header?.startsWith("sha256=")) return false;
  return secrets.some(
    (s) => !!s && safeEqual(header, "sha256=" + createHmac("sha256", s).update(rawBody).digest("hex")),
  );
}

/** Empty keyword list = every comment matches. Otherwise any comma-separated keyword as a whole word, case-insensitive. */
export function matchesKeyword(text: string, keywords: string) {
  const list = keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  const words = text.toLowerCase().split(/[^\p{L}\p{N}_]+/u);
  return list.some((k) => (k.includes(" ") ? text.toLowerCase().includes(k) : words.includes(k)));
}

/**
 * The one DM Instagram lets us send in reply to a comment.
 * Without the follow gate it carries the link itself, so no reply/webhook round-trip is needed.
 */
export function firstDm(
  rule: { replyText: string; linkMessage: string; followGate: boolean },
  username: string,
) {
  const greeting = rule.replyText.replaceAll("{username}", username).trim();
  if (rule.followGate) return { text: greeting, withButton: true };
  return { text: [greeting, rule.linkMessage.trim()].filter(Boolean).join("\n\n").slice(0, 1000), withButton: false };
}

/** What happened to one commenter on one automated video. Comment events carry `text`. */
export type DmStatus =
  | "paused"
  | "no_match"
  | "failed"
  | "button_sent"
  | "follow_asked"
  | "link_sent"
  // Plus: public comment auto-replies and DM auto-replies.
  | "comment_replied"
  | "rate_limited"
  | "dm_replied"
  | "dm_no_match"
  | "dm_window_expired"
  | "dm_cooldown";
export type DmEvent = { at: number; igsid: string; username?: string; text?: string; status: DmStatus };
export type Person = { igsid: string; username?: string; text?: string; at: number; status: DmStatus };

// Later in this list = further along; a person's row shows the furthest status they reached.
const RANK: DmStatus[] = [
  "paused",
  "no_match",
  "comment_replied",
  "failed",
  "rate_limited",
  "button_sent",
  "follow_asked",
  "link_sent",
  "dm_no_match",
  "dm_window_expired",
  "dm_cooldown",
  "dm_replied",
];
const DM_SENT: DmStatus[] = ["button_sent", "follow_asked", "link_sent", "dm_replied"];

/** Per-video analytics: one row per commenter plus totals. */
export function summarize(events: DmEvent[]) {
  const people = new Map<string, Person>();
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const p = people.get(e.igsid) ?? { igsid: e.igsid, at: e.at, status: e.status };
    if (e.username) p.username = e.username;
    if (e.text !== undefined) p.text = e.text;
    if (RANK.indexOf(e.status) >= RANK.indexOf(p.status)) p.status = e.status;
    p.at = e.at;
    people.set(e.igsid, p);
  }
  const rows = [...people.values()].sort((a, b) => b.at - a.at);
  return {
    rows,
    comments: events.filter((e) => e.text !== undefined).length,
    dmsSent: events.filter((e) => DM_SENT.includes(e.status)).length,
    linksDelivered: rows.filter((r) => r.status === "link_sent").length,
  };
}

const DAY = 86_400_000;

/**
 * Comments and DMs per day for the last `days` days, oldest first.
 * shortcut: days are cut at server midnight (UTC on Vercel); pass a timezone through if the chart looks a day off.
 */
export function daily(events: DmEvent[], days: number, now = Date.now()) {
  const start = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const out = Array.from({ length: days }, (_, i) => ({ day: start + i * DAY, comments: 0, dms: 0 }));
  for (const e of events) {
    const slot = out[Math.floor((e.at - start) / DAY)];
    if (!slot) continue;
    if (e.text !== undefined) slot.comments++;
    if (DM_SENT.includes(e.status)) slot.dms++;
  }
  return out;
}

/** Percent change from `before` to `after`; null when there is nothing to compare against. */
export const change = (after: number, before: number) => (before ? Math.round(((after - before) / before) * 100) : null);

/** One random non-empty line, so public replies aren't identical on every comment. */
export function pickLine(text: string, rand = Math.random) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[Math.floor(rand() * lines.length)] : null;
}

/** Signed session value: "<igId>.<hmac>". */
export function signValue(value: string, secret: string) {
  return value + "." + createHmac("sha256", secret).update(value).digest("hex");
}

export function readSigned(signed: string | undefined, secret: string) {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i < 1) return null;
  const value = signed.slice(0, i);
  return safeEqual(signed, signValue(value, secret)) ? value : null;
}

// --- DM auto-reply rules (Plus) -------------------------------------------------

/** One DM auto-reply rule: an incoming DM matching `keywords` gets `reply`. Empty keywords = catch-all. */
export type DmRule = { id: string; enabled: boolean; keywords: string; reply: string };

/**
 * First matching enabled rule wins. Rules with keywords are tried before the
 * catch-all (empty keywords), so a specific reply always beats the greeting.
 */
export function matchDmRule(rules: DmRule[], text: string): DmRule | null {
  const enabled = rules.filter((r) => r.enabled && r.reply.trim());
  const specific = enabled.filter((r) => r.keywords.trim());
  for (const rule of specific) if (matchesKeyword(text, rule.keywords)) return rule;
  return enabled.find((r) => !r.keywords.trim()) ?? null;
}

/** Meta only lets us reply to a DM within 24 hours of the incoming message. */
export const DM_WINDOW_MS = 24 * 60 * 60 * 1000;

export function withinWindow(timestamp: number | undefined, now = Date.now()) {
  if (timestamp === undefined) return true; // Meta always sends one; never block on a missing value.
  return timestamp <= now + 60_000 && now - timestamp <= DM_WINDOW_MS;
}

// --- Comment auto-reply rules (Plus) --------------------------------------------

/** One public comment-reply rule, written as `keyword1, keyword2 => reply text`. */
export type CommentReplyRule = { keywords: string; reply: string };

/** Parse the per-automation comment-replies textarea: one `keywords => reply` rule per line. */
export function parseCommentRules(text: string): CommentReplyRule[] {
  const out: CommentReplyRule[] = [];
  for (const line of text.split("\n")) {
    const i = line.indexOf("=>");
    if (i < 0) continue;
    const keywords = line.slice(0, i).trim();
    const reply = line.slice(i + 2).trim();
    if (!reply) continue;
    out.push({ keywords, reply });
  }
  return out;
}

/**
 * All replies whose rule matches the comment, one picked at random — so the
 * same keyword doesn't get an identical public reply every time.
 */
export function matchCommentReply(rulesText: string, text: string, rand = Math.random): string | null {
  const replies = parseCommentRules(rulesText)
    .filter((r) => matchesKeyword(text, r.keywords))
    .map((r) => r.reply);
  if (replies.length === 0) return null;
  return pickLine(replies.join("\n"), rand);
}

/** Hour bucket (UTC) for the per-reel public-reply rate limit. */
export const hourBucket = (at: number) => Math.floor(at / 3_600_000);
