<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NTooltip, useMessage } from 'naive-ui'
import { useChatStore, type Message, type Attachment } from '@/stores/hermes/chat'
import { useSpeechRecognition } from '@/composables/useSpeechRecognition'
import { useGlobalSpeech } from '@/composables/useSpeech'

const emit = defineEmits<{
  close: []
}>()

type CallState = 'connecting' | 'listening' | 'sending' | 'thinking' | 'speaking' | 'paused' | 'unsupported' | 'camera-error'

const chatStore = useChatStore()
const toast = useMessage()
const speech = useGlobalSpeech()
const recognition = useSpeechRecognition('zh-CN')

// Show toast on STT errors
recognition.onError((errMsg, code) => {
  console.error('[VideoCall] STT error:', code, errMsg)
  toast.error(`语音识别错误: ${errMsg}`)
  if (code === 'not-allowed') {
    callState.value = 'unsupported'
  }
})

const callActive = ref(false)
const callState = ref<CallState>('connecting')
const lastSentTranscriptLength = ref(0)
const lastUserSentAt = ref(0)
const playedAssistantIds = ref<Set<string>>(new Set())
const liveCaption = ref('')
const lastUserText = ref('')
const lastAssistantText = ref('')
const sendTimer = ref<number | null>(null)
const restartTimer = ref<number | null>(null)
const wasSpeaking = ref(false)
const cameraFacing = ref<'user' | 'environment'>('user')

// Camera refs
const videoPreview = ref<HTMLVideoElement | null>(null)
const canvasCapture = ref<HTMLCanvasElement | null>(null)
let mediaStream: MediaStream | null = null

const statusText = computed(() => {
  if (callState.value === 'unsupported') return '当前 WebView 不支持语音识别'
  if (callState.value === 'camera-error') return '无法访问摄像头'
  if (callState.value === 'connecting') return '正在打开摄像头...'
  if (callState.value === 'listening') return '正在听你说'
  if (callState.value === 'sending') return '正在发送'
  if (callState.value === 'thinking') return 'Hermes 正在思考'
  if (callState.value === 'speaking') return 'Hermes 正在说话'
  return '已暂停'
})

const canListen = computed(() => recognition.isSupported.value && callActive.value && callState.value !== 'connecting' && callState.value !== 'camera-error')

function clearTimers() {
  if (sendTimer.value) window.clearTimeout(sendTimer.value)
  if (restartTimer.value) window.clearTimeout(restartTimer.value)
  sendTimer.value = null
  restartTimer.value = null
}

async function startCamera() {
  try {
    // Stop existing stream
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop())
      mediaStream = null
    }

    const constraints: MediaStreamConstraints = {
      video: {
        facingMode: cameraFacing.value,
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    }

    mediaStream = await navigator.mediaDevices.getUserMedia(constraints)

    if (videoPreview.value) {
      videoPreview.value.srcObject = mediaStream
      await videoPreview.value.play()
    }

    callState.value = 'paused'
    return true
  } catch (err: any) {
    console.error('[VideoCall] Camera error:', err)
    callState.value = 'camera-error'
    toast.error(`摄像头访问失败: ${err.message || '未知错误'}`)
    return false
  }
}

async function switchCamera() {
  cameraFacing.value = cameraFacing.value === 'user' ? 'environment' : 'user'
  await startCamera()
}

function captureFrame(): File | null {
  const video = videoPreview.value
  const canvas = canvasCapture.value
  if (!video || !canvas) return null

  canvas.width = video.videoWidth || 640
  canvas.height = video.videoHeight || 480

  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

  // Convert to blob synchronously via dataURL
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
  const byteStr = atob(dataUrl.split(',')[1])
  const bytes = new Uint8Array(byteStr.length)
  for (let i = 0; i < byteStr.length; i++) {
    bytes[i] = byteStr.charCodeAt(i)
  }
  const blob = new Blob([bytes], { type: 'image/jpeg' })
  return new File([blob], `frame-${Date.now()}.jpg`, { type: 'image/jpeg' })
}

