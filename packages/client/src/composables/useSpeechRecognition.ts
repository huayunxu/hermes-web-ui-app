import { ref, computed, readonly } from 'vue'

export type RecognitionState = 'idle' | 'listening' | 'error' | 'not-supported'

export interface SpeechRecognitionOptions {
  lang: string
  continuous: boolean
  interimResults: boolean
}

/**
 * SpeechRecognition composable using the browser Web Speech API
 *
 * Uses `webkitSpeechRecognition` which works in Chrome, Edge,
 * and Android Chrome WebView (Capacitor).
 */
export function useSpeechRecognition(defaultLang = 'zh-CN') {
  const state = ref<RecognitionState>('idle')
  const transcript = ref('')
  const interim = ref('')
  const errorMessage = ref('')
  const currentLang = ref(defaultLang)

  let recognition: SpeechRecognition | null = null
  let recognitionCleanup: (() => void) | null = null

  const isSupported = computed(() => {
    return !!(
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition
    )
  })

  const isListening = computed(() => state.value === 'listening')

  function buildRecognition(lang: string): SpeechRecognition {
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition
    const r = new SR()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    r.maxAlternatives = 1
    return r
  }

  function start(lang?: string) {
    if (!isSupported.value) {
      state.value = 'not-supported'
      errorMessage.value = 'SpeechRecognition not available'
      return
    }

    if (isListening.value) return

    const targetLang = lang || currentLang.value
    currentLang.value = targetLang

    transcript.value = ''
    interim.value = ''
    errorMessage.value = ''

    try {
      recognition = buildRecognition(targetLang)

      recognition.onstart = () => {
        state.value = 'listening'
      }

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let interimText = ''
        let finalText = ''

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          if (result.isFinal) {
            finalText += result[0].transcript
          } else {
            interimText += result[0].transcript
          }
        }

        if (finalText) {
          transcript.value += finalText
        }
        interim.value = interimText
      }

      recognition.onerror = (event: any) => {
        // Ignore 'no-speech' — user might just be quiet; don't show as error UI
        if (event.error === 'no-speech') {
          recognition?.stop()
          // For continuous mode, silently restart; for non-continuous, go idle
          if (recognition) {
            try {
              recognition.start()
              return
            } catch {
              // Already stopped, just update state
            }
          }
          return
        }

        state.value = 'error'

        if (event.error === 'not-allowed') {
          errorMessage.value = 'Microphone access denied'
        } else if (event.error === 'aborted') {
          errorMessage.value = 'Recognition aborted'
        } else if (event.error === 'network') {
          errorMessage.value = 'Network error'
        } else if (event.error === 'language-not-supported') {
          errorMessage.value = `Language "${targetLang}" not supported`
        } else if (event.error === 'service-not-allowed') {
          errorMessage.value = 'Service not allowed'
        } else {
          errorMessage.value = `Recognition error: ${event.error}`
        }
      }

      recognition.onend = () => {
        // If we're still in the listening state (user didn't explicitly stop),
        // restart automatically for continuous dictation experience
        if (state.value === 'listening') {
          try {
            recognition?.start()
          } catch {
            state.value = 'idle'
          }
        } else {
          state.value = 'idle'
        }
      }

      recognition.start()
    } catch (err: any) {
      state.value = 'error'
      errorMessage.value = err.message || 'Failed to start speech recognition'
    }
  }

  function stop() {
    if (recognition) {
      // Mark as idle BEFORE calling stop() so onend doesn't auto-restart
      state.value = 'idle'
      try {
        recognition.stop()
      } catch {
        // Already stopped
      }
    }
    // Grab any remaining interim as final
    if (interim.value) {
      transcript.value += interim.value
      interim.value = ''
    }
    recognition = null
  }

  function toggle(lang?: string) {
    if (isListening.value) {
      stop()
    } else {
      start(lang)
    }
  }

  function reset() {
    stop()
    transcript.value = ''
    interim.value = ''
    errorMessage.value = ''
    state.value = 'idle'
  }

  function destroy() {
    if (recognitionCleanup) {
      recognitionCleanup()
      recognitionCleanup = null
    }
    if (recognition) {
      reset()
    }
  }

  return {
    state: readonly(state) as typeof state,
    transcript: readonly(transcript) as typeof transcript,
    interim: readonly(interim) as typeof interim,
    errorMessage: readonly(errorMessage) as typeof errorMessage,
    currentLang: readonly(currentLang) as typeof currentLang,
    isSupported,
    isListening,
    start,
    stop,
    toggle,
    reset,
    destroy,
  }
}