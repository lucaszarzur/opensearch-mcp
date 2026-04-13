# opensearch-mcp

MCP Server for querying OpenSearch / OpenSearch Dashboards logs via the Kibana console proxy — designed for SAML/SSO environments where direct API access is not available.

Tested with **SAP Cloud Logging Service (CLS)** on OpenSearch 2.19.x.

## How it works

All requests are proxied through the OpenSearch Dashboards console endpoint:

```
POST <DASHBOARD_URL>/api/console/proxy?path=<encoded-path>&method=<METHOD>&dataSourceId=
```

Authentication is done via a browser session cookie (obtained after SSO login), passed as the `Cookie` request header alongside `osd-xsrf: true`.

## Requirements

- Node.js 18+
- Access to an OpenSearch Dashboards instance (SAML/SSO)

## Installation

```bash
npm install
```

## Configuration

| Env var | Required | Description |
|---------|----------|-------------|
| `OPENSEARCH_DASHBOARD_URL` | ✅ | Base URL of the dashboard (no trailing slash) |
| `OPENSEARCH_COOKIE` | ✅ | Full `Cookie:` header value from an authenticated browser session |
| `OPENSEARCH_DEFAULT_INDEX` | — | Default index pattern (default: `logs-json-*`) |

### How to get the session cookie

1. Open the dashboard in your browser
2. Log in via SSO if prompted
3. Open DevTools (F12) → **Network** tab
4. Reload the page
5. Click any request to the dashboard domain → **Headers** → **Request Headers** → copy the full `Cookie:` value
6. Set it as `OPENSEARCH_COOKIE` in your MCP config

> The cookie expires when your SSO session expires. Run the `get_cookie_instructions` tool inside Claude to get this guide at any time.

## Registering with Claude Code

```bash
claude mcp add opensearch-prod -s user \
  -e OPENSEARCH_DASHBOARD_URL=https://your-dashboard-url \
  -e OPENSEARCH_COOKIE="your-cookie-here" \
  -- node /path/to/opensearch-mcp/index.js
```

Use `-s user` for global scope (available in all projects) or `-s local` for project scope.

## Available tools

| Tool | Description |
|------|-------------|
| `search_logs` | Search logs with Lucene query, time range, size and sort |
| `count_logs` | Count matching documents without fetching content |
| `aggregate_logs` | `date_histogram` or `terms` aggregation over a field |
| `list_indices` | List indices matching a pattern with doc count and size |
| `get_field_mappings` | Discover available fields and types for an index |
| `get_cookie_instructions` | Step-by-step guide to obtain or renew the session cookie |

## Field naming (SAP CLS)

| Purpose | Field |
|---------|-------|
| Log text | `logs.message` |
| Pod name | `kubernetes.pod_name` |
| Timestamp | `@timestamp` (UTC) |

> **Timezone note:** all timestamps are UTC. If your team works in BRT (UTC-3), 21:15 BRT = 00:15 UTC next day.

## Query examples

```
# All logs from a specific pod
kubernetes.pod_name:accstorefront-74cb8bc69c-dcpjl

# Exact phrase in log text
logs.message:"saveFromNotificationRequest"

# PSP reference anywhere in the message
logs.message:L3LNPHHBFXHSRWX3

# Errors from a pod name pattern
logs.message:ERROR AND kubernetes.pod_name:accstorefront*
```
