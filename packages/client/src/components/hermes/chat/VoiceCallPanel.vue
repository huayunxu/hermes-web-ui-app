<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import { useChatStore, type Message } from '@/stores/hermes/chat'
import { useSpeechRecognition } from '@/composables/useSpeechRecognition'
import { useGlobalSpeech } from '@/composables/useSpeech'

const emit = defineEmits<{
  close: []
}>()

type CallState = 'listening' | 'sending' | 'thinking' | 'speaking' | 'paused' | 'unsupported'

const chatStore = useChatStore()
const toast = useMessage()
const speech = useGlobalSpeech()
const recognition = useSpeechRecognition('zh-CN')

const callActive = ref(false)
const callState = ref<CallState>('paused')
const lastSentTranscriptLength = ref(0)
const lastUserSentAt = ref(0)
const playedAssistantIds = ref<Set<string>>(new Set())
const liveCaption = ref('')
const lastUserText = ref('')
const lastAssistantText = ref('')
const sendTimer = ref<number | null>(null)
const restartTimer = ref<number | null>(null)
const wasSpeaking = ref(false)

const statusText = computed(() => {
  if (callState.value === 'unsupported') return '当前 WebView 不支持语音识别'
  if (callState.value === 'listening') return '正在听你说'
  if (callState.value === 'sending') return '正在发送'
  if (callState.value === 'thinking') return 'Hermes 正在思考'
  if (callState.value === 'speaking') return 'Hermes 正在说话'
  return '已暂停'
})

const canListen = computed(() => recognition.isSupported.value && callActive.value)

function clearTimers() {
  if (sendTimer.value) window.clearTimeout(sendTimer.value)
  if (restartTimer.value) window.clearTimeout(restartTimer.value)
  sendTimer.value = null
  restartTimer.value = null
}

function startListening() {
  if (!canListen.value) return
  if (chatStore.isRunActive || speech.isPlaying.value || speech.isCustomPlaying.value) return
  recognition.reset()
  lastSentTranscriptLength.value = 0
  liveCaption.value = ''
  recognition.start('zh-CN')
  callState.value = 'listening'
}

function stopListening() {
  recognition.stop()
}

function scheduleListenRestart(delay = 450) {
  if (!callActive.value) return
  if (restartTimer.value) window.clearTimeout(restartTimer.value)
  restartTimer.value = window.setTimeout(() => {
    if (!callActive.value) return
    if (chatStore.isRunActive || speech.isPlaying.value || speech.isCustomPlaying.value) return
    startListening()
  }, delay)
}

function pendingTranscript(): string {
  const transcript = recognition.transcript.value
  return transcript.slice(lastSentTranscriptLength.value).trim()
}

function scheduleSend() {
  if (!callActive.value || callState.value !== 'listening') return
  const text = pendingTranscript()
  liveCaption.value = `${text}${recognition.interim.value}`.trim()
  if (!text) return
  if (sendTimer.value) window.clearTimeout(sendTimer.value)
  sendTimer.value = window.setTimeout(() => {
    void sendCurrentTranscript()
  }, 900)
}

async function sendCurrentTranscript() {
  if (!callActive.value) return
  const text = pendingTranscript()
  if (!text || chatStore.isRunActive) return

  if (sendTimer.value) window.clearTimeout(sendTimer.value)
  sendTimer.value = null
  lastSentTranscriptLength.value = recognition.transcript.value.length
  stopListening()
  callState.value = 'sending'
  lastUserText.value = text
  lastUserSentAt.value = Date.now()

  try {
    await chatStore.sendMessage(text)
    callState.value = 'thinking'
  } catch (err: any) {
    toast.error(err?.message || '发送失败')
    scheduleListenRestart(800)
  }
}

function latestFinishedAssistant(): Message | null {
  const messages = [...chatStore.messages].reverse()
  return messages.find(message =>
    message.role === 'assistant' &&
    !message.isStreaming &&
    message.timestamp >= lastUserSentAt.value &&
    !!message.content.trim() &&
    !playedAssistantIds.value.has(message.id),
  ) || null
}

function playAssistant(message: Message) {
  playedAssistantIds.value = new Set([...playedAssistantIds.value, message.id])
  lastAssistantText.value = speech.extractReadableText(message.content)
  if (!lastAssistantText.value) {
    scheduleListenRestart()
    return
  }
  callState.value = 'speaking'
  speech.stop()
  speech.play(message.id, message.content, { lang: 'zh-CN' })
}

function startCall() {
  if (!recognition.isSupported.value) {
    callState.value = 'unsupported'
    toast.warning('当前 WebView 不支持语音识别')
    return
  }
  callActive.value = true
  playedAssistantIds.value = new Set()
  lastUserSentAt.value = Date.now()
  nextTick(startListening)
}

function endCall() {
  callActive.value = false
  clearTimers()
  stopListening()
  speech.stop()
  callState.value = 'paused'
  emit('close')
}

