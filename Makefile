# mcp-mural — every workflow lives here. `make` lists them.
#
# Setup
#   make install              npm install
#   make build                compile TypeScript -> build/
#   make vendor               clone/update vendors/macos-keychain-env (keychain secret store; git-ignored)
#   make secret KEY=<name>    store one MURAL_* value in the keychain (hidden prompt, never on argv)
#   make secrets              list which MURAL_* keychain items exist (reads no values)
#   make auth                 OAuth consent flow; stores tokens in the keychain (macOS) or .env
#   make env                  create .env from .env.example if missing
#
# Tests
#   make smoke                offline end-to-end test against a mock Mural API
#   make probe BOARD=<id>     live READ probe: workspaces, board, widgets (no changes)
#   make probe-write BOARD=<id>  live WRITE probe: creates and updates one yellow sticky note
#   make snapshot BOARD=<id>  JSON snapshot of the whole board -> .artifacts/mural/<id>/<timestamp>/ (+diff vs previous)
#
# Claude Code only
#   make register [SCOPE=user]  claude mcp add (stdio)      make unregister / make status
#
# All clients (Claude Code, Claude Desktop, Gemini CLI, ChatGPT desktop/Codex)
#   make integrations         register with all four
#   make verify-integrations  verify all four (read-only, non-zero exit on failure)
#
# Remote clients (Gemini app, ChatGPT connectors) — need a public HTTPS URL
#   make http                 serve Streamable HTTP on 127.0.0.1:$(PORT)  [PORT=50010]
#   make http-secret          generate MURAL_HTTP_SECRET in .env if missing
#   make tunnel               cloudflared quick tunnel -> https://*.trycloudflare.com for $(PORT)
#   make expose               http + tunnel together; prints the URL to paste into Gemini/ChatGPT
#
# Housekeeping
#   make clean                remove build/
#   make clean-backups        delete *.bak-* files the add scripts left in client config dirs

SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT  := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
ENTRY := $(ROOT)/build/index.js
NODE  := $(shell command -v node)
NAME  ?= mural
SCOPE ?=
PORT  ?= 50010
BOARD ?=
KEY   ?=
CLIENTS := claude-code claude-desktop gemini-cli chatgpt-codex
# Keychain secret store (see src/secrets.ts). Override the repo/ref/service from the environment.
VENDORS           := $(ROOT)/vendors
KEYCHAIN_ENV_DIR  := $(VENDORS)/macos-keychain-env
KEYCHAIN_ENV_REPO ?= https://github.com/multistageharness/macos-keychain-env
KEYCHAIN_ENV_REF  ?= main
KEYCHAIN_SERVICE  ?= $(or $(MURAL_KEYCHAIN_SERVICE),mural-mcp)
KEYCHAIN_KEYS     := MURAL_CLIENT_ID MURAL_CLIENT_SECRET MURAL_ACCESS_TOKEN MURAL_REFRESH_TOKEN MURAL_TOKEN_EXPIRES_AT MURAL_HTTP_SECRET MURAL_HTTP_BEARER
KEYCHAIN_CLI      := $(NODE) $(KEYCHAIN_ENV_DIR)/bin/keychain-env.js
CLAUDE  := $(shell command -v claude 2>/dev/null || echo $(HOME)/.local/bin/claude)

.PHONY: help install build env vendor secret secrets auth smoke probe probe-write snapshot register unregister status \
        integrations verify-integrations http http-secret tunnel expose clean clean-backups

help:
	@sed -n 's/^#   //p' $(MAKEFILE_LIST)

# ---- setup -------------------------------------------------------------------
install: node_modules/.package-lock.json
node_modules/.package-lock.json: package.json package-lock.json
	npm install
	@touch $@

build: install
	npm run build

env:
	@[ -f $(ROOT)/.env ] && echo ".env exists" || { cp $(ROOT)/.env.example $(ROOT)/.env && chmod 600 $(ROOT)/.env && echo "created .env — fill in MURAL_CLIENT_ID / MURAL_CLIENT_SECRET, then: make auth"; }

