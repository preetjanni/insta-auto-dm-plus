import { followsMe, replyToComment, sendDM, sendPrivateReply, sendPrivateText } from "./ig";
import {
  clearPending,
  commentReplyAllowed,
  DEFAULT_RULE,
  dmReplyAllowed,
  firstTime,
  getAccount,
  getDmRules,
  getPending,
  getRule,
  logDmEvent,
  logEvent,
  setPending,
  type Account,
} from "./store";
import { firstDm, matchCommentReply, matchDmRule, matchesKeyword, pickLine, withinWindow, type DmStatus } from "./util";

// Quick-reply titles are cut at 20 characters.
const linkButton = (mediaId: string) => ({ content_type: "text" as const, title: "Send me the link", payload: `GET:${mediaId}` });
const followedButton = (mediaId: string) => ({ content_type: "text" as const, title: "I followed ✅", payload: `GET:${mediaId}` });

type CommentValue = {
  id?: string;
  comment_id?: string;
  text?: string;
  from?: { id: string; username?: string };
  media?: { id: string };
};

type MessagingEvent = {
  sender: { id: string };
  timestamp?: number; // ms epoch of the incoming message (Meta sends it on every messaging event)
  message?: { mid: string; text?: string; is_echo?: boolean; quick_reply?: { payload: string } };
  postback?: { mid: string; payload: string };
};

type WebhookBody = {
  object: string;
  entry?: { id: string; changes?: { field: string; value: CommentValue }[]; messaging?: MessagingEvent[] }[];
};

/** Step 1: someone comments on a selected video -> one private-reply DM with a "Send me the link" button. */
async function onComment(account: Account, v: CommentValue) {
  const commentId = v.id ?? v.comment_id; // Meta's examples use either key depending on login type
  const mediaId = v.media?.id;
  const from = v.from?.id;
  if (!commentId || !mediaId || !from) return console.log("Comment skipped: missing ids");
  if (from === account.igId) return console.log("Comment skipped: your own comment");

  const rule = await getRule(mediaId);
  if (!rule) return console.log(`Comment skipped: no automation for media ${mediaId}`);
  if (!(await firstTime(`c:${commentId}`))) return console.log("Comment skipped: already handled");

  // One event per comment carries the text (so the dashboard counts comments once);
  // secondary outcomes are logged without text.
  const log = (status: DmStatus) =>
    logEvent(mediaId, { at: Date.now(), igsid: from, username: v.from?.username, text: v.text ?? "", status });
  const logExtra = (status: DmStatus) => logEvent(mediaId, { at: Date.now(), igsid: from, status });
  if (!rule.enabled) return log("paused");

  const text = v.text ?? "";
  let dmStatus: DmStatus | null = null;
  if (matchesKeyword(text, rule.keywords)) {
    const dm = firstDm(rule, v.from?.username ?? "there");
    try {
      if (!dm.withButton) {
        await sendPrivateText(account.igId, commentId, dm.text);
        dmStatus = "link_sent";
        console.log(`Link sent directly for comment ${commentId}`);
      } else {
        await setPending(from, mediaId);
        await sendPrivateReply(account.igId, commentId, dm.text, linkButton(mediaId));
        dmStatus = "button_sent";
        console.log(`Private reply with button sent for comment ${commentId}`);
      }
    } catch (err) {
      await log("failed");
      throw err;
    }
  }

  // Plus: public comment auto-reply. At most ONE public reply per comment, so a
  // matched comment-reply replaces the "Sent you a DM" nudge instead of adding to it.
  const commentReply = matchCommentReply(rule.commentReplies ?? "", text);
  if (commentReply) {
    if (await commentReplyAllowed(mediaId)) {
      try {
        await replyToComment(commentId, commentReply);
        console.log(`Public comment reply posted on comment ${commentId}`);
      } catch (err) {
        console.error("Comment reply failed:", err);
      }
      if (dmStatus) await logExtra("comment_replied");
      return log(dmStatus ?? "comment_replied");
    }
    console.warn(`Comment reply skipped: hourly rate limit for media ${mediaId}`);
    if (dmStatus) await logExtra("rate_limited");
    return log(dmStatus ?? "rate_limited");
  }

  // Fallback: public "check your DMs" nudge, only after the DM went out.
  if (dmStatus) {
    const reply = pickLine(rule.publicReply ?? DEFAULT_RULE.publicReply ?? "");
    if (reply) {
      try {
        await replyToComment(commentId, reply);
        console.log(`Public reply posted on comment ${commentId}`);
      } catch (err) {
        console.error("Public reply failed (DM was still sent):", err);
      }
    }
    return log(dmStatus);
  }

  return log("no_match");
}

