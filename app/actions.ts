"use server";

import { timingSafeEqual, createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getInstagramAccount, subscribeWebhooks } from "@/lib/ig";
import { clearSession, isLoggedIn, setSession } from "@/lib/session";
import { deleteRule, getRule, setAccount, setDmRules, setRule } from "@/lib/store";
import type { DmRule } from "@/lib/util";

// Instagram rejects DM text over 1000 characters.
const text = (f: FormData, key: string, max = 1000) => String(f.get(key) ?? "").trim().slice(0, max);
const hash = (s: string) => createHash("sha256").update(s).digest();

export type FormState = { ok?: boolean; error?: string; at?: number };

export async function login(_prev: FormState, f: FormData): Promise<FormState> {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return { error: "DASHBOARD_PASSWORD is not set on the server" };
  // Hash both sides so the comparison is constant-time regardless of length.
  if (!timingSafeEqual(hash(String(f.get("password") ?? "")), hash(expected))) return { error: "Wrong password" };
  await setSession();
  redirect("/");
}

/** Reads the IG account behind IG_ACCESS_TOKEN and subscribes it to webhooks. Safe to run again after changing the token. */
export async function connect(): Promise<FormState> {
  if (!(await isLoggedIn())) return { error: "Session expired, log in again" };
  try {
    const account = await getInstagramAccount();
    await subscribeWebhooks();
    await setAccount(account);
  } catch (e) {
    console.error("Connect failed:", e);
    return { error: e instanceof Error ? e.message : "Could not reach Instagram" };
  }
  revalidatePath("/", "layout");
  return { ok: true, at: Date.now() };
}

export async function saveRule(_prev: FormState, f: FormData): Promise<FormState> {
  if (!(await isLoggedIn())) return { error: "Session expired, log in again" };

  const mediaId = text(f, "mediaId", 64);
  if (!/^\d+$/.test(mediaId)) return { error: "Invalid video" };

  const rule = {
    enabled: f.get("enabled") === "on",
    keywords: text(f, "keywords", 200),
    replyText: text(f, "replyText"),
    linkMessage: text(f, "linkMessage"),
    followGate: f.get("followGate") === "on",
    followText: text(f, "followText"),
    publicReply: text(f, "publicReply", 2000),
    commentReplies: text(f, "commentReplies", 2000),
  };
  if (rule.enabled && (!rule.replyText || !rule.linkMessage)) return { error: "Fill in the reply and the link message" };
  if (rule.enabled && rule.followGate && !rule.followText) return { error: "Fill in the follow-first message" };

  await setRule(mediaId, rule);
  // React resets <form action> fields after submit; re-rendering with the saved rule makes the reset show the new values.
  revalidatePath("/", "layout");
  return { ok: true, at: Date.now() };
}

/** Plus: save the DM auto-reply rules. The editor posts them as one JSON array. */
export async function saveDmRules(_prev: FormState, f: FormData): Promise<FormState> {
  if (!(await isLoggedIn())) return { error: "Session expired, log in again" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(f.get("rulesJson") ?? "[]"));
  } catch {
    return { error: "Rules could not be read, nothing was saved" };
  }
  if (!Array.isArray(parsed) || parsed.length > 20) return { error: "Up to 20 DM rules allowed" };

  const rules: DmRule[] = [];
  for (const r of parsed) {
    if (typeof r !== "object" || r === null) return { error: "One rule is not valid" };
    const id = String((r as { id?: unknown }).id ?? "").trim().slice(0, 64);
    const keywords = String((r as { keywords?: unknown }).keywords ?? "").trim().slice(0, 200);
    const reply = String((r as { reply?: unknown }).reply ?? "").trim().slice(0, 1000);
    if (!id || !reply) return { error: "Every rule needs a reply" };
    rules.push({ id, enabled: (r as { enabled?: unknown }).enabled !== false, keywords, reply });
  }
  if (rules.length === 0) return { error: "Add at least one rule" };
  const ids = new Set(rules.map((r) => r.id));
  if (ids.size !== rules.length) return { error: "Rule ids must be unique" };

  await setDmRules(rules);
  revalidatePath("/", "layout");
  return { ok: true, at: Date.now() };
}

export async function toggleAutomation(mediaId: string) {  if (!(await isLoggedIn()) || !/^\d+$/.test(mediaId)) return;
  const rule = await getRule(mediaId);
  // An automation without a link can't be switched on; the editor explains what's missing.
  if (!rule || (!rule.enabled && !rule.linkMessage)) return;
  await setRule(mediaId, { ...rule, enabled: !rule.enabled });
  revalidatePath("/", "layout");
}

export async function removeAutomation(mediaId: string) {
  if (!(await isLoggedIn()) || !/^\d+$/.test(mediaId)) return;
  await deleteRule(mediaId);
  revalidatePath("/", "layout");
  redirect("/automations");
}

export async function logout() {
  await clearSession();
  redirect("/login");
}
