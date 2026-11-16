<template>
  <el-config-provider :locale="settingStore.lang === 'zh' ? zhCn : null">
    <router-view :key="settingStore.settings.cardProtectionVersion || 0" />
  </el-config-provider>
</template>
<script setup>
import { useI18n } from "vue-i18n";
import { watch, onMounted, onUnmounted } from "vue";
import { useEmailStore } from '@/store/email.js';
import { useRouter } from 'vue-router';
import http from '@/axios/index.js';
import { acceptProtectionState } from '@/utils/card-protection.js';
import {useSettingStore} from "@/store/setting.js";
const settingStore = useSettingStore()
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import('@/icons/index.js')
const { locale } = useI18n()
locale.value = settingStore.lang
watch(() => settingStore.lang, () => locale.value = settingStore.lang)

const router = useRouter();
const emailStore = useEmailStore();
watch(() => settingStore.settings.cardProtectionVersion, (version, previous) => {
  if (!previous || version === previous) return;
  emailStore.$reset();
  localStorage.removeItem('email');
  if (router.currentRoute.value.name === 'content') router.replace('/inbox');
}, { flush: 'sync' });
let timer, checking = false;
async function checkProtection() {
  if (checking || !localStorage.getItem('token')) return;
  checking = true;
  try {
    const state = await http.get('/email/protectionState', { noMsg: true });
    acceptProtectionState(state.version, state.enabled);
  } catch {
    // An unavailable policy must not leave an old reading copy on screen.
    emailStore.$reset();
    if (router.currentRoute.value.name === 'content') router.replace('/inbox');
  } finally { checking = false; }
}
function crossTab(event) { if (event.key === 'card-protection-version') checkProtection(); }
onMounted(() => {
  timer = setInterval(checkProtection, 15000);
  window.addEventListener('focus', checkProtection);
  window.addEventListener('storage', crossTab);
});
onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener('focus', checkProtection);
  window.removeEventListener('storage', crossTab);
});
</script>
