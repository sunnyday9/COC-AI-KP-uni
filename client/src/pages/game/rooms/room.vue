<script setup lang="ts">
/**
 * room.vue — 等待室（Waiting Room / Lobby，ADR-0005 / T2 #29）。
 *
 * 多人房间 lobby 阶段的专用页面（聊天+开局不再挤一页）：
 *  - 房主：选已索引剧本、开局（门闩 409 → toast 缺项）、踢出成员、主动转让房主、解散；
 *  - 成员：绑卡状态/就绪展示、就绪/取消、主动离开；
 *  - 被踢 / 被转让为房主 / 房间解散 → 明确提示并回大厅；
 *  - 聊天保留（lobby 不触发 KP 由服务端 phase gate 保证）。
 * 开局成功 → room_meta phase=playing → 自动跳 game 页（本页之后不可达：playing 锁房 + 跳转）。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useRoomStore } from '../../../stores/roomStore'
import { useToast } from '../../../composables/useToast'
import ChatMessage from '../components/ChatMessage.vue'
import ConfirmModal from '../../../components/ui/ConfirmModal.vue'
import { getBridge } from '../../../platform'
import type { CharacterListItem } from '../../../../../shared/types/room'
import type { IndexedStory } from '../../../../../shared/types/bridge'

const roomStore = useRoomStore()
const toast = useToast()

const roomId = ref('')
const chatText = ref('')
const myCharacters = ref<CharacterListItem[]>([])
const showCharPicker = ref(false)
const selectedCharId = ref('')

// ── 故事选择 ──
const indexedStories = ref<IndexedStory[]>([])
const storyPickerOpen = ref(false)
/** 选中故事（storyId；null=未选）。本地选择源；开局时随 roomStart 提交（T1 无独立选故事端点）。 */
const pickedStoryId = ref<string | null>(null)

/** 已选剧本展示名（本地选择 or 服务端已开局登记）。 */
function storyNameOf(id: string | null): string {
  if (!id) return ''
  return indexedStories.value.find((s) => s.storyId === id)?.name ?? ''
}

/** 剧本展示 id/名（本地已选优先；服务端登记（storyId 列）兜底——开局后/建房带故事）。 */
const displayStoryId = computed(() => roomStore.storyId ?? pickedStoryId.value)
const displayStoryName = computed(() => storyNameOf(displayStoryId.value))

// ── 治理确认弹层 ──
const kickTarget = ref<{ userId: number; username: string } | null>(null)
const kickBusy = ref(false)
const transferTarget = ref<{ userId: number; username: string } | null>(null)
const transferBusy = ref(false)
const dissolveConfirm = ref(false)
const dissolveBusy = ref(false)

/** 被移出房间（踢出/解散）后的全屏提示覆盖。 */
const removedOverlay = ref(false)
/** 被移出原因副本（leaveRoom 会清 store.removedReason，先存下供文案/分支用）。 */
const removedKind = ref<'kicked' | 'dissolved' | null>(null)
/** 离开进行中（防重复提交）。 */
const leaving = ref(false)

/** 房主离开需确认（转让给最早成员 / 无成员则解散）。 */
const leaveConfirm = ref(false)

/** 房主「离开房间」：REST 离开（owner → 转让/解散）成功后回大厅。 */
async function confirmOwnerLeave() {
  leaveConfirm.value = false
  if (leaving.value) return
  leaving.value = true
  try {
    await roomStore.leaveAndClear()
  } catch { /* leaveAndClear 内部吞错，正常到不了这里 */ }
  leaving.value = false
  uni.navigateBack()
}

/** 成员主动离开入口（REST 删行 + 本地清理）。 */
async function leaveAsMember() {
  if (leaving.value) return
  leaving.value = true
  try {
    await roomStore.leaveAndClear()
  } finally {
    leaving.value = false
    uni.navigateBack()
  }
}

/** 被移出后的兜底导航（手动点「回到大厅」）。 */
function removedBackHome() {
  removedOverlay.value = false
  uni.reLaunch({ url: '/pages/home/index' })
}

const isOwner = computed(() => roomStore.isOwner)

/** 服务端已登记剧本（开局后 / 建房带 storyId / 恢复）。成员视角显示服务端登记。 */
const storyConfirmed = computed(() => roomStore.storyId !== null)

