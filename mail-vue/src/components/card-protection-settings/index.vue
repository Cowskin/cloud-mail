<template>
  <section class="protection-card" aria-labelledby="card-encryption-heading" :aria-busy="loading">
    <h2 id="card-encryption-heading">{{ t('cardEncryption') }}</h2>
    <div class="protection-content">
      <div class="protection-state">
        <span>{{ status ? (status.enabled ? t('cardEncryptionOn') : t('cardEncryptionOff')) : t('cardProtectionLoading') }}</span>
        <el-switch
            :model-value="!!status?.enabled"
            :disabled="!status || loading || !canEdit || (!status.enabled && !status.ready)"
            :aria-label="t('cardEncryption')"
            aria-describedby="card-protection-scope"
            @change="open(status.enabled ? 'disable' : 'enable')"
        />
      </div>
      <p id="card-protection-scope">{{ t('cardProtectionScope') }}</p>
      <p>{{ t('cardProtectionLimits') }}</p>
      <p v-if="status && !status.ready" role="status">{{ t('cardProtectionNotReady') }}</p>
      <div class="protection-actions" v-if="status?.enabled && canEdit && !action">
        <el-button @click="open('change')" :disabled="loading || !status.ready">{{ t('cardProtectionChange') }}</el-button>
      </div>
      <div v-if="action" class="protection-form">
        <h3>{{ actionTitle }}</h3>
        <el-form label-position="top" :disabled="loading" @submit.prevent="submit">
          <el-form-item v-if="action !== 'enable'" :label="t('cardProtectionCurrent')" for="card-current-password">
            <el-input id="card-current-password" v-model="form.currentPassword" type="password" autocomplete="current-password" show-password required />
          </el-form-item>
          <template v-if="action !== 'disable'">
            <el-form-item :label="t('cardProtectionNew')" for="card-new-password">
              <el-input id="card-new-password" v-model="form.newPassword" type="password" autocomplete="new-password" show-password required />
            </el-form-item>
            <el-form-item :label="t('cardProtectionConfirm')" for="card-confirm-password">
              <el-input id="card-confirm-password" v-model="form.confirmPassword" type="password" autocomplete="new-password" show-password required />
            </el-form-item>
            <p>{{ t('cardProtectionPasswordHint') }}</p>
          </template>
          <p v-if="action === 'disable'">{{ t('cardProtectionDisableHint') }}</p>
        <p v-if="error" role="alert" class="protection-error">{{ error }}</p>
        <div class="protection-actions">
          <el-button :disabled="loading" @click="cancel">{{ t('cancel') }}</el-button>
          <el-button type="primary" native-type="submit" :loading="loading">{{ actionTitle }}</el-button>
        </div>
        </el-form>
      </div>
      <p v-else-if="error" role="alert" class="protection-error">{{ error }}</p>
      <el-button v-if="!status && !loading" @click="load">{{ t('cardProtectionRetry') }}</el-button>
      <p v-if="saved" role="status">{{ t('saveSuccessMsg') }}</p>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { hasPerm } from '@/perm/perm.js';
import { cardProtectionStatus, cardProtectionUpdate } from '@/request/setting.js';
import { acceptProtectionState } from '@/utils/card-protection.js';

const { t } = useI18n();
const status = ref(null), loading = ref(false), action = ref(''), error = ref(''), saved = ref(false);
const form = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' });
const canEdit = computed(() => hasPerm('setting:set'));
const actionTitle = computed(() => t({enable:'cardProtectionEnable',change:'cardProtectionChange',disable:'cardProtectionDisable'}[action.value] || 'cardEncryption'));
function cancel() {
  action.value = ''; error.value = '';
  Object.assign(form, {currentPassword:'',newPassword:'',confirmPassword:''});
}
function open(value) { cancel(); saved.value = false; action.value = value; }
async function load() {
  loading.value = true; error.value = '';
  try { status.value = await cardProtectionStatus(); }
  catch (e) { error.value = e.message || t('reqFailErrorMsg'); }
  finally { loading.value = false; }
}
async function submit() {
  if (loading.value) return;
  error.value = '';
  if (action.value !== 'enable' && !form.currentPassword) { error.value = t('cardProtectionCurrentRequired'); return; }
  if (action.value !== 'disable' && (!form.newPassword || form.newPassword !== form.confirmPassword ||
      new TextEncoder().encode(form.newPassword).length > 1024 || /[\r\n]/.test(form.newPassword))) {
    error.value = t('cardProtectionPasswordInvalid'); return;
  }
  loading.value = true;
  try {
    const updated = await cardProtectionUpdate({action:action.value,version:status.value.version,...form});
    status.value = updated; cancel(); saved.value = true;
    acceptProtectionState(updated.version, updated.enabled);
  } catch (e) {
    error.value = e.message || t('reqFailErrorMsg');
    if (e.code === 409) { cancel(); await load(); }
  } finally { loading.value = false; }
}
onMounted(load);
</script>

<style scoped lang="scss">
.protection-card {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  overflow: hidden;
  align-self: start;
  h2 { font-size: 15px; font-weight: bold; padding: 10px 20px; border-bottom: 1px solid var(--el-border-color); }
  h3 { font-size: 14px; font-weight: 600; }
  p { color: var(--regular-text-color); line-height: 1.6; overflow-wrap: anywhere; }
}
.protection-content { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.protection-state { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.protection-actions { display: flex; flex-wrap: wrap; gap: 10px; :deep(.el-button + .el-button) { margin-left: 0; } }
.protection-form { display: flex; flex-direction: column; gap: 16px; padding-top: 12px; border-top: 1px solid var(--el-border-color); }
.protection-card .protection-error { color: var(--el-color-danger-dark-2); }
:global(.dark) .protection-card .protection-error { color: var(--el-color-danger); }
</style>
