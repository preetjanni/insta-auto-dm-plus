"use client";

import { useActionState, useState } from "react";
import { saveDmRules, type FormState } from "./actions";
import type { DmRule } from "@/lib/util";

function newRule(): DmRule {
  return { id: `rule-${crypto.randomUUID().slice(0, 8)}`, enabled: true, keywords: "", reply: "" };
}

/** Keyword -> reply rules for ANY incoming DM. First keyword match wins; the empty-keyword rule is the catch-all greeting. */
export function DmRulesForm({ initial }: { initial: DmRule[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveDmRules, {});
  const [rules, setRules] = useState<DmRule[]>(initial);
  const set = (id: string, patch: Partial<DmRule>) => setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <form action={action} className="panel">
      <input type="hidden" name="rulesJson" value={JSON.stringify(rules)} />

      <p className="muted" style={{ marginTop: 0 }}>
        Anyone who DMs you gets an automatic reply — not just people who tapped a button. Rules are checked top to bottom: the first rule whose
        keywords match the message wins. A rule with empty keywords is the catch-all greeting. Instagram only lets the bot reply within 24 hours of
        the incoming message, and at most one auto-reply goes out per person per minute.
      </p>

      {rules.map((rule, i) => (
        <div key={rule.id} className="panel flat" style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Rule {i + 1}</strong>
            <span className="row">
              <label className="toggle" style={{ margin: 0 }}>
                <input type="checkbox" checked={rule.enabled} onChange={(e) => set(rule.id, { enabled: e.target.checked })} />
                Enabled
              </label>
              <button type="button" className="button danger small" disabled={rules.length <= 1} onClick={() => setRules((rs) => rs.filter((r) => r.id !== rule.id))}>
                Delete
              </button>
            </span>
          </div>
          <label>
            Trigger keywords <span className="hint">Comma-separated. Leave empty for the catch-all greeting.</span>
            <input value={rule.keywords} onChange={(e) => set(rule.id, { keywords: e.target.value })} placeholder="price, cost, kitne ka" />
          </label>
          <label>
            Reply <span className="hint">Sent as a DM. Max 1000 characters.</span>
            <textarea rows={2} value={rule.reply} onChange={(e) => set(rule.id, { reply: e.target.value })} placeholder="Hey! Thanks for messaging…" />
          </label>
        </div>
      ))}

      <div className="row">
        <button type="button" className="button ghost" onClick={() => setRules((rs) => [...rs, newRule()])} disabled={rules.length >= 20}>
          + Add rule
        </button>
        <button type="submit" className="button primary" disabled={pending}>
          {pending ? "Saving…" : "Save DM rules"}
        </button>
        <span role="status" className={state.error ? "err" : "ok"}>
          {state.error ?? (state.ok ? "Saved ✓" : "")}
        </span>
      </div>
    </form>
  );
}
