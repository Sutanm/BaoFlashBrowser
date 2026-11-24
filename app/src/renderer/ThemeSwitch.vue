<script setup lang="ts">
import { ref, useTemplateRef, watch, watchPostEffect } from 'vue'
import type { ThemeMode } from '../shared/settings'
import { themeModeLabels } from '../shared/settings'
import { localClockTime, themeClockSky, THEME_CLOCK_DAY } from './theme-clock'
import ThemeSwitchArtwork from './ThemeSwitchArtwork.vue'
import './theme-switch.css'

const props = defineProps<{ mode: ThemeMode; busy: boolean; compact?: boolean; paused?: boolean }>()
const emit = defineEmits<{ select: [mode: ThemeMode] }>()

const modes: ThemeMode[] = ['light', 'system', 'dark']
const stops = useTemplateRef<HTMLButtonElement[]>('stops')
const artwork = useTemplateRef('artwork')
const sky = ref(themeClockSky(localClockTime()))

function select(mode: ThemeMode): void {
  if (!props.busy && mode !== props.mode) emit('select', mode)
}

/** 鼠标点选时把焦点移到该档：否则焦点环会留在上一次聚焦的档位上（与选中态错位）。 */
function clickStop(mode: ThemeMode, event: MouseEvent): void {
  const stop = event.currentTarget
  if (stop instanceof HTMLElement) stop.focus()
  select(mode)
}

function onArrow(event: KeyboardEvent, index: number): void {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key]
  if (step === undefined) return
  event.preventDefault()
  if (props.busy) return
  const next = (index + step + modes.length) % modes.length
  stops.value?.[next]?.focus()
  select(modes[next])
}

watchPostEffect((onCleanup) => {
  const dial = artwork.value?.rotor
  if (props.mode !== 'system' || !dial) return

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const orbit = dial.animate([{ rotate: '-0.5turn' }, { rotate: '0.5turn' }], {
    duration: THEME_CLOCK_DAY, iterations: Infinity
  })

  function sync(): void {
    const time = localClockTime()
    sky.value = themeClockSky(time)
    orbit.currentTime = time
    // 飞窗隐藏时（宿主通过 paused 告知）连动画带定时器一起停：视图被 detach 后
    // 页面仍是 visible，Chromium 不会自动节流，不主动停就是白烧 CPU/GPU。
    if (props.paused || reduceMotion.matches || document.hidden) orbit.pause()
    else orbit.play()
  }

  let timer = 0
  function schedule(): void {
    if (timer) {
      window.clearInterval(timer)
      timer = 0
    }
    if (!props.paused) timer = window.setInterval(sync, 15_000)
  }

  sync()
  schedule()
  watch(() => props.paused, () => {
    sync()
    schedule()
  })
  reduceMotion.addEventListener('change', sync)
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('focus', sync)
  onCleanup(() => {
    orbit.cancel()
    if (timer) window.clearInterval(timer)
    reduceMotion.removeEventListener('change', sync)
    document.removeEventListener('visibilitychange', sync)
    window.removeEventListener('focus', sync)
  })
})
</script>

<template>
  <div
    class="bao-theme-switch"
    :class="{ 'bao-theme-switch--compact': compact }"
    :data-mode="mode"
    :style="{ '--clock-night': sky.night, '--clock-twilight': sky.twilight }"
    role="radiogroup"
    aria-label="主题"
  >
    <ThemeSwitchArtwork ref="artwork" />
    <button
      v-for="(option, index) in modes"
      :key="option"
      ref="stops"
      class="theme-stop"
      type="button"
      role="radio"
      :aria-checked="mode === option"
      :aria-disabled="busy"
      :aria-label="themeModeLabels[option]"
      :title="themeModeLabels[option]"
      :tabindex="mode === option ? 0 : -1"
      @click="clickStop(option, $event)"
      @keydown="onArrow($event, index)"
    >
      <span class="theme-stop-label">{{ themeModeLabels[option] }}</span>
    </button>
  </div>
</template>
