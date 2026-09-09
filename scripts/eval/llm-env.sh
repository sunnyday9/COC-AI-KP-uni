#!/usr/bin/env bash
# Load real-LLM env vars for eval scripts (source me, don't exec):
#   . scripts/eval/llm-env.sh
# Reads the ZCode appdata config (provider key prefix fc365be1 → opencode.ai) and
# exports AB_AI_BASE_URL / AB_AI_API_KEY / OPENCODE_SESSION. Never echoes the
# apiKey value (Mimosa: 凭据只从配置文件读、不落命令行/日志字面量)。
# Override per-run: AB_AI_BASE_URL=... AB_AI_API_KEY=... OPENCODE_SESSION=...
set -u
CFG_FILE="F:/zcode-harness/appdata/.zcode/v2/config.json"
if [ -z "${AB_AI_BASE_URL:-}" ] && [ -f "$CFG_FILE" ]; then
  export AB_AI_BASE_URL=$(node -e "
    const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const prov = c.provider || {};
    const entry = Object.entries(prov).find(([k, x]) => k.startsWith('fc365be1') || String((x && x.id) || '').startsWith('fc365be1'));
    const o = (entry && entry[1] && entry[1].options) || {};
    process.stdout.write(o.baseURL || '');
  " "$CFG_FILE")
fi
if [ -z "${AB_AI_API_KEY:-}" ] && [ -f "$CFG_FILE" ]; then
  export AB_AI_API_KEY=$(node -e "
    const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const prov = c.provider || {};
    const entry = Object.entries(prov).find(([k, x]) => k.startsWith('fc365be1') || String((x && x.id) || '').startsWith('fc365be1'));
    const o = (entry && entry[1] && entry[1].options) || {};
    process.stdout.write(o.apiKey || '');
  " "$CFG_FILE")
fi
if [ -z "${OPENCODE_SESSION:-}" ]; then export OPENCODE_SESSION="kp-dossier-annex-$(date +%Y%m%d)"; fi
export AB_AI_MODEL="${AB_AI_MODEL:-mimo-v2.5}"
if [ -z "${AB_AI_BASE_URL:-}" ] || [ -z "${AB_AI_API_KEY:-}" ]; then
  echo "[llm-env] 缺 AB_AI_BASE_URL/AB_AI_API_KEY（config.json 未找到或 provider 缺失）" >&2
  return 1 2>/dev/null || exit 1
fi
# 只回显非敏感信息
echo "[llm-env] baseUrl=$AB_AI_BASE_URL model=$AB_AI_MODEL session=${OPENCODE_SESSION:0:12}… key=已加载(${#AB_AI_API_KEY}字符)"
