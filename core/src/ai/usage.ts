// Sate core — AI usage tracking + per-provider limit enforcement, over the DataStore port (instance
// scope). Ported from PocketBase pb_hooks/ailimits.js (app → DataStore). Period = UTC calendar month.
// recordUsage is best-effort (never throws); checkLimit DOES throw when a cap is met (enforcement).

import type { DataStore } from "../ports";

interface UsageRow {
  id: string;
  provider: string;
  model: string;
  day: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}
interface LimitRow {
  id: string;
  provider: string;
  monthly_tokens?: number;
  usd_budget?: number;
  in_cap?: number;
  out_cap?: number;
}
interface PriceRow {
  id: string;
  provider: string;
  model: string;
  in_usd: number;
  out_usd: number;
}

const pad2 = (n: number): string => (n < 10 ? "0" + n : "" + n);
const todayStr = (): string => new Date().toISOString().slice(0, 10);

function monthBounds(): { start: string; end: string } {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const start = y + "-" + pad2(m + 1) + "-01";
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  return { start, end: ny + "-" + pad2(nm + 1) + "-01" };
}

export async function recordUsage(store: DataStore, provider: string, model: string, input: number, output: number): Promise<void> {
  try {
    if (!provider) return;
    model = model || "";
    const day = todayStr();
    const { items } = await store.list<UsageRow>("ai_usage", {
      where: [
        { field: "provider", op: "==", value: provider },
        { field: "model", op: "==", value: model },
        { field: "day", op: "==", value: day },
      ],
      limit: 1,
    });
    const row = items[0];
    if (row) {
      await store.update<UsageRow>("ai_usage", row.id, {
        calls: (row.calls || 0) + 1,
        input_tokens: (row.input_tokens || 0) + (input || 0),
        output_tokens: (row.output_tokens || 0) + (output || 0),
      });
    } else {
      await store.create<UsageRow>("ai_usage", {
        provider,
        model,
        day,
        calls: 1,
        input_tokens: input || 0,
        output_tokens: output || 0,
      });
    }
  } catch {
    /* accounting is best-effort — never break the AI call */
  }
}

async function monthRows(store: DataStore, provider: string): Promise<UsageRow[]> {
  const b = monthBounds();
  try {
    const { items } = await store.list<UsageRow>("ai_usage", {
      where: [
        { field: "provider", op: "==", value: provider },
        { field: "day", op: ">=", value: b.start },
        { field: "day", op: "<", value: b.end },
      ],
      limit: 2000,
    });
    return items;
  } catch {
    return [];
  }
}

function ioOfRows(rows: UsageRow[]): { input: number; output: number; tokens: number; calls: number } {
  let input = 0;
  let output = 0;
  let calls = 0;
  for (const r of rows) {
    input += r.input_tokens || 0;
    output += r.output_tokens || 0;
    calls += r.calls || 0;
  }
  return { input, output, tokens: input + output, calls };
}

export async function monthIO(store: DataStore, provider: string) {
  return ioOfRows(await monthRows(store, provider));
}

async function priceMap(store: DataStore): Promise<Record<string, { in_usd: number; out_usd: number }>> {
  const m: Record<string, { in_usd: number; out_usd: number }> = {};
  try {
    const { items } = await store.list<PriceRow>("ai_prices", { limit: 1000 });
    for (const r of items) m[r.provider + "|" + r.model] = { in_usd: r.in_usd, out_usd: r.out_usd };
  } catch {
    /* no prices ⇒ $ caps simply not enforced */
  }
  return m;
}

function costOfRows(rows: UsageRow[], provider: string, pm: Record<string, { in_usd: number; out_usd: number }>): number {
  let usd = 0;
  for (const r of rows) {
    const p = pm[provider + "|" + (r.model || "")];
    if (p) usd += (r.input_tokens / 1e6) * p.in_usd + (r.output_tokens / 1e6) * p.out_usd;
  }
  return usd;
}

async function limitFor(store: DataStore, provider: string): Promise<LimitRow | null> {
  try {
    const { items } = await store.list<LimitRow>("ai_limits", { where: [{ field: "provider", op: "==", value: provider }], limit: 1 });
    return items[0] ?? null;
  } catch {
    return null;
  }
}

// Enforce this provider's caps BEFORE a call. Throws a clear Error when a cap is already met.
export async function checkLimit(store: DataStore, provider: string, _model: string): Promise<void> {
  const lim = await limitFor(store, provider);
  if (!lim) return;
  const rows = await monthRows(store, provider);
  const io = ioOfRows(rows);
  if ((lim.monthly_tokens || 0) > 0 && io.tokens >= lim.monthly_tokens!)
    throw new Error(`${provider} monthly token limit reached (${io.tokens}/${lim.monthly_tokens}) — raise it in Admin › AI › Limits.`);
  if ((lim.in_cap || 0) > 0 && io.input >= lim.in_cap!)
    throw new Error(`${provider} monthly input-token limit reached — raise it in Admin › AI › Limits.`);
  if ((lim.out_cap || 0) > 0 && io.output >= lim.out_cap!)
    throw new Error(`${provider} monthly output-token limit reached — raise it in Admin › AI › Limits.`);
  if ((lim.usd_budget || 0) > 0) {
    const spent = costOfRows(rows, provider, await priceMap(store));
    if (spent >= lim.usd_budget!)
      throw new Error(`${provider} monthly budget reached ($${spent.toFixed(2)}/$${lim.usd_budget!.toFixed(2)}) — raise it in Admin › AI › Limits.`);
  }
}
