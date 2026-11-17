<template>
  <div class="content-box" ref="contentBox">
    <div ref="container" class="content-html"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
const emit = defineEmits(['protected-link']);

const props = defineProps({
  html: {
    type: String,
    required: true
  }
})

const container = ref(null)
const contentBox = ref(null)
let shadowRoot = null

function updateContent() {
  if (!shadowRoot) return;

  // 1. 提取 <body> 的 style 属性（如果存在）
  const bodyStyleRegex = /<body[^>]*style="([^"]*)"[^>]*>/i;
  const bodyStyleMatch = props.html.match(bodyStyleRegex);
  const bodyStyle = bodyStyleMatch ? bodyStyleMatch[1] : '';

  // 2. 移除 <body> 标签（保留内容）
  const cleanedHtml = props.html.replace(/<\/?body[^>]*>/gi, '');

  // 3. 将 body 的 style 应用到 .shadow-content
  shadowRoot.innerHTML = `
    <style>
      :host {
        all: initial;
        width: 100%;
        height: 100%;
        font-family: -apple-system, Inter, BlinkMacSystemFont,
                    'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #13181D;
        word-break: break-word;
      }

      h1, h2, h3, h4 {
          font-size: 18px;
          font-weight: 700;
      }

      p {
        margin: 0;
      }

      a {
        text-decoration: none;
        color: #0E70DF;
      }

      a[data-protected-link] { cursor: pointer; text-decoration: underline; }
      a[data-protected-link]:focus-visible { outline: 2px solid #0E70DF; outline-offset: 3px; }

      .shadow-content {
        background: #FFFFFF;
        width: fit-content;
        height: fit-content;
        min-width: 100%;
        ${bodyStyle ? bodyStyle : ''} /* 注入 body 的 style */
      }

      img:not(table img) {
        max-width: 100%;
        height: auto !important;
      }

    </style>
    <div class="shadow-content">
      ${cleanedHtml}
    </div>
  `;
}

function autoScale() {
  if (!shadowRoot || !contentBox.value) return

  const parent = contentBox.value
  const shadowContent = shadowRoot.querySelector('.shadow-content')

  if (!shadowContent) return

  const parentWidth = parent.offsetWidth
  const childWidth = shadowContent.scrollWidth

  if (childWidth === 0) return

  const scale = parentWidth / childWidth

  const hostElement = shadowRoot.host
  hostElement.style.zoom = scale
}

function activateProtectedLink(event) {
  if (event.type==='keydown' && !['Enter',' '].includes(event.key)) return;
  const anchor = event.target.closest?.('a[data-protected-link]');
  if (!anchor) return;
  event.preventDefault();
  const index = Number(anchor.dataset.protectedLink);
  if (Number.isSafeInteger(index) && index>=0) emit('protected-link',index);
}

onMounted(() => {
  shadowRoot = container.value.attachShadow({ mode: 'open' })
  shadowRoot.addEventListener('click',activateProtectedLink);
  shadowRoot.addEventListener('keydown',activateProtectedLink);
  updateContent()
  autoScale()
})

onBeforeUnmount(() => {
  shadowRoot?.removeEventListener('click',activateProtectedLink);
  shadowRoot?.removeEventListener('keydown',activateProtectedLink);
});

watch(() => props.html, () => {
  updateContent()
  autoScale()
})
</script>

<style scoped>
.content-box {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: -apple-system, Inter, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
}

.content-html {
  width: 100%;
  height: 100%;
}
</style>
