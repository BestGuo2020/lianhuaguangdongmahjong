<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    class="effect-number"
    :width="displayWidth"
    :height="height"
    :viewBox="viewBox"
    preserveAspectRatio="xMidYMid meet"
    role="img"
    :aria-label="formattedText"
  >
    <defs>
      <!-- 正面渐变：跟随数字正负切换 -->
      <linearGradient
        :id="gradientId"
        gradientUnits="userSpaceOnUse"
        x1="0"
        y1="20"
        x2="0"
        y2="98"
      >
        <stop offset="0%" :stop-color="palette.top" />
        <stop offset="40%" :stop-color="palette.middle" />
        <stop offset="100%" :stop-color="palette.bottom" />
      </linearGradient>

      <!-- 柔和投影 -->
      <filter
        :id="shadowId"
        x="-25%"
        y="-60%"
        width="160%"
        height="240%"
        color-interpolation-filters="sRGB"
      >
        <feDropShadow
          dx="3"
          dy="5"
          stdDeviation="2.6"
          :flood-color="palette.shadow"
          flood-opacity="0.8"
        />
      </filter>
    </defs>

    <g
      :font-family="fontFamily"
      font-size="100"
      font-weight="900"
      font-style="italic"
      letter-spacing="-3"
      stroke-linejoin="round"
      transform="skewX(-8)"
    >
      <!-- 立体底边 -->
      <g :filter="`url(#${shadowId})`">
        <text
          x="0"
          y="96"
          transform="translate(0,8)"
          :fill="palette.depth"
          :stroke="palette.depth"
          stroke-width="1.5"
        >
          {{ formattedText }}
        </text>

        <text
          x="0"
          y="96"
          transform="translate(0,4)"
          :fill="palette.side"
        >
          {{ formattedText }}
        </text>
      </g>

      <!-- 正面，同时用于测量实际文字尺寸 -->
      <text
        ref="faceRef"
        x="0"
        y="96"
        :fill="`url(#${gradientId})`"
        :stroke="palette.outline"
        stroke-width="0.9"
        paint-order="stroke fill"
      >
        {{ formattedText }}
      </text>

      <!-- 细高光 -->
      <text
        x="0"
        y="96"
        fill="none"
        :stroke="palette.highlight"
        stroke-width="0.6"
        stroke-opacity="0.4"
      >
        {{ formattedText }}
      </text>
    </g>
  </svg>
</template>

<script setup>
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from 'vue'

const props = defineProps({
  /**
   * 整数或整数字符串。
   * 超长数字建议传字符串，避免 JS 数值精度丢失。
   */
  value: {
    type: [Number, String],
    default: 0,
    validator: (value) => /^[+-]?\d+$/.test(String(value).trim()),
  },

  // 整个 SVG 的显示高度，包含阴影和留白。
  height: {
    type: Number,
    default: 116,
    validator: (value) => Number.isFinite(value) && value > 0,
  },

  // 正数是否显示加号。零不显示加号。
  showPlus: {
    type: Boolean,
    default: true,
  },

  fontFamily: {
    type: String,
    default: 'Arial, Helvetica, sans-serif',
  },
})

const faceRef = ref(null)

// 每个组件独立的 SVG ID，支持多个实例同时渲染。
const id = useId()
const gradientId = `effect-number-gradient-${id}`
const shadowId = `effect-number-shadow-${id}`

const themes = {
  positive: {
    top: '#FFF49A',
    middle: '#FFE16D',
    bottom: '#EAA23A',
    depth: '#70471D',
    side: '#A67C28',
    outline: '#BA903A',
    highlight: '#FFF2A4',
    shadow: '#302414',
  },

  negative: {
    top: '#A1DDE5',
    middle: '#8CCDDC',
    bottom: '#5295C1',
    depth: '#173F59',
    side: '#326D8C',
    outline: '#65A9C1',
    highlight: '#B7ECED',
    shadow: '#102E36',
  },
}

// 全程使用字符串，不调用 Number()，保留超长整数和前导零。
const parsedValue = computed(() => {
  const raw = String(props.value).trim()

  if (!/^[+-]?\d+$/.test(raw)) {
    return {
      valid: false,
      digits: '',
      negative: false,
      zero: false,
    }
  }

  const digits = raw.replace(/^[+-]/, '')
  const zero = /^0+$/.test(digits)

  return {
    valid: true,
    digits,
    // -0 按零处理。
    negative: raw.startsWith('-') && !zero,
    zero,
  }
})

const formattedText = computed(() => {
  const value = parsedValue.value

  // 非法输入不继续渲染旧数字。
  if (!value.valid) return '—'

  if (value.negative) {
    // 使用数学减号，视觉效果更接近参考图。
    return `−${value.digits}`
  }

  if (props.showPlus && !value.zero) {
    return `+${value.digits}`
  }

  return value.digits
})

const palette = computed(() => {
  return parsedValue.value.negative
    ? themes.negative
    : themes.positive
})

// SVG 内部使用统一坐标，修改 height 时整体等比例缩放。
const bounds = ref({
  x: -18,
  y: 0,
  width: 140,
  height: 124,
})

const viewBox = computed(() => {
  const { x, y, width, height } = bounds.value
  return `${x} ${y} ${width} ${height}`
})

const displayWidth = computed(() => {
  return props.height * bounds.value.width / bounds.value.height
})

function measureText() {
  const element = faceRef.value
  if (!element) return

  const box = element.getBBox()

  // display:none 等情况下可能无法测量，先保留原尺寸。
  if (!box.width || !box.height) return

  // 留出斜体外伸、描边和阴影空间。
  const left = Math.floor(box.x - 18)
  const right = Math.ceil(box.x + box.width + 22)
  const top = Math.floor(Math.min(0, box.y - 12))
  const bottom = Math.ceil(
    Math.max(124, box.y + box.height + 26),
  )

  bounds.value = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}

// 等 Vue 更新文字节点后，再测量。
watch(
  [formattedText, () => props.fontFamily],
  measureText,
  { flush: 'post' },
)

let disposed = false
let resizeObserver
let fontSet

onMounted(() => {
  measureText()

  // 自定义字体加载完成后重新计算。
  fontSet = document.fonts

  if (fontSet) {
    fontSet.ready.then(() => {
      if (!disposed) measureText()
    })

    fontSet.addEventListener('loadingdone', measureText)
  }

  // 处理字形尺寸变化，以及隐藏后重新显示的情况。
  if (typeof ResizeObserver !== 'undefined' && faceRef.value) {
    resizeObserver = new ResizeObserver(measureText)
    resizeObserver.observe(faceRef.value)
  }
})

onBeforeUnmount(() => {
  disposed = true
  resizeObserver?.disconnect()
  fontSet?.removeEventListener('loadingdone', measureText)
})

// 特殊布局下，也可以由父组件手动触发重新测量。
defineExpose({
  refresh: measureText,
})
</script>

<style scoped>
.effect-number {
  display: inline-block;
  max-width: 100%;
  height: auto;
  vertical-align: middle;
  flex-shrink: 0;
}
</style>