#!/usr/bin/env node
/**
 * OpenSearch MCP Server — Kibana/OpenSearch Dashboards Proxy mode
 *
 * Authenticates via browser session cookie (SAML/SSO environments).
 * Requests go through the OpenSearch Dashboards console proxy at:
 *   <DASHBOARD_URL>/api/console/proxy?path=<path>&method=<METHOD>
 *
 * Required env vars:
 *   OPENSEARCH_DASHBOARD_URL  – base URL of the dashboard (no trailing slash)
 *   OPENSEARCH_COOKIE         – full Cookie header value copied from the browser
 *
 * Optional:
 *   OPENSEARCH_DEFAULT_INDEX  – default index pattern (default: logs-json-*)
 *
 * ── Field naming (SAP Commerce Cloud / CLS) ───────────────────────────────────
 *   Log text  → logs.message       (NOT "message")
 *   Pod name  → kubernetes.pod_name (NOT kubernetes.pod.name)
 *   Timestamp → @timestamp         (UTC — BRT = UTC-3, e.g. 21:15 BRT = 00:15 UTC next day)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ────────────────────────────────────────────────────────────────────

const DASHBOARD_URL = (process.env.OPENSEARCH_DASHBOARD_URL || "").replace(/\/$/, "");
const COOKIE = process.env.OPENSEARCH_COOKIE || "";
const DEFAULT_INDEX = process.env.OPENSEARCH_DEFAULT_INDEX || "logs-json-*";

if (!DASHBOARD_URL) {
  console.error("ERROR: OPENSEARCH_DASHBOARD_URL is required");
  process.exit(1);
}
if (!COOKIE) {
  console.error("ERROR: OPENSEARCH_COOKIE is required");
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function osFetch(path, method = "GET", body = null) {
  const proxyUrl = `${DASHBOARD_URL}/api/console/proxy?path=${encodeURIComponent(path)}&method=${method}&dataSourceId=`;

  const options = {
    method: "POST", // proxy endpoint always receives POST
    headers: {
      "osd-xsrf": "true",
      "Content-Type": "application/json",
      "Cookie": COOKIE,
    },
  };

  if (body) {
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetch(proxyUrl, options);
  const text = await res.text();

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
          `Session expired or unauthorized (HTTP ${res.status}).\n\n` +
          `Como renovar o cookie:\n` +
          `  1. Abra o dashboard no navegador: ${DASHBOARD_URL}\n` +
          `  2. Faça login via SSO se solicitado\n` +
          `  3. Abra o DevTools (F12) → aba Network\n` +
          `  4. Recarregue a página\n` +
          `  5. Clique em qualquer requisição para o domínio do dashboard → Headers → Request Headers → copie o valor completo do campo "Cookie:"\n` +
          `  6. Atualize OPENSEARCH_COOKIE no config do MCP e reinicie a sessão do Claude Code.`
        );
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function json(data) {
  return ok(JSON.stringify(data, null, 2));
}

function formatHit(hit) {
  const src = hit._source || {};
  const ts = src["@timestamp"] || src.timestamp || "";
  const level = src.logs?.level || src.log?.level || src.level || src.severity || "";
  // SAP CLS: text is in logs.message; fallback to other common fields
  const msg = src.logs?.message || src.message || src.log?.message || src["log.original"] || "";
  // SAP CLS: pod name is in kubernetes.pod_name (underscore, not dot)
  const pod = src.kubernetes?.pod_name || src["kubernetes.pod.name"] || src.pod || src["k8s.pod.name"] || "";
  const logger = src.logs?.loggerName || src["log.logger"] || src.logger || "";

  const parts = [];
  if (ts) parts.push(`[${ts}]`);
  if (level) parts.push(`[${level.toUpperCase()}]`);
  if (pod) parts.push(`[${pod}]`);
  if (logger) parts.push(`[${logger}]`);
  parts.push(msg || JSON.stringify(src).slice(0, 300));

  return parts.join(" ");
}

function collectFields(props, prefix, result) {
  for (const [key, val] of Object.entries(props)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val.properties) {
      collectFields(val.properties, fullKey, result);
    } else {
      result[fullKey] = val.type || "object";
    }
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "opensearch",
  version: "1.0.0",
});

// ══════════════════════════════════════════════════════════════════════════════
// SEARCH LOGS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "search_logs",
  "Search log records. Supports Lucene query syntax, time range, pod/namespace filters.",
  {
    query: z.string().describe(
      'Lucene query string. Field names for SAP CLS: logs.message (text), kubernetes.pod_name (pod), @timestamp (UTC).\n' +
      'Examples:\n' +
      '  "AdyenProcessNotificationEventListener"\n' +
      '  "logs.message:\\"OutOfMemoryError\\""\n' +
      '  "logs.message:PSP AND kubernetes.pod_name:accstorefront*"\n' +
      '  "kubernetes.pod_name:accstorefront-74cb8bc69c-dcpjl"\n' +
      '  "*" – match all\n' +
      'IMPORTANT: timestamps are UTC. BRT = UTC-3 (e.g. 21:15 BRT = 00:15 UTC next day).'
    ),
    index: z.string().optional().default(DEFAULT_INDEX).describe(`Index pattern. Default: "${DEFAULT_INDEX}"`),
    from: z.string().optional().describe('Start time in UTC. ALWAYS specify for historical analysis — omitting defaults to now-1h which will produce incorrect results. Examples: "now-24h", "now-7d", "2026-04-13T00:10:00" (= 21:10 BRT prev day)'),
    to: z.string().optional().default("now").describe("End time. Default: now"),
    size: z.number().int().min(1).max(500).optional().default(50).describe("Max results. Default: 50"),
    sort: z.enum(["desc", "asc"]).optional().default("desc").describe("Sort by timestamp. Default: desc (newest first)"),
    fields: z.array(z.string()).optional().describe('Specific fields to return. If omitted, returns formatted summary.'),
    timestampField: z.string().optional().default("@timestamp").describe('Timestamp field. Default: "@timestamp"'),
  },
  async ({ query, index, from, to, size, sort, fields, timestampField }) => {
    const effectiveFrom = from ?? "now-1h";
    const body = {
      query: {
        bool: {
          must: [
            { query_string: { query, default_field: "logs.message", analyze_wildcard: true } },
          ],
          filter: [
            { range: { [timestampField]: { gte: effectiveFrom, lte: to } } },
          ],
        },
      },
      sort: [{ [timestampField]: { order: sort } }],
      size,
    };

    if (fields?.length) body._source = fields;

    const data = await osFetch(`/${index}/_search`, "POST", body);
    const total = data.hits?.total?.value ?? data.hits?.total ?? 0;
    const hits = data.hits?.hits ?? [];

    if (!hits.length) return ok(`No logs found for: "${query}" [${effectiveFrom} → ${to}]`);

    const lines = [`Found ${total} log(s) (showing ${hits.length}) — "${query}" [${effectiveFrom} → ${to}]\n`];
    if (!from) lines.unshift("⚠️  WARNING: 'from' not specified — results cover the last 1h only. For historical analysis always pass an explicit 'from' date (e.g. \"now-7d\" or \"2026-04-01T00:00:00Z\").\n");
    for (const hit of hits) {
      lines.push(fields?.length ? JSON.stringify(hit._source) : formatHit(hit));
    }

    return ok(lines.join("\n"));
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// COUNT LOGS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "count_logs",
  "Count log records matching a query and time range without fetching content.",
  {
    query: z.string().describe('Lucene query. Field: logs.message. Example: "logs.message:\\"OutOfMemoryError\\"". Timestamps are UTC.'),
    index: z.string().optional().default(DEFAULT_INDEX).describe(`Index pattern. Default: "${DEFAULT_INDEX}"`),
    from: z.string().optional().describe('Start time (UTC). ALWAYS specify for historical analysis — omitting defaults to now-1h. Examples: "now-24h", "now-7d", "2026-04-01T00:00:00Z"'),
    to: z.string().optional().default("now").describe("End time (UTC)"),
    timestampField: z.string().optional().default("@timestamp").describe('Timestamp field. Default: "@timestamp"'),
  },
  async ({ query, index, from, to, timestampField }) => {
    const effectiveFrom = from ?? "now-1h";
    const body = {
      query: {
        bool: {
          must: [{ query_string: { query, default_field: "logs.message", analyze_wildcard: true } }],
          filter: [{ range: { [timestampField]: { gte: effectiveFrom, lte: to } } }],
        },
      },
    };

    const data = await osFetch(`/${index}/_count`, "POST", body);
    const warning = !from ? "⚠️  WARNING: 'from' not specified — count covers last 1h only.\n" : "";
    return ok(`${warning}Count for "${query}" in [${effectiveFrom} → ${to}]: ${data.count ?? 0} document(s)`);
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// AGGREGATE LOGS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "aggregate_logs",
  "Aggregate logs: count over time (date_histogram) or top values (terms).",
  {
    query: z.string().optional().default("*").describe('Filter query. Field: logs.message. Example: "logs.message:ERROR". Default: "*"'),
    index: z.string().optional().default(DEFAULT_INDEX).describe(`Index pattern. Default: "${DEFAULT_INDEX}"`),
    from: z.string().optional().describe('Start time (UTC). ALWAYS specify for historical analysis — omitting defaults to now-1h. Examples: "now-24h", "now-7d", "2026-04-01T00:00:00Z"'),
    to: z.string().optional().default("now").describe("End time (UTC)"),
    aggType: z.enum(["date_histogram", "terms"]).describe(
      '"date_histogram" – count over time | "terms" – top N values of a field'
    ),
    field: z.string().describe(
      'Field to aggregate. Examples:\n' +
      '  date_histogram: "@timestamp"\n' +
      '  terms: "kubernetes.pod.name", "level", "log.logger"'
    ),
    interval: z.string().optional().default("5m").describe('date_histogram interval. Examples: "1m", "5m", "1h". Default: "5m"'),
    size: z.number().int().min(1).max(100).optional().default(10).describe("terms: number of top buckets. Default: 10"),
    timestampField: z.string().optional().default("@timestamp").describe('Timestamp field. Default: "@timestamp"'),
  },
  async ({ query, index, from, to, aggType, field, interval, size, timestampField }) => {
    const effectiveFrom = from ?? "now-1h";
    const agg = aggType === "date_histogram"
      ? { date_histogram: { field, calendar_interval: interval, min_doc_count: 1 } }
      : { terms: { field, size } };

    const body = {
      size: 0,
      query: {
        bool: {
          must: [{ query_string: { query, default_field: "logs.message", analyze_wildcard: true } }],
          filter: [{ range: { [timestampField]: { gte: effectiveFrom, lte: to } } }],
        },
      },
      aggs: { result: agg },
    };

    const data = await osFetch(`/${index}/_search`, "POST", body);
    const buckets = data.aggregations?.result?.buckets ?? [];

    if (!buckets.length) return ok(`No results for "${query}" [${effectiveFrom} → ${to}]`);

    const lines = [`${aggType} on "${field}" for "${query}" [${effectiveFrom} → ${to}]:\n`];
    if (!from) lines.unshift("⚠️  WARNING: 'from' not specified — results cover last 1h only. For historical analysis always pass an explicit 'from' date (e.g. \"now-7d\" or \"2026-04-01T00:00:00Z\").\n");
    for (const b of buckets) {
      lines.push(`  ${b.key_as_string || b.key}: ${b.doc_count} docs`);
    }

    return ok(lines.join("\n"));
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// LIST INDICES
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "list_indices",
  "List OpenSearch indices matching a pattern, with doc count and size.",
  {
    pattern: z.string().optional().default("logs-json-*").describe('Index pattern. Default: "logs-json-*"'),
  },
  async ({ pattern }) => {
    const data = await osFetch(`/_cat/indices/${encodeURIComponent(pattern)}?format=json&s=index`, "GET");

    if (!data?.length) return ok(`No indices found for: ${pattern}`);

    const lines = [`Found ${data.length} index(es) matching "${pattern}":\n`];
    for (const idx of data) {
      lines.push(`  ${idx.index}  docs: ${idx["docs.count"] ?? "?"}  size: ${idx["store.size"] ?? "?"}  status: ${idx.status ?? "?"}`);
    }

    return ok(lines.join("\n"));
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// GET FIELD MAPPINGS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_field_mappings",
  "Get field mappings for an index to discover available fields and their types.",
  {
    index: z.string().optional().default(DEFAULT_INDEX).describe(`Index or pattern. Default: "${DEFAULT_INDEX}"`),
    filter: z.string().optional().describe('Filter field names by substring. Example: "kubernetes", "log", "message"'),
  },
  async ({ index, filter }) => {
    const data = await osFetch(`/${encodeURIComponent(index)}/_mapping`, "GET");

    const allFields = {};
    for (const [, indexData] of Object.entries(data)) {
      collectFields(indexData.mappings?.properties || {}, "", allFields);
    }

    let fields = Object.entries(allFields);
    if (filter) fields = fields.filter(([name]) => name.toLowerCase().includes(filter.toLowerCase()));
    if (!fields.length) return ok(`No fields found${filter ? ` matching "${filter}"` : ""} in: ${index}`);

    const lines = [`Fields in "${index}"${filter ? ` (filter: "${filter}")` : ""} — ${fields.length} field(s):\n`];
    for (const [name, type] of fields.sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${name}: ${type}`);
    }

    return ok(lines.join("\n"));
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// GET COOKIE INSTRUCTIONS
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_cookie_instructions",
  "Returns step-by-step instructions for obtaining or renewing the browser session cookie required to authenticate with OpenSearch Dashboards (SAML/SSO environments). Call this tool whenever the user asks how to get the cookie, or when a 401/403 error occurs.",
  {},
  async () => {
    const hasCookie = !!COOKIE;
    const status = hasCookie
      ? "Cookie está configurado (pode estar expirado se estiver recebendo erro 401/403)."
      : "Cookie NÃO está configurado — as queries vão falhar até você configurar.";

    return ok(
      `${status}\n\n` +
      `COOKIE EXPIRADO? Siga estes passos:\n\n` +
      `  1. Abra no navegador: ${DASHBOARD_URL}\n` +
      `  2. Faça login via SSO/SAML.\n` +
      `  3. F12 → aba Network → recarregue (F5) → clique em qualquer request do dashboard.\n` +
      `  4. Em Headers → Request Headers → copie o valor completo do campo "Cookie:".\n` +
      `  5. Cole aqui no chat: "cookie prod: <valor>" ou "cookie dev: <valor>".\n\n` +
      `O Claude vai atualizar o arquivo ~/.claude.json automaticamente.\n\n` +
      `Localização manual (se preferir editar direto):\n` +
      `  Arquivo: ~/.claude.json → mcpServers → opensearch-dev ou opensearch-prod → env → OPENSEARCH_COOKIE\n\n` +
      `  6. Reinicie a sessão do Claude Code para o novo cookie ser carregado.\n\n` +
      `Dica: o cookie expira quando a sessão SSO expira (geralmente horas ou dias).`
    );
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