watch([recognition.transcript, recognition.interim], scheduleSend)

watch(
  () => chatStore.messages.map(message => `${message.id}:${message.content.length}:${message.isStreaming ? 1 : 0}`).join('|'),
  () => {
    if (!callActive.value || lastUserSentAt.value === 0) return
    const assistant = latestFinishedAssistant()
    if (assistant) playAssistant(assistant)
  },
)

watch(
  () => speech.isPlaying.value || speech.isCustomPlaying.value,
  (playing) => {
    if (playing) {
      wasSpeaking.value = true
      return
    }
    if (!wasSpeaking.value) return
    wasSpeaking.value = false
    if (!callActive.value) return
    scheduleListenRestart(650)
  },
)

watch(
  () => chatStore.isRunActive,
  (running) => {
    if (!callActive.value) return
    if (running) {
      stopListening()
      callState.value = 'thinking'
      return
    }
    if (callState.value === 'thinking') {
      const assistant = latestFinishedAssistant()
      if (assistant) playAssistant(assistant)
      else scheduleListenRestart(900)
    }
  },
)

onMounted(startCall)

onUnmounted(() => {
  callActive.value = false
  clearTimers()
  stopListening()
})
</script>

<template>
  <div class="voice-call-panel">
    <div class="voice-call-bg" aria-hidden="true"></div>
    <div class="voice-call-content">
      <div class="voice-orb" :class="callState">
        <span></span>
      </div>
      <div class="voice-state">{{ statusText }}</div>
      <div class="voice-caption">
        <template v-if="callState === 'listening'">
          {{ liveCaption || '直接说话，我会自动发送。' }}
        </template>
        <template v-else-if="lastAssistantText">
          {{ lastAssistantText }}
        </template>
        <template v-else-if="lastUserText">
          {{ lastUserText }}
        </template>
        <template v-else>
          语音通话已连接
        </template>
      </div>

      <div class="voice-call-controls">
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              circle
              size="large"
              class="control-button"
              :disabled="callState === 'unsupported'"
              @click="callState === 'listening' ? stopListening() : startListening()"
            >
              <template #icon>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <path d="M12 19v3" />
                </svg>
              </template>
            </NButton>
          </template>
          {{ callState === 'listening' ? '暂停聆听' : '继续聆听' }}
        </NTooltip>

        <NTooltip trigger="hover">
          <template #trigger>
            <NButton circle size="large" type="error" class="control-button end" @click="endCall">
              <template #icon>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.77.63 2.6a2 2 0 0 1-.45 2.11L8.1 9.9a16 16 0 0 0 6 6l1.47-1.19a2 2 0 0 1 2.11-.45c.83.3 1.7.51 2.6.63A2 2 0 0 1 22 16.92Z" />
                </svg>
              </template>
            </NButton>
          </template>
          结束通话
        </NTooltip>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.voice-call-panel {
  position: absolute;
  inset: 0;
  z-index: 40;
  overflow: hidden;
  background: #101113;
  color: #f8fafc;
}

.voice-call-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 50% 24%, rgba(56, 189, 248, 0.22), transparent 34%),
    linear-gradient(160deg, #101113 0%, #172033 48%, #111827 100%);
}

.voice-call-content {
  position: relative;
  z-index: 1;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 22px;
  padding: 28px;
  text-align: center;
}

.voice-orb {
  width: 148px;
  height: 148px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.35);

  span {
    width: 82px;
    height: 82px;
    border-radius: 50%;
    background: linear-gradient(135deg, #38bdf8, #f472b6);
    box-shadow: 0 0 48px rgba(56, 189, 248, 0.55);
  }

  &.listening span,
  &.speaking span {
    animation: pulse 1.35s ease-in-out infinite;
  }

  &.thinking span,
  &.sending span {
    animation: pulse 0.85s ease-in-out infinite;
    background: linear-gradient(135deg, #f59e0b, #22c55e);
  }
}

.voice-state {
  font-size: 20px;
  font-weight: 700;
}

.voice-caption {
  width: min(620px, 100%);
  min-height: 92px;
  max-height: 180px;
  overflow: hidden;
  color: rgba(248, 250, 252, 0.82);
  font-size: 17px;
  line-height: 1.7;
}

.voice-call-controls {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 12px;
}

.control-button {
  width: 58px;
  height: 58px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  border-color: rgba(255, 255, 255, 0.2);

  &.end {
    background: #ef4444;
  }
}

@keyframes pulse {
  0%, 100% {
    transform: scale(0.92);
  }
  50% {
    transform: scale(1.08);
  }
}

@media (max-width: 768px) {
  .voice-call-content {
    justify-content: space-between;
    padding: 72px 22px 42px;
  }

  .voice-orb {
    width: 132px;
    height: 132px;
  }
}
</style>