function startListening() {
  if (!canListen.value) {
    if (!recognition.isSupported.value) {
      toast.error('当前环境不支持语音识别，请检查浏览器或WebView版本')
      callState.value = 'unsupported'
    }
    return
  }
  if (chatStore.isRunActive || speech.isPlaying.value || speech.isCustomPlaying.value) return
  recognition.reset()
  lastSentTranscriptLength.value = 0
  liveCaption.value = ''
  try {
    recognition.start('zh-CN')
    callState.value = 'listening'
  } catch (err: any) {
    console.error('[VideoCall] Failed to start STT:', err)
    toast.error(`语音识别启动失败: ${err.message || '未知错误'}`)
  }
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
    // Capture a frame from the camera
    const frame = captureFrame()
    if (frame) {
      const attachments: Attachment[] = [{
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name: frame.name,
        type: frame.type,
        size: frame.size,
        url: URL.createObjectURL(frame),
        file: frame,
      }]
      await chatStore.sendMessage(text, attachments)
    } else {
      await chatStore.sendMessage(text)
    }
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

async function startCall() {
  if (!recognition.isSupported.value) {
    callState.value = 'unsupported'
    toast.warning('当前 WebView 不支持语音识别')
    return
  }
  callActive.value = true
  playedAssistantIds.value = new Set()
  lastUserSentAt.value = Date.now()

  const cameraOk = await startCamera()
  if (cameraOk) {
    nextTick(startListening)
  }
}

function endCall() {
  callActive.value = false
  clearTimers()
  stopListening()
  speech.stop()

  // Stop camera
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop())
    mediaStream = null
  }
  if (videoPreview.value) {
    videoPreview.value.srcObject = null
  }

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
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop())
    mediaStream = null
  }
})
</script>

<template>
  <div class="video-call-panel">
    <div class="video-call-bg" aria-hidden="true"></div>
    <div class="video-call-content">
      <!-- Camera preview -->
      <div class="camera-container">
        <video
          ref="videoPreview"
          class="camera-preview"
          :class="{ mirrored: cameraFacing === 'user' }"
          autoplay
          muted
          playsinline
        />
        <canvas ref="canvasCapture" class="capture-canvas" />

        <!-- State overlay on camera -->
        <div class="camera-overlay">
          <div class="voice-orb-small" :class="callState">
            <span></span>
          </div>
        </div>
      </div>

      <div class="video-state">{{ statusText }}</div>
      <div class="video-caption">
        <template v-if="callState === 'listening'">
          {{ liveCaption || '直接说话，我会自动发送并拍照。' }}
        </template>
        <template v-else-if="lastAssistantText">
          {{ lastAssistantText }}
        </template>
        <template v-else-if="lastUserText">
          {{ lastUserText }}
        </template>
        <template v-else>
          视频通话已连接 — 我能看到你
        </template>
      </div>

      <div class="video-call-controls">
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton
              circle
              size="large"
              class="control-button"
              :disabled="callState === 'unsupported' || callState === 'camera-error'"
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
            <NButton
              circle
              size="large"
              class="control-button"
              @click="switchCamera"
            >
              <template #icon>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                  <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
                  <path d="m15 3-3 3 3 3" />
                  <path d="m9 21 3-3-3-3" />
                </svg>
              </template>
            </NButton>
          </template>
          切换摄像头
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

.video-call-panel {
  position: absolute;
  inset: 0;
  z-index: 40;
  overflow: hidden;
  background: #101113;
  color: #f8fafc;
}

.video-call-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 50% 24%, rgba(139, 92, 246, 0.18), transparent 34%),
    linear-gradient(160deg, #101113 0%, #1a1033 48%, #111827 100%);
}

.video-call-content {
  position: relative;
  z-index: 1;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 28px;
  text-align: center;
}

.camera-container {
  position: relative;
  width: min(480px, 100%);
  aspect-ratio: 4 / 3;
  border-radius: 16px;
  overflow: hidden;
  background: #1a1a2e;
  border: 2px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
}

.camera-preview {
  width: 100%;
  height: 100%;
  object-fit: cover;

  &.mirrored {
    transform: scaleX(-1);
  }
}

.capture-canvas {
  display: none;
}

.camera-overlay {
  position: absolute;
  bottom: 12px;
  right: 12px;
  pointer-events: none;
}

.voice-orb-small {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.2);

  span {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: linear-gradient(135deg, #8b5cf6, #ec4899);
    box-shadow: 0 0 24px rgba(139, 92, 246, 0.55);
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

.video-state {
  font-size: 18px;
  font-weight: 700;
}

.video-caption {
  width: min(620px, 100%);
  min-height: 72px;
  max-height: 140px;
  overflow: hidden;
  color: rgba(248, 250, 252, 0.82);
  font-size: 16px;
  line-height: 1.7;
}

.video-call-controls {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 8px;
}

.control-button {
  width: 54px;
  height: 54px;
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
  .video-call-content {
    justify-content: space-between;
    padding: 64px 16px 36px;
  }

  .camera-container {
    width: 100%;
    max-width: 360px;
  }
}
</style>