vendor:
	@if [ -d "$(KEYCHAIN_ENV_DIR)/.git" ]; then \
	  git -C "$(KEYCHAIN_ENV_DIR)" pull --ff-only --quiet && echo "vendors/macos-keychain-env up to date ($$(git -C "$(KEYCHAIN_ENV_DIR)" rev-parse --short HEAD))" \
	    || echo "WARN: could not update vendors/macos-keychain-env; using the existing checkout"; \
	else \
	  mkdir -p "$(VENDORS)" && git clone --quiet --depth 1 --branch "$(KEYCHAIN_ENV_REF)" "$(KEYCHAIN_ENV_REPO)" "$(KEYCHAIN_ENV_DIR)" \
	    && echo "cloned $(KEYCHAIN_ENV_REPO) ($(KEYCHAIN_ENV_REF)) -> vendors/macos-keychain-env"; \
	fi

secret: vendor
	@[ -n "$(KEY)" ] || { echo "usage: make secret KEY=<$(subst $() ,|,$(KEYCHAIN_KEYS))>   (hidden prompt; the value never touches argv)"; exit 2; }
	$(KEYCHAIN_CLI) set "$(KEYCHAIN_SERVICE)" "$(KEY)"

secrets: vendor
	@echo "keychain service: $(KEYCHAIN_SERVICE)"; for k in $(KEYCHAIN_KEYS); do \
	  if $(KEYCHAIN_CLI) has "$(KEYCHAIN_SERVICE)" "$$k" >/dev/null 2>&1; then echo "present  $$k"; else echo "missing  $$k"; fi; done

auth: build vendor env
	npm run auth

# ---- tests -------------------------------------------------------------------
smoke: build
	npm run smoke

probe: build
	@[ -n "$(BOARD)" ] || { echo "usage: make probe BOARD=<workspace>.<id>"; exit 2; }
	$(NODE) $(ROOT)/scripts/probe.mjs --board $(BOARD)

probe-write: build
	@[ -n "$(BOARD)" ] || { echo "usage: make probe-write BOARD=<workspace>.<id>"; exit 2; }
	$(NODE) $(ROOT)/scripts/probe.mjs --board $(BOARD) --write

snapshot: build
	@[ -n "$(BOARD)" ] || { echo "usage: make snapshot BOARD=<workspace>.<id> [OUT=.artifacts]"; exit 2; }
	$(NODE) $(ROOT)/scripts/snapshot.mjs --board $(BOARD) $(if $(OUT),--out $(OUT))

# ---- Claude Code only --------------------------------------------------------
register: build
	$(CLAUDE) mcp add --transport stdio $(if $(SCOPE),--scope $(SCOPE)) $(NAME) -- $(NODE) $(ENTRY)

unregister:
	$(CLAUDE) mcp remove $(NAME)

status:
	$(CLAUDE) mcp get $(NAME)

# ---- all clients -------------------------------------------------------------
integrations: build
	@for c in $(CLIENTS); do echo "== $$c"; bash $(ROOT)/.claude/skills/integration-$$c-add/scripts/add.sh || exit 1; done

verify-integrations:
	@rc=0; for c in $(CLIENTS); do echo "== $$c"; bash $(ROOT)/.claude/skills/integration-$$c-verify/scripts/verify.sh || rc=1; done; exit $$rc

# ---- remote clients ----------------------------------------------------------
http: build
	$(NODE) $(ENTRY) --http --port $(PORT)

http-secret:
	@bash $(ROOT)/scripts/http-secret.sh

tunnel:
	@echo "Tunnelling http://127.0.0.1:$(PORT) — run 'make http' in another terminal first (or use 'make expose')."
	npx --yes cloudflared@0.7.3 tunnel --url http://127.0.0.1:$(PORT)

expose: build http-secret
	@PORT=$(PORT) bash $(ROOT)/scripts/expose.sh

# ---- housekeeping ------------------------------------------------------------
clean:
	rm -rf build

clean-backups:
	@for f in "$(HOME)/Library/Application Support/Claude/claude_desktop_config.json.bak-"* "$(HOME)/.codex/config.toml.bak-"*; do [ -e "$$f" ] && { rm -v "$$f"; } || true; done
