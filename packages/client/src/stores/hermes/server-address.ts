import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

const STORAGE_KEY_LAN = 'hermes_lan_address'
const STORAGE_KEY_WAN = 'hermes_wan_address'
const STORAGE_KEY_LAST_SUCCESS = 'hermes_last_successful_address'

function loadFromStorage(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

function saveToStorage(key: string, value: string) {
  try {
    if (value) {
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    // storage unavailable — silently ignore
  }
}

export const useServerAddressStore = defineStore('server-address', () => {
  const lanAddress = ref(loadFromStorage(STORAGE_KEY_LAN, ''))
  const wanAddress = ref(loadFromStorage(STORAGE_KEY_WAN, ''))
  const lastSuccessfulAddress = ref(loadFromStorage(STORAGE_KEY_LAST_SUCCESS, ''))

  function persist() {
    saveToStorage(STORAGE_KEY_LAN, lanAddress.value)
    saveToStorage(STORAGE_KEY_WAN, wanAddress.value)
  }

  function setLastSuccessful(addr: string) {
    lastSuccessfulAddress.value = addr
    saveToStorage(STORAGE_KEY_LAST_SUCCESS, addr)
  }

  function getDefaultBase(): string {
    return lastSuccessfulAddress.value || lanAddress.value || wanAddress.value || ''
  }

  // Auto-persist on change
  watch([lanAddress, wanAddress], persist, { deep: false })

  return {
    lanAddress,
    wanAddress,
    lastSuccessfulAddress,
    setLastSuccessful,
    getDefaultBase,
  }
})