<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '../../../types/game'
import { classifySystemMessage, type SystemMessageKind } from '../../../utils/classifySystemMessage'

/**
 * T4：系统消息分类渲染（ADR-0004 消息类型体系）。
 * 房间消息流中系统消息为纯文本 → classifySystemMessage 推断视觉类别，不复用分类器之外的判词。
 * - dice    → 掷骰结果大卡：抽取 d100 大数字 + 成败辉光（金/血/紫三态）
 * - clue    → 线索获得（左缘绿光条，发光路径卷轴图标）
 * - damage  → 战斗伤害（血色调脉冲卡）
 * - stat    → 属性变更（SAN 紫 / MP 蓝 圆片）
 * - scene   → 场景分隔卡（居中暗金斜体 + 双端分割线）
 * - generic → 系统侧栏文本（暗金系小字）
 */

const props = defineProps<{ msg: Message }>()

const kind = computed<SystemMessageKind>(() => classifySystemMessage(props.msg))

/** dice: 提取「d100: N」段 → 大数字（无则回退整条文本无高亮）。 */
const diceRoll = computed(() => {
  const content = props.msg.content ?? ''
  const m = content.match(/d100\s*[:：]\s*(\d+)/)
  if (m) return m[1]
  const plain = content.match(/[dD]\d+\s*[:：]\s*(\d+)/)
  return plain ? plain[1] : ''
})

/** dice: 大数字文本形态（e2e 判定可见）。 */
const diceText = computed(() => (diceRoll.value ? `d100: ${diceRoll.value}` : (props.msg.content ?? '').trim()))

const diceGlow = computed(() => {
  const c = props.msg.content ?? ''
  if (/大失败|失败|未中|反噬|受到 \d+ 点伤害|没能读懂/.test(c)) return 'fail'
  if (/大成功|极难成功|困难成功|成功|命中/.test(c)) return 'success'
  if (/消耗|SAN|理智/.test(c)) return 'san'
  return 'neutral'
})

const glowTone = computed(() =>
  diceGlow.value === 'fail'
    ? 'var(--c-blood-400)'
    : diceGlow.value === 'san'
      ? 'var(--c-ritual-400)'
      : 'var(--c-ritual-400)'
)

/** scene/clue/damage: 前缀剥离（含冒号 + 后随空格）。 */
function stripPrefix(content: string, prefix: string): string {
  return content.startsWith(prefix) ? content.slice(prefix.length).trim() : content
}
</script>

<template>
  <!-- ── 场景分隔卡：居中暗金斜体 + 双端分割线 ── -->
  <view v-if="kind === 'scene'" class="sys-row scene-wrap">
    <view class="scene-divider" />
    <view class="scene-chip">
      <text class="scene-glyph">◆</text>
      <text class="scene-text" decode>{{ stripPrefix(msg.content, '场景切换') }}</text>
      <text class="scene-glyph">◆</text>
    </view>
    <view class="scene-divider" />
  </view>

  <!-- ── 线索获得：左缘绿光条 ── -->
  <view v-else-if="kind === 'clue'" class="sys-row">
    <view class="clue-line">
      <text class="clue-glyph" decode>✦</text>
      <text class="clue-text" decode>{{ stripPrefix(msg.content, '获得线索') }}</text>
    </view>
  </view>

  <!-- ── 掷骰结果大卡：d100 视觉焦点 + 成败辉光 ── -->
  <view v-else-if="kind === 'dice'" class="sys-row">
    <view class="dice-card" :style="{ borderColor: glowTone, boxShadow: '0 0 24px ' + glowTone + '33' }">
      <text class="dice-roll" :style="{ color: glowTone }">{{ diceText }}</text>
      <text class="dice-desc" decode>{{ msg.content }}</text>
    </view>
  </view>

  <!-- ── 战斗伤害：血色调脉冲卡 ── -->
  <view v-else-if="kind === 'damage'" class="sys-row">
    <view class="blood-card">
      <text class="blood-glyph" decode>⚔</text>
      <text class="blood-text" decode>{{ msg.content }}</text>
    </view>
  </view>

  <!-- ── 属性变更：SAN 紫 / MP 蓝 圆片 ── -->
  <view v-else-if="kind === 'stat'" class="sys-row">
    <view class="stat-pill" :class="msg.content.startsWith('SAN') ? 'san-pill' : 'mp-pill'">
      <text decode>{{ msg.content }}</text>
    </view>
  </view>

  <!-- ── 其他系统文本：暗金系侧栏小字 ── -->
  <view v-else class="sys-row">
    <text class="generic-text" decode>{{ msg.content }}</text>
  </view>
</template>

<style scoped lang="scss">
.sys-row {
  display: flex;
  width: 100%;
  box-sizing: border-box;
  justify-content: center;
  word-break: break-all;
  text-align: center;
}

/* ── scene ── */
.scene-wrap {
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 8px;
}
.scene-divider {
  width: 100%;
  height: 1px;
  background: linear-gradient(
    to right,
    transparent,
    var(--c-slate-light),
    var(--c-ritual-600),
    var(--c-slate-light),
    transparent
  );
}
.scene-chip {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 4px 14px;
}
.scene-text {
  font-family: $font-display;
  font-size: 14px;
  letter-spacing: 0.12em;
  font-style: italic;
  color: var(--c-ritual-200);
}
.scene-glyph {
  color: var(--c-ritual-600);
  font-size: 10px;
}

/* ── clue ── */
.clue-line {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 92%;
  padding: 10px 14px;
  border-left: 3px solid var(--c-eld-400);
  background: linear-gradient(to right, var(--c-eld-900), transparent 70%);
  border-radius: 2px 8px 8px 2px;
  text-align: left;
  box-shadow: inset 0 0 18px var(--c-eld-900);
}
.clue-glyph {
  color: var(--c-eld-300);
  font-size: 14px;
  flex-shrink: 0;
}
.clue-text {
  font-family: $font-serif;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--c-eld-200);
}

/* ── dice ── */
.dice-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 420px;
  padding: 16px 18px;
  border-radius: 12px;
  border: 1px solid;
  background: var(--c-card);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.dice-roll {
  font-family: $font-mono;
  font-size: 34px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.02em;
}
.dice-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-secondary);
}

/* ── damage（血色调） ── */
.blood-card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-radius: 10px;
  border: 1px solid var(--c-blood-700);
  background: linear-gradient(135deg, var(--c-blood-900), var(--c-blood-900));
  color: var(--c-blood-300);
  animation: blood-pulse 2s ease-in-out infinite;
}
.blood-glyph {
  font-size: 14px;
}
.blood-text {
  font-family: $font-serif;
  font-size: 14px;
  line-height: 1.5;
}
@keyframes blood-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--c-blood-600) 0%, transparent);
  }
  50% {
    box-shadow: 0 0 14px 0 color-mix(in srgb, var(--c-blood-600) 35%, transparent);
  }
}

/* ── stat ── */
.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 9999px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.san-pill {
  background: var(--c-ritual-900);
  border: 1px solid var(--c-ritual-800);
  color: var(--c-ritual-300);
  box-shadow: 0 0 12px var(--c-ritual-900);
}
.mp-pill {
  background: var(--c-slate);
  border: 1px solid var(--c-slate-light);
  color: var(--c-ritual-200);
  box-shadow: 0 0 12px var(--c-slate);
}

/* ── generic ── */
.generic-text {
  font-family: $font-serif;
  font-style: italic;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--c-ritual-400);
  opacity: 0.92;
  padding: 2px 0;
}
</style>
