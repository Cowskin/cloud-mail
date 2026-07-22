<template>
  <div class="batch-page">
    <div class="page-toolbar">
      <div>
        <h2>批量注册</h2>
        <p>按规则生成账号，每次创建都会保存为独立批次。</p>
      </div>
      <el-button circle title="刷新批次" @click="loadBatches"><Icon icon="ion:reload" /></el-button>
    </div>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="创建批次" name="create">
        <section class="rule-section">
          <el-form label-position="top" class="rule-grid">
            <el-form-item label="批次名称">
              <el-input v-model="form.batchName" maxlength="40" placeholder="例如：市场活动 A 组" />
            </el-form-item>
            <el-form-item label="邮箱域名">
              <el-select v-model="form.suffix">
                <el-option v-for="domain in settingStore.domainList" :key="domain" :label="domain" :value="domain" />
              </el-select>
            </el-form-item>
            <el-form-item label="邮箱前缀">
              <el-input v-model="form.prefix" maxlength="30" placeholder="user" />
            </el-form-item>
            <el-form-item label="分隔符">
              <el-select v-model="form.separator">
                <el-option label="无" value="" />
                <el-option label="短横线 -" value="-" />
                <el-option label="下划线 _" value="_" />
                <el-option label="点号 ." value="." />
              </el-select>
            </el-form-item>
            <el-form-item label="起始编号">
              <el-input-number v-model="form.start" :min="0" :max="999999" controls-position="right" />
            </el-form-item>
            <el-form-item label="创建数量">
              <el-input-number v-model="form.count" :min="1" :max="500" controls-position="right" />
            </el-form-item>
            <el-form-item label="编号位数">
              <el-input-number v-model="form.padding" :min="1" :max="8" controls-position="right" />
            </el-form-item>
            <el-form-item label="权限身份">
              <el-select v-model="form.type" placeholder="请选择">
                <el-option v-for="role in roles" :key="role.roleId" :label="role.name" :value="role.roleId" />
              </el-select>
            </el-form-item>
            <el-form-item label="密码规则">
              <el-segmented v-model="form.passwordMode" :options="passwordModes" />
            </el-form-item>
            <el-form-item v-if="form.passwordMode === 'random'" label="密码长度">
              <el-input-number v-model="form.passwordLength" :min="8" :max="32" controls-position="right" />
            </el-form-item>
            <el-form-item v-else label="统一密码">
              <el-input v-model="form.fixedPassword" type="password" show-password maxlength="64" />
            </el-form-item>
          </el-form>

          <div class="actions">
            <el-button @click="generatePreview"><Icon icon="solar:eye-outline" />生成预览</el-button>
            <el-button type="primary" :loading="creating" :disabled="!preview.length" @click="createBatch">
              <Icon icon="fluent:people-add-24-regular" />
              创建 {{ preview.length }} 个账号
            </el-button>
          </div>
        </section>

        <section v-if="preview.length" class="preview-section">
          <div class="section-heading">
            <div>
              <h3>本次批次</h3>
              <span>{{ resultSummary }}</span>
            </div>
            <el-button @click="exportCurrent"><Icon icon="solar:download-minimalistic-outline" />导出本批次 CSV</el-button>
          </div>
          <el-table :data="preview" height="360" stripe>
            <el-table-column type="index" width="64" label="#" />
            <el-table-column prop="email" label="邮箱" min-width="240" />
            <el-table-column prop="password" label="密码" min-width="150" />
            <el-table-column label="状态" width="110">
              <template #default="scope">
                <el-tag v-if="scope.row.success === true" type="success">成功</el-tag>
                <el-tag v-else-if="scope.row.success === false" type="danger">失败</el-tag>
                <el-tag v-else type="info">待创建</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="error" label="说明" min-width="160" />
          </el-table>
        </section>
      </el-tab-pane>

      <el-tab-pane label="历史批次与导出" name="history">
        <div class="history-layout">
          <section class="batch-list">
            <div class="section-heading">
              <h3>历史批次</h3>
              <el-input v-model="batchKeyword" clearable placeholder="搜索批次名" @keyup.enter="loadBatches" />
            </div>
            <el-table :data="batches" highlight-current-row height="520" @current-change="selectBatch">
              <el-table-column prop="name" label="批次" min-width="150" />
              <el-table-column prop="total" label="总数" width="70" />
              <el-table-column label="结果" width="115">
                <template #default="scope">
                  <span class="success-text">{{ scope.row.successCount }}</span>
                  <span> / </span>
                  <span class="failed-text">{{ scope.row.failedCount }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="createTime" label="创建时间" min-width="165" />
            </el-table>
          </section>

          <section class="batch-detail">
            <div class="section-heading detail-heading">
              <div>
                <h3>{{ selectedBatch?.name || '请选择一个批次' }}</h3>
                <span v-if="selectedBatch">{{ formatRule(selectedBatch.rule) }}</span>
              </div>
              <el-button :disabled="!filteredItems.length" @click="exportFiltered"><Icon icon="solar:download-minimalistic-outline" />导出筛选结果</el-button>
            </div>
            <div class="filters">
              <el-input v-model="filters.email" clearable placeholder="按邮箱包含内容筛选" />
              <el-select v-model="filters.status">
                <el-option label="全部状态" value="" />
                <el-option label="创建成功" value="1" />
                <el-option label="创建失败" value="0" />
              </el-select>
            </div>
            <el-table :data="filteredItems" height="438" stripe v-loading="itemsLoading">
              <el-table-column prop="email" label="邮箱" min-width="230" />
              <el-table-column label="状态" width="90">
                <template #default="scope">
                  <el-tag :type="scope.row.status ? 'success' : 'danger'">{{ scope.row.status ? '成功' : '失败' }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="error" label="说明" min-width="140" />
            </el-table>
          </section>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import {computed, onMounted, reactive, ref, watch} from 'vue'
import {Icon} from '@iconify/vue'
import {roleSelectUse} from '@/request/role.js'
import {userBatchCreate, userBatchItems, userBatchList} from '@/request/user-batch.js'
import {useSettingStore} from '@/store/setting.js'

defineOptions({name: 'user-batch'})

const settingStore = useSettingStore()
const activeTab = ref('create')
const roles = ref([])
const preview = ref([])
const creating = ref(false)
const batches = ref([])
const selectedBatch = ref(null)
const batchItems = ref([])
const itemsLoading = ref(false)
const batchKeyword = ref('')
const passwordModes = [{label: '随机密码', value: 'random'}, {label: '统一密码', value: 'fixed'}]
const filters = reactive({email: '', status: ''})
const form = reactive({
  batchName: '', suffix: settingStore.domainList[0], prefix: 'user', separator: '',
  start: 1, count: 100, padding: 3, type: null,
  passwordMode: 'random', passwordLength: 12, fixedPassword: ''
})

const filteredItems = computed(() => batchItems.value.filter(item => {
  const emailMatch = !filters.email || item.email.toLowerCase().includes(filters.email.toLowerCase())
  const statusMatch = filters.status === '' || String(item.status) === filters.status
  return emailMatch && statusMatch
}))

const resultSummary = computed(() => {
  const success = preview.value.filter(item => item.success === true).length
  const failed = preview.value.filter(item => item.success === false).length
  if (!success && !failed) return `已生成 ${preview.value.length} 个账号，确认后创建`
  return `共 ${preview.value.length} 个，成功 ${success} 个，失败 ${failed} 个`
})

onMounted(async () => {
  roles.value = await roleSelectUse()
  form.type = roles.value[0]?.roleId || null
  await loadBatches()
})

watch(activeTab, value => {
  if (value === 'history') loadBatches()
})

function randomPassword(length) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, value => chars[value % chars.length]).join('')
}