async function loadIndexedStories() {
  try {
    indexedStories.value = await getBridge().ragListStories()
  } catch {
    indexedStories.value = []
  }
}

/** 门闩提示（房主开局条）：本地未选 → 提示；已选但有人未绑卡 → 提示（与服务端 409 语义一致）。 */
const startHint = computed(() => {
  const storyIdToStart = roomStore.storyId ?? pickedStoryId.value
  if (!storyIdToStart) return '请先在等待室选定剧本'
  const unbound = roomStore.members.filter((m) => !m.characterId)
  if (unbound.length > 0) return `${unbound.length} 名成员未绑定角色卡`
  return ''
})

/** 剧本选择器打开：同步当前选择 + 刷新已索引列表（未索引不列）。 */
function openStoryPicker() {
  if (roomStore.storyId) pickedStoryId.value = roomStore.storyId
  void loadIndexedStories()
  storyPickerOpen.value = true
}

/** 房间消息流（服务端事件回灌）。 */
const displayMessages = computed(() => roomStore.messages.map((m) => roomStore.toMessage(m)))

async function loadMyCharacters() {
  try {
    myCharacters.value = await getBridge().characterList()
  } catch {
    myCharacters.value = []
  }
}

/** 打开绑卡选择器：每次进入刷新我的角色卡（可能刚建/换绑过）。 */
function openCharPicker() {
  void loadMyCharacters()
  showCharPicker.value = true
}

function send() {
  const text = chatText.value
  if (!text.trim()) return
  roomStore.sendChat(text)
  chatText.value = ''
}

// ── 房间生命周期 ──
/** 本页是否已初始化（避免 onLoad/onShow 重复 join）。 */
let joined = false

/** 5s 轮询兜底：房间解散无广播（ADR-0005/T1），轮询 roomDetail 404 → dissolved。
 *  playing 后轮询无意义（将跳 game 页），见 watch phase。 */
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollStopped = false

function startDissolvePolling() {
  stopDissolvePolling()
  pollStopped = false
  pollTimer = setInterval(async () => {
    if (pollStopped || roomStore.roomId !== roomId.value) return
    // 只有 lobby 需要轮询：playing 由 room_meta 驱动跳转（轮询打多请求无益）
    if (roomStore.phase !== 'lobby') return
    try {
      await getBridge().roomDetail(roomId.value)
    } catch {
      // 404（房间已解散）→ 标记并提示回大厅
      if (roomStore.removedReason === null) {
        roomStore.removedReason = 'dissolved'
      }
      stopDissolvePolling()
    }
  }, 5000)
}

function stopDissolvePolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** 已选剧本 id 落定（选择器确认）：本地登记，开局时随 roomStart 提交（T1 无独立选故事端点；
 *  服务端 start 门闩校验的「已选」= 请求参数 storyId 非空 + 已索引）。 */
function confirmStorySelection() {
  if (!pickedStoryId.value) return
  storyPickerOpen.value = false
}

