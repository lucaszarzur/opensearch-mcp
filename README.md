# OpenSearch MCP Server

![version](https://img.shields.io/badge/version-1.0.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![license](https://img.shields.io/badge/license-ISC-lightgrey)
![auth](https://img.shields.io/badge/auth-SAML%2FSSO%20cookie-orange)

MCP server para consulta de logs em ambientes **OpenSearch / OpenSearch Dashboards** que usam autenticação SAML/SSO — sem acesso direto à API.

---

## Por que este MCP existe?

Em ambientes corporativos com SSO (como o **SAP Cloud Logging Service — CLS**), o OpenSearch não expõe sua API diretamente para tokens de serviço. O acesso é feito exclusivamente via sessão autenticada no browser.

Este servidor resolve isso roteando todas as requisições pelo proxy do OpenSearch Dashboards:

```
POST <DASHBOARD_URL>/api/console/proxy?path=<encoded-path>&method=<METHOD>&dataSourceId=
```

A autenticação é feita com o cookie de sessão do browser, passado como header `Cookie` junto com `osd-xsrf: true`.

| Ambiente | MCP genérico | Este MCP |
|----------|-------------|----------|
| OpenSearch com API key / usuário+senha | ✅ | ✅ |
| OpenSearch com SAML/SSO (sem acesso direto) | ❌ | ✅ |
| SAP Cloud Logging Service (CLS) | ❌ | ✅ |

---

## Pré-requisitos

- Node.js >= 18
- Acesso ao OpenSearch Dashboards via browser (SSO)

---

## Instalação e configuração

### 1. Clone e instale

```bash
git clone https://github.com/<seu-usuario>/opensearch-mcp
cd opensearch-mcp
npm install
```

### 2. Obtenha o cookie de sessão

#### Opção A: Extensão Chrome (recomendado)

1. Abra `chrome://extensions` e ative **Modo do desenvolvedor**
2. Clique em **Carregar sem compactacao** e selecione a pasta `chrome-extension/` deste repositório
3. Navegue até o dashboard OpenSearch (QA, PROD ou DEV)
4. Clique no ícone da extensão:
   - **Copiar Cookie** — copia o cookie cru para a área de transferência
   - **Copiar Comando de Update** — copia o comando `update-opensearch-cookie` pronto para colar no terminal

#### Opção B: Manual (DevTools)

1. Abra o dashboard no browser
2. Faça login via SSO se solicitado
3. Abra o DevTools (F12) → aba **Network**
4. Recarregue a página (F5)
5. Clique em qualquer requisição para o domínio do dashboard → **Headers** → **Request Headers** → copie o valor completo do campo `Cookie:`

> O cookie expira quando a sessão SSO expira. Use o tool `get_cookie_instructions` dentro do Claude para rever este guia a qualquer momento.

### 3. Adicione ao Claude Code

Você pode registrar múltiplos ambientes com nomes distintos:

```bash
# Ambiente de produção
claude mcp add opensearch-prod -s user \
  -e OPENSEARCH_DASHBOARD_URL="https://dashboards-sf-<id>.cls.eu20.hana.ondemand.com" \
  -e OPENSEARCH_COOKIE="security_authentication=..." \
  -- node /caminho/para/opensearch-mcp/index.js

# Ambiente de QA
claude mcp add opensearch-qa -s user \
  -e OPENSEARCH_DASHBOARD_URL="https://dashboards-sf-<id-qa>.cls.eu20.hana.ondemand.com" \
  -e OPENSEARCH_COOKIE="security_authentication=..." \
  -- node /caminho/para/opensearch-mcp/index.js

# Ambiente de DEV
claude mcp add opensearch-dev -s user \
  -e OPENSEARCH_DASHBOARD_URL="https://dashboards-sf-<id-dev>.cls.eu20.hana.ondemand.com" \
  -e OPENSEARCH_COOKIE="security_authentication=..." \
  -- node /caminho/para/opensearch-mcp/index.js
```

Use `-s user` para escopo global (disponível em todos os projetos) ou `-s local` para escopo do projeto.

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `OPENSEARCH_DASHBOARD_URL` | ✅ | URL base do dashboard, sem barra no final |
| `OPENSEARCH_COOKIE` | ✅ | Valor completo do header `Cookie:` copiado do browser |
| `OPENSEARCH_DEFAULT_INDEX` | — | Index pattern padrão (default: `logs-json-*`) |

### 4. Atualizando o cookie (quando expirar)

#### Com o script CLI

```bash
# Copie o cookie (via extensão Chrome ou DevTools) e rode:
update-opensearch-cookie qa   '<cookie>'
update-opensearch-cookie prod '<cookie>'
update-opensearch-cookie dev  '<cookie>'
```

O script atualiza automaticamente todas as ocorrências do ambiente no `~/.claude.json`.

> Para disponibilizar o script globalmente, adicione ao PATH: `export PATH="$HOME/tools:$PATH"` no `~/.bashrc`, ou crie um symlink: `ln -s /app/IA/opensearch-mcp/update-opensearch-cookie ~/tools/update-opensearch-cookie`

#### Com a extensão Chrome

1. Abra o dashboard OpenSearch do ambiente desejado
2. Clique na extensão → **Copiar Comando de Update**
3. Cole no terminal
4. Reinicie o Claude Code

### 5. Teste a conexão

Após adicionar, reinicie o Claude Code e peça:

```
Liste os índices disponíveis no OpenSearch
```

Se o MCP estiver funcionando, o Claude usará automaticamente as ferramentas disponíveis.

---

## Exemplo de uso

**Prompt:**
```
Busque logs de erro do pod accstorefront-74cb8bc69c-dcpjl na última hora
```

**O Claude orquestra as chamadas automaticamente:**

```
→ search_logs (query: "kubernetes.pod_name:accstorefront-74cb8bc69c-dcpjl AND logs.message:ERROR", from: "now-1h")
→ aggregate_logs (aggType: terms, field: logs.loggerName)
```

---

## Nomes de campos (SAP CLS)

| Finalidade | Campo |
|------------|-------|
| Texto do log | `logs.message` |
| Nome do pod | `kubernetes.pod_name` |
| Timestamp | `@timestamp` (UTC) |
| Logger | `logs.loggerName` |

> **Fuso horário:** todos os timestamps são UTC. BRT = UTC-3 (ex: 21:15 BRT = 00:15 UTC do dia seguinte).

## Exemplos de query

```
# Texto exato no log
logs.message:"saveFromNotificationRequest"

# PSP reference em qualquer parte da mensagem
logs.message:L3LNPHHBFXHSRWX3

# Erros de um pod específico
logs.message:ERROR AND kubernetes.pod_name:accstorefront-74cb8bc69c-dcpjl

# Qualquer pod com padrão de nome
kubernetes.pod_name:accstorefront*
```

---

## Ferramentas disponíveis (6)

### Logs
- `search_logs` — Busca logs com query Lucene, intervalo de tempo, tamanho e ordenação
- `count_logs` — Conta documentos sem buscar conteúdo
- `aggregate_logs` — Agregação `date_histogram` (volume ao longo do tempo) ou `terms` (top valores de um campo)

### Índices e Schema
- `list_indices` — Lista índices com contagem de documentos e tamanho em disco
- `get_field_mappings` — Descobre campos disponíveis e seus tipos em um índice

### Autenticação
- `get_cookie_instructions` — Guia passo a passo para obter ou renovar o cookie de sessão

---

## Utilitários incluídos

| Ferramenta | Caminho | Descricao |
|------------|---------|-----------|
| Extensão Chrome | `chrome-extension/` | Extrai cookies do dashboard OpenSearch com um clique |
| Script CLI | `update-opensearch-cookie` | Atualiza o cookie no `~/.claude.json` via terminal |