function validateForm() {
  if (!form.batchName.trim()) return '请输入批次名称'
  if (!form.prefix.trim()) return '请输入邮箱前缀'
  if (!/^[a-zA-Z0-9._-]+$/.test(form.prefix)) return '邮箱前缀只能包含字母、数字、点、横线和下划线'
  if (!form.type) return '请选择权限身份'
  if (form.passwordMode === 'fixed' && form.fixedPassword.length < 6) return '统一密码至少需要 6 位'
  return ''
}

function generatePreview() {
  const error = validateForm()
  if (error) return ElMessage.warning(error)
  preview.value = Array.from({length: form.count}, (_, index) => {
    const number = String(form.start + index).padStart(form.padding, '0')
    return {
      email: `${form.prefix}${form.separator}${number}${form.suffix}`.toLowerCase(),
      password: form.passwordMode === 'random' ? randomPassword(form.passwordLength) : form.fixedPassword,
      type: form.type,
      success: null,
      error: ''
    }
  })
}

async function createBatch() {
  creating.value = true
  try {
    const data = await userBatchCreate({
      batchName: form.batchName.trim(),
      rule: {prefix: form.prefix, separator: form.separator, start: form.start, count: form.count, padding: form.padding, suffix: form.suffix},
      list: preview.value.map(({email, password, type}) => ({email, password, type}))
    })
    const resultMap = new Map(data.results.map(item => [item.email, item]))
    preview.value = preview.value.map(item => ({...item, ...resultMap.get(item.email)}))
    ElMessage.success(`批次创建完成：成功 ${data.successCount} 个，失败 ${data.failedCount} 个`)
    await loadBatches()
  } finally {
    creating.value = false
  }
}