async function startGame() {
  const storyIdToStart = roomStore.storyId ?? pickedStoryId.value
  if (!storyIdToStart) {
    toast.warning('请先在等待室选定剧本')
    return
  }
  try {
    await getBridge().roomStart(roomId.value, storyIdToStart)
    // room_meta(playing) 事件负责跳转（watch phase）；这里兜底也等一拍
  } catch (e) {
    // 服务端 409 带缺项提示 → toast（开局门闩）
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

async function confirmKick() {
  const target = kickTarget.value
  if (!target || kickBusy.value) return
  kickBusy.value = true
  try {
    await roomStore.kickMember(target.userId)
    kickTarget.value = null
    toast.success(`已将 ${target.username} 移出房间`)
  } catch {
    // kickMember 内部把错误写入 errorMessage；再给一次可见提示
    toast.error(roomStore.errorMessage || '踢出失败')
  } finally {
    kickBusy.value = false
  }
}

function openKickConfirm(m: { userId: number; username: string }) {
  kickTarget.value = m
}

async function confirmTransfer() {
  const target = transferTarget.value
  if (!target || transferBusy.value) return
  transferBusy.value = true
  try {
    await roomStore.transferOwner(target.userId)
    transferTarget.value = null
    // room_meta 后新 owner 收到「你已成为房主」提示；原房主不再显示治理区
    toast.success(`已将房主转让给 ${target.username}`)
  } catch {
    toast.error(roomStore.errorMessage || '转让失败')
  } finally {
    transferBusy.value = false
  }
}

function openTransferConfirm(m: { userId: number; username: string }) {
  transferTarget.value = m
}

async function dissolveRoom() {
  if (dissolveBusy.value) return
  dissolveBusy.value = true
  try {
    await getBridge().roomDelete(roomId.value)
    roomStore.leaveRoom()
    dissolveConfirm.value = false
    toast.success('房间已解散')
    uni.navigateBack()
  } catch (e) {
    dissolveConfirm.value = false
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    dissolveBusy.value = false
  }
}

async function bindCharacter() {
  if (!selectedCharId.value) return
  try {
    await getBridge().roomBindCharacter(roomId.value, selectedCharId.value)
    showCharPicker.value = false
    selectedCharId.value = ''
    toast.success('角色已绑定')
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

onLoad(() => {
  const rid = readRoomId()
  roomId.value = rid
  if (!rid) {
    uni.reLaunch({ url: '/pages/home/index' })
    return
  }
  if (joined) return
  joined = true
  void roomStore.joinRoom(rid)
  void loadMyCharacters()
})

/** 被移出提示（room_meta 成员资格自检 kicked / dissolved 轮询 404）→ 全屏覆盖 + 回大厅。 */
watch(() => roomStore.removedReason, (reason) => {
  if (!reason || removedOverlay.value) return
  removedKind.value = reason
  removedOverlay.value = true
  // 退订 + 本地清理（服务端已删行；leave 帧会 404，不必发）
  roomStore.leaveRoom()
  stopDissolvePolling()
})

// ── 房主转让给本人：role 变更后新 owner 看到提示 ──
watch(() => roomStore.promotedNotice, (promoted) => {
  if (!promoted) return
  toast.success('你已成为房主')
  roomStore.promotedNotice = false
})

// ── playing/ended → 离开等待室（开局成功自动跳 game 页；lobby 只在等待室）──
watch(
  () => roomStore.phase,
  (p) => {
    if (p === 'playing') {
      const storyName = encodeURIComponent(displayStoryName.value || '')
      uni.redirectTo({ url: `/pages/game/index?roomId=${encodeURIComponent(roomId.value)}&storyName=${storyName}` })
    } else if (p === 'ended') {
      uni.redirectTo({ url: '/pages/game/game-end/index' })
    }
  },
)

onMounted(() => {
  startDissolvePolling()
  // 房主若已在详情页选过故事（storyId 已带）→ 本地选择同步
  if (roomStore.storyId) pickedStoryId.value = roomStore.storyId
})

onUnmounted(() => {
  stopDissolvePolling()
})

/** 从 URL 参数读取 roomId（uni 页面参数在 onLoad；兜底 getCurrentPages）。 */
function readRoomId(): string {
  const pages = getCurrentPages()
  const cur = pages[pages.length - 1] as { options?: Record<string, string> } | undefined
  return cur?.options?.roomId ?? ''
}
</script>

<template>
  <view class="lobby-root">
    <!-- ══ 顶栏：标题 + 阶段 + 邀请码 + 治理按钮 ══ -->
    <view class="lobby-header">
      <view class="header-left">
        <text class="room-title">等待室</text>
        <text class="room-phase">{{ roomStore.phase === 'playing' ? '进行中' : '等待成员' }}</text>
        <text v-if="roomStore.inviteCode" class="room-code">邀请码 {{ roomStore.inviteCode }}</text>
      </view>
      <view class="header-right">
        <button v-if="isOwner" class="mini-btn danger-btn" @click="dissolveConfirm = true">解散</button>
        <button v-if="isOwner" class="mini-btn" @click="leaveConfirm = true">离开</button>
        <button v-else class="mini-btn" :disabled="leaving" @click="leaveAsMember">离开</button>
      </view>
    </view>

    <view v-if="roomStore.connectionState === 'error'" class="err-banner">
      <text>{{ roomStore.errorMessage }}</text>
      <button class="mini-btn" @click="roomStore.joinRoom(roomId)">重试</button>
    </view>

    <!-- ══ 主体：等待室双栏（成员 + 准备区 / 聊天）══ -->
    <view class="lobby-body">
      <!-- 左栏：剧本 + 成员状态 + 我的绑卡/就绪 -->
      <view class="side-panel">
        <!-- 房主：剧本选择（本地已选 or 服务端登记；更换按钮同步选择） -->
        <view v-if="isOwner" class="section">
          <view class="side-title">剧本</view>
          <view v-if="displayStoryId" class="story-current">
            <text class="story-name">{{ displayStoryName || '（已选定）' }}</text>
            <button class="mini-btn" @click="openStoryPicker">更换</button>
          </view>
          <view v-else class="story-empty">
            <text class="story-empty-text">尚未选择剧本</text>
            <button class="mini-btn start-btn" @click="openStoryPicker">选择剧本</button>
          </view>
        </view>
        <!-- 成员视角：显示服务端已登记剧本（开局后可见） -->
        <view v-else-if="storyConfirmed" class="section">
          <view class="side-title">剧本</view>
          <view class="story-current">
            <text class="story-name">{{ displayStoryName || '（已选定）' }}</text>
          </view>
        </view>

        <!-- 成员列表 -->
        <view class="section">
          <view class="side-title">成员 ({{ roomStore.members.length }})</view>
          <view v-for="m in roomStore.members" :key="m.userId" class="member-row">
            <view class="member-avatar"><text>{{ m.username.charAt(0) }}</text></view>
            <view class="member-info">
              <view class="member-name-row">
                <text class="member-name">{{ m.username }}</text>
                <text v-if="m.userId === roomStore.selfUserId" class="member-self">(我)</text>
                <text class="member-role">{{ m.role === 'owner' ? '房主' : '成员' }}</text>
              </view>
              <view class="member-sub-row">
                <text class="member-bind" :class="{ 'bind-ok': !!m.characterId }">
                  {{ m.characterId ? '已绑卡' : '未绑卡' }}
                </text>
                <text v-if="m.role !== 'owner'" class="member-ready" :class="{ 'ready-on': m.ready }">
                  {{ m.ready ? '已就绪' : '未就绪' }}
                </text>
                <!-- 房主治理：对每个非自己成员 → 踢出 / 转让 -->
                <template v-if="isOwner && m.userId !== roomStore.selfUserId">
                  <button class="mini-btn danger-btn member-act" @click="openKickConfirm(m)">踢出</button>
                  <button class="mini-btn member-act" @click="openTransferConfirm(m)">转让</button>
                </template>
              </view>
            </view>
          </view>
        </view>

        <!-- 我：绑卡（开局门闩要求每名成员含房主自己绑卡）+ 就绪（仅成员有就绪语义） -->
        <view class="section me-panel">
          <view class="side-title">我的准备</view>
          <view v-if="roomStore.selfMember?.characterId" class="me-bound">
            <text class="me-bound-text">已绑定角色卡</text>
            <button class="mini-btn" @click="openCharPicker">换绑</button>
          </view>
          <view v-else class="me-unbound">
            <text class="me-unbound-text">未绑定角色卡 — 全员绑定后房主才能开局</text>
            <button class="mini-btn start-btn bind-btn" @click="openCharPicker">绑定角色卡</button>
          </view>
          <view v-if="roomStore.selfMember?.characterId && !isOwner" class="ready-row">
            <button
              class="mini-btn"
              :class="roomStore.selfReady ? 'ready-btn-on' : 'ready-btn'"
              :disabled="roomStore.selfReady"
              @click="roomStore.setReady(true)"
            >就绪</button>
            <button
              v-if="roomStore.selfReady"
              class="mini-btn"
              @click="roomStore.setReady(false)"
            >取消就绪</button>
          </view>
        </view>

        <!-- 房主开局条（房主自己绑卡后 + 全员绑卡 + 已选剧本 → 可开始） -->
        <view v-if="isOwner" class="section start-panel">
          <text v-if="startHint" class="start-hint">{{ startHint }}</text>
          <button class="gothic-btn start-game-btn" :disabled="!!startHint" @click="startGame">开始游戏</button>
        </view>
      </view>

      <!-- 右栏：lobby 聊天（不触发 KP 由服务端 gate） -->
      <view class="main-panel">
        <view class="chat-list">
          <view v-if="roomStore.messages.length === 0" class="chat-empty">
            等待室里一片寂静……和队友聊两句，或等房主宣布剧本。
          </view>
          <view
            v-for="msg in displayMessages"
            :key="msg.id"
            class="msg-wrap"
            :id="'msg-' + msg.id"
          >
            <chat-message :msg="msg" />
          </view>
        </view>

        <view class="chat-input-row">
          <input
            v-model="chatText"
            class="chat-input"
            placeholder="说点什么…（lobby 聊天不会触发 KP）"
            confirm-type="send"
            @confirm="send"
          />
          <button class="gothic-btn send-btn" @click="send">发送</button>
        </view>
      </view>
    </view>

    <!-- 剧本选择弹层（已索引故事——未索引不列） -->
    <view v-if="storyPickerOpen" class="picker-mask" @click="storyPickerOpen = false">
      <view class="picker" @click.stop>
        <view class="picker-title">选择剧本（仅显示已索引故事）</view>
        <scroll-view class="picker-scroll" scroll-y>
          <view
            v-for="s in indexedStories"
            :key="s.storyId"
            class="story-option"
            :class="{ active: pickedStoryId === s.storyId }"
            @click="pickedStoryId = s.storyId"
          >
            <text class="story-option-name">{{ s.name }}</text>
            <text class="story-option-meta">{{ s.chunkCount }} 段</text>
          </view>
          <view v-if="indexedStories.length === 0" class="picker-empty">
            暂无已索引故事 — 请先到「故事管理」导入并索引剧本
          </view>
        </scroll-view>
        <view class="picker-foot">
          <button class="btn btn-ghost picker-btn" @click="storyPickerOpen = false">取消</button>
          <button
            class="btn btn-primary picker-btn"
            :disabled="!pickedStoryId"
            @click="confirmStorySelection"
          >确定</button>
        </view>
      </view>
    </view>

    <!-- 角色卡选择弹层 -->
    <view v-if="showCharPicker" class="picker-mask" @click="showCharPicker = false">
      <view class="picker" @click.stop>
        <view class="picker-title">选择要绑定的角色卡</view>
        <scroll-view class="picker-scroll" scroll-y>
          <view
            v-for="c in myCharacters"
            :key="c.id"
            class="char-option"
            :class="{ active: selectedCharId === c.id }"
            @click="selectedCharId = c.id"
          >
            <text>{{ c.name }}</text>
          </view>
          <view v-if="myCharacters.length === 0" class="picker-empty">
            暂无角色卡 — 请先到「创建角色」制作一张
          </view>
        </scroll-view>
        <view class="picker-foot">
          <button class="btn btn-ghost picker-btn" @click="showCharPicker = false">取消</button>
          <button class="btn btn-primary picker-btn" :disabled="!selectedCharId" @click="bindCharacter">确认绑定</button>
        </view>
      </view>
    </view>

    <!-- 房主离开确认 -->
    <confirm-modal
      v-if="leaveConfirm"
      title="离开房间"
      message="你是房主：离开后房主将立即转让给最早加入的成员（无其他成员则房间解散）。"
      confirm-text="离开房间"
      tone="warning"
      :loading="leaving"
      @cancel="leaveConfirm = false"
      @confirm="confirmOwnerLeave"
    />

    <!-- 踢出确认 -->
    <confirm-modal
      v-if="kickTarget"
      title="踢出成员"
      :message="`确定将 ${kickTarget.username} 移出房间？对方会收到提示并返回大厅。`"
      confirm-text="踢出"
      tone="danger"
      :loading="kickBusy"
      @cancel="kickTarget = null"
      @confirm="confirmKick"
    />

    <!-- 转让确认 -->
    <confirm-modal
      v-if="transferTarget"
      title="转让房主"
      :message="`确定将房主转让给 ${transferTarget.username}？转让后你将失去治理权限。`"
      confirm-text="转让"
      tone="warning"
      :loading="transferBusy"
      @cancel="transferTarget = null"
      @confirm="confirmTransfer"
    />

    <!-- 解散确认 -->
    <confirm-modal
      v-if="dissolveConfirm"
      title="解散房间"
      message="房间将被永久解散，所有成员将被移出。此操作不可撤销。"
      confirm-text="解散房间"
      :loading="dissolveBusy"
      @cancel="dissolveConfirm = false"
      @confirm="dissolveRoom"
    />

    <!-- 被移出全屏提示（踢出 / 解散） -->
    <view v-if="removedOverlay" class="removed-mask">
      <view class="removed-card">
        <text class="removed-title">{{ removedKind === 'dissolved' ? '房间已解散' : '你已被移出房间' }}</text>
        <text class="removed-desc">
          {{ removedKind === 'dissolved' ? '房主解散了房间，你已回到大厅。' : '房主将你移出了队伍，你已回到大厅。' }}
        </text>
        <button class="gothic-btn" @click="removedBackHome">回到大厅</button>
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.lobby-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background:
    radial-gradient(ellipse at top, hsla(165, 30%, 12%, 0.4), transparent 60%),
    #080a0c;
  color: hsl(38, 40%, 80%);
  overflow: hidden;
}

/* ── 顶栏 ── */
.lobby-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid hsla(220, 14%, 16%, 0.8);
  background: rgba(0, 0, 0, 0.5);
  flex-wrap: wrap;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.room-title {
  font-family: $font-display;
  font-size: 1.125rem;
  font-weight: bold;
  color: hsl(38, 50%, 88%);
}
.room-phase {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid hsla(165, 50%, 30%, 0.4);
  color: hsl(165, 50%, 70%);
}
.room-code {
  font-size: 12px;
  font-family: $font-mono;
  color: hsl(42, 50%, 70%);
}
.header-right {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.mini-btn {
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid hsla(220, 14%, 20%, 0.8);
  color: hsl(220, 20%, 70%);
}
.mini-btn:disabled {
  opacity: 0.45;
  pointer-events: none;
}
.start-btn {
  color: hsl(165, 50%, 70%);
  border-color: hsla(165, 50%, 30%, 0.5);
}
.danger-btn {
  color: hsl(0, 50%, 65%);
  border-color: hsla(0, 50%, 30%, 0.5);
}

/* ── 错误横幅 ── */
.err-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  background: hsla(0, 50%, 15%, 0.5);
  color: hsl(0, 55%, 75%);
  font-size: 0.875rem;
}

/* ── 主体双栏（桌面固定；移动端上下滚动不溢出） ── */
.lobby-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.side-panel {
  width: 280px;
  flex-shrink: 0;
  padding: 14px 16px;
  border-right: 1px solid hsla(220, 14%, 16%, 0.8);
  overflow-y: auto;
  box-sizing: border-box;
}
.section {
  margin-bottom: 18px;
}
.side-title {
  font-family: $font-display;
  font-size: 0.875rem;
  color: hsl(38, 40%, 70%);
  margin-bottom: 10px;
  letter-spacing: 0.05em;
}

/* 剧本 */
.story-current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid hsla(165, 45%, 25%, 0.35);
}
.story-name {
  font-size: 0.8125rem;
  color: hsl(165, 50%, 75%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.story-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.story-empty-text {
  font-size: 0.8125rem;
  color: hsl(38, 30%, 55%);
  font-style: italic;
}

/* 成员行 */
.member-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid hsla(220, 14%, 14%, 0.4);
}
.member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  background: hsla(165, 45%, 22%, 0.5);
  border: 1px solid hsla(165, 55%, 28%, 0.4);
  color: hsl(165, 50%, 78%);
}
.member-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.member-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.member-name {
  font-size: 0.875rem;
  color: hsl(38, 40%, 80%);
}
.member-self {
  font-size: 11px;
  color: hsl(220, 10%, 45%);
}
.member-role {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 9999px;
  border: 1px solid hsla(165, 50%, 30%, 0.35);
  color: hsl(165, 50%, 70%);
}
.member-sub-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.member-bind {
  font-size: 11px;
  color: hsl(0, 30%, 55%);
}
.member-bind.bind-ok {
  color: hsl(165, 45%, 65%);
}
.member-ready {
  font-size: 11px;
  color: hsl(220, 10%, 40%);
}
.member-ready.ready-on {
  color: hsl(165, 60%, 65%);
}
.member-act {
  padding: 2px 8px;
  font-size: 11px;
}

/* 我的准备（成员） */
.me-panel {
  padding-top: 12px;
  border-top: 1px solid hsla(220, 14%, 16%, 0.7);
}
.me-bound {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.me-bound-text {
  font-size: 0.8125rem;
  color: hsl(165, 50%, 70%);
}
.me-unbound {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.me-unbound-text {
  font-size: 0.8125rem;
  color: hsl(38, 25%, 50%);
}
.bind-btn {
  align-self: flex-start;
}
.ready-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.ready-btn-on {
  color: hsl(165, 50%, 70%);
  border-color: hsla(165, 50%, 30%, 0.5);
}

/* 房主开局条 */
.start-panel {
  padding-top: 12px;
  border-top: 1px solid hsla(220, 14%, 16%, 0.7);
}
.start-hint {
  display: block;
  font-size: 12px;
  color: hsl(42, 60%, 60%);
  margin-bottom: 8px;
  font-style: italic;
}
.start-game-btn {
  width: 100%;
}

/* 聊天区 */
.main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.msg-wrap {
  width: 100%;
}
.chat-empty {
  color: hsl(220, 10%, 35%);
  font-style: italic;
  font-family: $font-serif;
  text-align: center;
  padding: 40px 0;
}
.chat-input-row {
  display: flex;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid hsla(220, 14%, 16%, 0.8);
  background: rgba(0, 0, 0, 0.5);
}
.chat-input {
  flex: 1;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid hsla(220, 14%, 20%, 0.8);
  border-radius: 0.5rem;
  color: hsl(38, 40%, 80%);
  padding: 10px 14px;
  font-size: 0.9375rem;
}
.send-btn {
  flex-shrink: 0;
}

/* ── 弹层（选择器共用） ── */
.picker-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 24px;
  box-sizing: border-box;
}
.picker {
  width: 340px;
  max-width: 100%;
  max-height: 76vh;
  display: flex;
  flex-direction: column;
  background: #0d1114;
  border: 1px solid hsla(220, 14%, 20%, 0.8);
  border-radius: 0.75rem;
  padding: 18px;
  box-sizing: border-box;
}
.picker-title {
  font-family: $font-display;
  font-size: 1rem;
  color: hsl(38, 50%, 88%);
  margin-bottom: 12px;
}
.picker-scroll {
  flex: 1;
  min-height: 0;
  max-height: 46vh;
}
.story-option,
.char-option {
  padding: 10px 12px;
  border-radius: 0.5rem;
  border: 1px solid hsla(220, 14%, 18%, 0.8);
  margin-bottom: 8px;
  color: hsl(38, 35%, 75%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.story-option.active,
.char-option.active {
  border-color: hsla(165, 50%, 35%, 0.6);
  background: hsla(165, 30%, 12%, 0.5);
}
.story-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.story-option-meta {
  flex-shrink: 0;
  font-size: 11px;
  color: hsl(220, 10%, 40%);
}
.picker-empty {
  color: hsl(220, 10%, 40%);
  font-size: 0.875rem;
  padding: 12px 0;
}
.picker-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}
.picker-btn {
  min-width: 88px;
  padding: 0 14px;
  height: 40px;
  font-size: 13px;
}

/* ── 被移出覆盖层 ── */
.removed-mask {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 10, 12, 0.86);
  padding: 24px;
  box-sizing: border-box;
}
.removed-card {
  width: 340px;
  max-width: 100%;
  background: #0d1114;
  border: 1px solid hsla(220, 14%, 20%, 0.8);
  border-radius: 0.75rem;
  padding: 24px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
}
.removed-title {
  font-family: $font-display;
  font-size: 1.125rem;
  color: hsl(0, 50%, 70%);
}
.removed-desc {
  font-size: 0.875rem;
  line-height: 1.6;
  color: hsl(38, 30%, 60%);
  font-family: $font-serif;
}

/* ── 移动端：双栏改上下滚动（成员操作不溢出） ── */
@media (max-width: 767px) {
  .lobby-root {
    overflow-y: auto;
  }
  .lobby-header {
    padding: 10px 12px;
    position: sticky;
    top: 0;
    z-index: 20;
    background: rgba(5, 7, 9, 0.94);
  }
  .lobby-body {
    flex-direction: column;
    overflow-y: visible;
  }
  .side-panel {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid hsla(220, 14%, 16%, 0.8);
    max-height: none;
    overflow-y: visible;
  }
  .main-panel {
    min-height: 300px;
  }
  .chat-list {
    padding: 14px;
  }
}
</style>