/** Step 2: they tap a button (or type anything) -> follow check -> link or "follow first". */
async function onMessage(account: Account, e: MessagingEvent) {
  const sender = e.sender?.id;
  const mid = e.message?.mid ?? e.postback?.mid;
  if (e.message?.is_echo || sender === account.igId) return; // our own outgoing messages
  if (!sender || !mid) return console.log("Message skipped: missing sender or message id");
  if (!(await firstTime(`m:${mid}`))) return console.log("Message skipped: already handled");

  const payload = e.message?.quick_reply?.payload ?? e.postback?.payload ?? "";
  const mediaId = payload.startsWith("GET:") ? payload.slice(4) : await getPending(sender);
  if (!mediaId) return onDmAutoReply(account, e); // Plus: not part of a link flow -> DM auto-reply rules.

  const rule = await getRule(mediaId);
  if (!rule) return console.log(`Message skipped: no rule for media ${mediaId}`);

  if (rule.followGate) {
    let follows = true;
    try {
      follows = await followsMe(sender);
    } catch (err) {
      // Fail open: a broken lookup should not trap people in a "follow first" loop.
      console.error("Follow check failed, sending link anyway:", err);
    }
    if (!follows) {
      await sendDM(account.igId, sender, rule.followText, [followedButton(mediaId)]);
      await logEvent(mediaId, { at: Date.now(), igsid: sender, status: "follow_asked" });
      return console.log("Sent follow-first message");
    }
  }

  await sendDM(account.igId, sender, rule.linkMessage);
  await clearPending(sender);
  await logEvent(mediaId, { at: Date.now(), igsid: sender, status: "link_sent" });
  console.log("Sent link message");
}

/**
 * Plus: DM auto-reply for ANY incoming DM that isn't part of a link flow —
 * a greeting, a question, a keyword. Only replies inside Meta's 24-hour
 * window, one reply per message, with a per-sender cooldown against floods.
 */
async function onDmAutoReply(account: Account, e: MessagingEvent) {
  const sender = e.sender?.id;
  const text = e.message?.text ?? "";
  if (!sender || !text.trim()) return console.log("DM auto-reply skipped: no text");

  const logDm = (status: DmStatus) => logDmEvent({ at: Date.now(), igsid: sender, text, status });
  const matched = matchDmRule(await getDmRules(), text);
  if (!matched) return logDm("dm_no_match");
  if (!withinWindow(e.timestamp)) return logDm("dm_window_expired");
  if (!(await dmReplyAllowed(sender))) return logDm("dm_cooldown");

  try {
    await sendDM(account.igId, sender, matched.reply.trim().slice(0, 1000));
  } catch (err) {
    await logDm("failed");
    throw err;
  }
  await logDm("dm_replied");
  console.log(`DM auto-reply sent to ${sender} (rule ${matched.id})`);
}

export async function handleWebhook(body: WebhookBody) {
  if (body.object !== "instagram") return;
  const account = await getAccount();
  if (!account || !process.env.IG_ACCESS_TOKEN) return console.warn("Webhook ignored: Instagram not connected");

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      console.log(`Event: ${change.field}`);
      if (change.field !== "comments") continue;
      try {
        await onComment(account, change.value);
      } catch (err) {
        console.error("Comment handling failed:", err);
      }
    }
    for (const event of entry.messaging ?? []) {
      console.log(`Event: ${event.postback ? "postback" : event.message?.quick_reply ? "quick reply" : event.message?.is_echo ? "echo" : "message"}`);
      try {
        await onMessage(account, event);
      } catch (err) {
        console.error("Message handling failed:", err);
      }
    }
  }
}