async function loadBatches() {
  batches.value = await userBatchList(batchKeyword.value)
}

async function selectBatch(batch) {
  if (!batch) return
  selectedBatch.value = batch
  filters.email = ''
  filters.status = ''
  itemsLoading.value = true
  try {
    batchItems.value = await userBatchItems({batchId: batch.batchId})
  } finally {
    itemsLoading.value = false
  }
}

function formatRule(rule = {}) {
  if (!rule.prefix) return '手动批次'
  return `${rule.prefix}${rule.separator || ''}${String(rule.start || 0).padStart(rule.padding || 1, '0')}…${rule.suffix || ''}，共 ${rule.count || 0} 个`
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function downloadCsv(filename, headers, rows) {
  const content = '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([content], {type: 'text/csv;charset=utf-8'}))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function exportCurrent() {
  downloadCsv(`${form.batchName || '批量账号'}.csv`, ['邮箱', '密码', '状态', '说明'],
      preview.value.map(item => [item.email, item.password, item.success === true ? '成功' : item.success === false ? '失败' : '待创建', item.error]))
}

function exportFiltered() {
  downloadCsv(`${selectedBatch.value.name}-筛选结果.csv`, ['邮箱', '状态', '说明', '创建时间'],
      filteredItems.value.map(item => [item.email, item.status ? '成功' : '失败', item.error, item.createTime]))
}
</script>

<style scoped lang="scss">
.batch-page { height: 100%; overflow: auto; padding: 18px 22px 30px; box-sizing: border-box; }
.page-toolbar, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h2, h3 { margin: 0; letter-spacing: 0; }
.page-toolbar p, .section-heading span { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
.rule-section, .preview-section, .batch-list, .batch-detail { border-top: 1px solid var(--el-border-color); padding-top: 18px; }
.rule-grid { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 0 16px; }
.rule-grid :deep(.el-input-number), .rule-grid :deep(.el-select) { width: 100%; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 18px; }
.preview-section { margin-top: 4px; }
.section-heading { margin-bottom: 14px; }
.history-layout { display: grid; grid-template-columns: minmax(360px, .8fr) minmax(500px, 1.2fr); gap: 22px; }
.section-heading .el-input { width: 190px; }
.filters { display: grid; grid-template-columns: minmax(220px, 1fr) 150px; gap: 10px; margin-bottom: 12px; }
.success-text { color: var(--el-color-success); }
.failed-text { color: var(--el-color-danger); }
@media (max-width: 1100px) { .rule-grid { grid-template-columns: repeat(2, minmax(150px, 1fr)); } .history-layout { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .batch-page { padding: 14px; } .rule-grid { grid-template-columns: 1fr; } .page-toolbar, .section-heading { align-items: flex-start; } .detail-heading { flex-direction: column; } .filters { grid-template-columns: 1fr; } }
</style>