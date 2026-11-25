import { DmRulesForm } from "../../DmRulesForm";
import { getDmEvents, getDmRules } from "@/lib/store";
import { summarize } from "@/lib/util";
import { Avatar, Stat, StatusBadge, ago } from "../../ui";

export default async function DmRepliesPage() {
  const [rules, events] = await Promise.all([getDmRules(), getDmEvents()]);
  const stats = summarize(events);

  const messages = events.filter((e) => e.text !== undefined).length;
  const replies = events.filter((e) => e.status === "dm_replied").length;
  const noMatch = events.filter((e) => e.status === "dm_no_match").length;
  const expired = events.filter((e) => e.status === "dm_window_expired").length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>DM auto-replies</h1>
          <p className="muted">Reply to any incoming DM automatically — greetings, prices, links, anything you set up below.</p>
        </div>
      </header>

      <section className="stat-strip">
        <Stat icon="chat" label="Messages received" value={messages} />
        <Stat icon="send" label="Auto-replies sent" value={replies} />
        <Stat icon="trend" label="No rule matched" value={noMatch} />
        <Stat icon="refresh" label="Window expired" value={expired} />
      </section>

      <section>
        <div className="panel-head">
          <h2>Reply rules</h2>
        </div>
        <DmRulesForm initial={rules} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Recent DM activity</h2>
        </div>
        {stats.rows.length === 0 ? (
          <p className="muted">
            No DMs handled yet. When someone messages you, their message shows up here with what the bot replied — or why it stayed quiet (no rule
            matched, the 24-hour window had passed, or the one-per-minute cooldown was active).
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sender</th>
                  <th>Message</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {stats.rows.map((r) => (
                  <tr key={r.igsid}>
                    <td>
                      <div className="video-cell">
                        <Avatar name={r.igsid} small />
                        <span className="item-sub">{r.igsid.slice(0, 6)}…</span>
                      </div>
                    </td>
                    <td className="clip">{r.text || "–"}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="muted">{ago(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
