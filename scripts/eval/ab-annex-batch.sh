#!/usr/bin/env bash
# P20 批量：10 篇 v2.1+annex 档案生成 + 档案直答重建测试（逐篇续跑驱动）。
#
# 每篇 = 一个独立 ab-reconstruct 进程（自带 server、独立端口），输出
#   training/eval/reports/ab-recon-annex-<key>.json(.log)
# 已完成判定：日志含 "== <key> 平均"（探针跑完出分）。中断后重跑自动跳过
# 已完成篇目（--annex 会重新生成档案并覆盖 dossier-cache——探针用最新档案）。
#
# 用法：bash scripts/eval/ab-annex-batch.sh [keys...]（缺省 = 10 篇全集）
# 环境：真实 LLM（. scripts/eval/llm-env.sh 装载 AB_AI_*/OPENCODE_SESSION）。
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
. scripts/eval/llm-env.sh
if [ "$#" -gt 0 ]; then KEYS="$*"; else
  KEYS="-营一日的恐怖_20231103 古城秘史_20230330 奈落之蛹_20220810 巫_20220928_nocom 无知的幸福_20231101 早八要迟到了 模组集-古城诡秘_2011b 火焰交织的盛夏_220819_compressed 猫是我_20250723 重返黑色校园"
fi
OUTDIR="training/eval/reports"
mkdir -p "$OUTDIR"
port=3281
for key in $KEYS; do
  out="$OUTDIR/ab-recon-annex-$key.json"
  log="$out.log"
  if [ -f "$log" ] && grep -q "== $key 平均" "$log"; then
    echo "[skip] $key 已完成（复用 $log）"
    continue
  fi
  echo "== $key 开始 $(date '+%H:%M:%S')（port $port）"
  E2E_PORT=$port MOCK_AI=0 node scripts/eval/ab-reconstruct.mjs --keys="$key" --annex=1 --out="$out" >"$log" 2>&1
  code=$?
  port=$((port + 1))
  if [ "$code" -ne 0 ]; then
    echo "[fail] $key exit=$code —— 继续下一篇（详见 $log）"
    continue
  fi
  if grep -q "== $key 平均" "$log"; then echo "[ok] $key 完成 $(date '+%H:%M:%S')"; else echo "[incomplete] $key 无均分行（详见 $log）"; fi
done
echo "batch done $(date '+%H:%M:%S')"
