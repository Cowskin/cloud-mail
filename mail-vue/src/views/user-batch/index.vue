<template>
  <div class="batch-page">
    <div class="page-toolbar">
      <div><h2>批量注册</h2><p>按规则创建邮箱，并以批次持续管理和导出。</p></div>
      <el-button circle title="刷新" @click="refreshCurrent"><Icon icon="ion:reload" /></el-button>
    </div>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="创建批次" name="create">
        <section class="rule-section">
          <el-form label-position="top" class="rule-grid">
            <el-form-item label="批次名称"><el-input v-model="form.batchName" maxlength="40" placeholder="例如：市场活动 A 组" /></el-form-item>
            <el-form-item label="邮箱域名"><el-select v-model="form.suffix"><el-option v-for="domain in settingStore.domainList" :key="domain" :label="domain" :value="domain" /></el-select></el-form-item>
            <el-form-item label="邮箱前缀"><el-input v-model="form.prefix" maxlength="30" placeholder="user" /></el-form-item>
            <el-form-item label="分隔符"><el-select v-model="form.separator"><el-option label="无" value="" /><el-option label="短横线 -" value="-" /><el-option label="下划线 _" value="_" /><el-option label="点号 ." value="." /></el-select></el-form-item>
            <el-form-item label="起始编号"><el-input-number v-model="form.start" :min="0" :max="999999" controls-position="right" /></el-form-item>
            <el-form-item label="创建数量"><el-input-number v-model="form.count" :min="1" :max="500" controls-position="right" /></el-form-item>
            <el-form-item label="编号位数"><el-input-number v-model="form.padding" :min="1" :max="8" controls-position="right" /></el-form-item>
            <el-form-item label="权限身份"><el-select v-model="form.type"><el-option v-for="role in roles" :key="role.roleId" :label="role.name" :value="role.roleId" /></el-select></el-form-item>
            <el-form-item label="密码规则"><el-segmented v-model="form.passwordMode" :options="passwordModes" /></el-form-item>
            <el-form-item v-if="form.passwordMode === 'random'" label="密码长度"><el-input-number v-model="form.passwordLength" :min="8" :max="32" controls-position="right" /></el-form-item>
            <el-form-item v-else label="统一密码"><el-input v-model="form.fixedPassword" type="password" show-password maxlength="64" /></el-form-item>
          </el-form>
          <div class="actions">
            <el-button @click="generatePreview"><Icon icon="solar:eye-outline" />生成预览</el-button>
            <el-button type="primary" :loading="creating" :disabled="!preview.length" @click="createBatch"><Icon icon="fluent:people-add-24-regular" />创建 {{ preview.length }} 个账号</el-button>
          </div>
        </section>
        <section v-if="preview.length" class="preview-section">
          <div class="section-heading"><div><h3>本次批次</h3><span>{{ resultSummary }}</span></div><el-button @click="exportCurrent"><Icon icon="solar:download-minimalistic-outline" />导出本批次 CSV</el-button></div>
          <el-table :data="preview" height="360" stripe>
            <el-table-column type="index" width="64" label="#" /><el-table-column prop="email" label="邮箱" min-width="240" /><el-table-column prop="password" label="密码" min-width="150" />
            <el-table-column label="状态" width="110"><template #default="scope"><el-tag v-if="scope.row.success === true" type="success">成功</el-tag><el-tag v-else-if="scope.row.success === false" type="danger">失败</el-tag><el-tag v-else type="info">待创建</el-tag></template></el-table-column>
            <el-table-column prop="error" label="说明" min-width="160" />
          </el-table>
        </section>
      </el-tab-pane>

      <el-tab-pane label="批次管理与导出" name="history">
        <section class="history-filters">
          <el-input v-model="batchQuery.keyword" clearable placeholder="批次名或邮箱前缀" @keyup.enter="searchBatches"><template #prefix><Icon icon="iconoir:search" /></template></el-input>
          <el-select v-model="batchQuery.domain" clearable placeholder="全部域名"><el-option v-for="domain in settingStore.domainList" :key="domain" :label="domain" :value="domain" /></el-select>
          <el-select v-model="batchQuery.resultStatus" clearable placeholder="全部结果"><el-option label="全部成功" value="success" /><el-option label="部分失败" value="partial" /><el-option label="全部失败" value="failed" /></el-select>
          <el-date-picker v-model="batchDates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" unlink-panels />
          <el-button type="primary" @click="searchBatches"><Icon icon="iconoir:search" />筛选</el-button>
          <el-button :disabled="!hasBatchFilters" @click="resetBatchFilters">重置</el-button>
        </section>

        <div class="summary-strip">
          <span>找到 <strong>{{ batchTotal }}</strong> 个批次</span>
          <span v-if="selectedBatch">已选：<strong>{{ selectedBatch.name }}</strong></span>
        </div>

        <div class="history-layout">
          <section class="batch-list">
            <el-table :data="batches" highlight-current-row height="500" v-loading="batchLoading" @current-change="selectBatch">
              <el-table-column prop="name" label="批次" min-width="160"><template #default="scope"><div class="batch-name">{{ scope.row.name }}</div><div class="muted">{{ compactRule(scope.row.rule) }}</div></template></el-table-column>
              <el-table-column label="创建结果" width="120"><template #default="scope"><div>{{ scope.row.successCount }} 成功</div><div v-if="scope.row.failedCount" class="failed-text">{{ scope.row.failedCount }} 失败</div></template></el-table-column>
              <el-table-column prop="createTime" label="创建时间" min-width="155" />
            </el-table>
            <el-pagination class="pagination" background small layout="prev, pager, next" :current-page="batchQuery.page" :page-size="batchQuery.size" :total="batchTotal" @current-change="changeBatchPage" />
          </section>

          <section class="batch-detail">
            <div v-if="selectedBatch" class="detail-content">
              <div class="section-heading detail-heading"><div><h3>{{ selectedBatch.name }}</h3><span>{{ formatRule(selectedBatch.rule) }}</span></div><el-button :loading="exporting" :disabled="!itemTotal" @click="exportFiltered"><Icon icon="solar:download-minimalistic-outline" />导出筛选结果</el-button></div>
              <div class="detail-stats"><span>总数 <strong>{{ selectedBatch.total }}</strong></span><span class="success-text">成功 <strong>{{ selectedBatch.successCount }}</strong></span><span class="failed-text">失败 <strong>{{ selectedBatch.failedCount }}</strong></span></div>
              <div class="item-filters">
                <el-input v-model="itemQuery.email" clearable placeholder="搜索邮箱" @keyup.enter="searchItems"><template #prefix><Icon icon="iconoir:search" /></template></el-input>
                <el-select v-model="itemQuery.status" clearable placeholder="全部状态"><el-option label="创建成功" value="1" /><el-option label="创建失败" value="0" /></el-select>
                <el-button @click="searchItems">筛选</el-button>
              </div>
              <el-table :data="batchItems" height="350" stripe v-loading="itemsLoading">
                <el-table-column prop="email" label="邮箱" min-width="230" /><el-table-column label="状态" width="90"><template #default="scope"><el-tag :type="scope.row.status ? 'success' : 'danger'">{{ scope.row.status ? '成功' : '失败' }}</el-tag></template></el-table-column><el-table-column prop="error" label="说明" min-width="140" />
              </el-table>
              <div class="detail-footer"><span class="muted">当前筛选共 {{ itemTotal }} 条</span><el-pagination background small layout="prev, pager, next" :current-page="itemQuery.page" :page-size="itemQuery.size" :total="itemTotal" @current-change="changeItemPage" /></div>
            </div>
            <el-empty v-else description="从左侧选择一个批次查看详情" />
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
const activeTab = ref('create'), roles = ref([]), preview = ref([]), creating = ref(false)
const batches = ref([]), batchTotal = ref(0), batchLoading = ref(false), selectedBatch = ref(null)
const batchItems = ref([]), itemTotal = ref(0), itemsLoading = ref(false), exporting = ref(false), batchDates = ref([])
const passwordModes = [{label: '随机密码', value: 'random'}, {label: '统一密码', value: 'fixed'}]
const batchQuery = reactive({keyword: '', domain: '', resultStatus: '', page: 1, size: 20})
const itemQuery = reactive({email: '', status: '', page: 1, size: 50})
const form = reactive({batchName: '', suffix: settingStore.domainList[0], prefix: 'user', separator: '', start: 1, count: 100, padding: 3, type: null, passwordMode: 'random', passwordLength: 12, fixedPassword: ''})
const hasBatchFilters = computed(() => batchQuery.keyword || batchQuery.domain || batchQuery.resultStatus || batchDates.value?.length)
const resultSummary = computed(() => { const success = preview.value.filter(i => i.success === true).length; const failed = preview.value.filter(i => i.success === false).length; return !success && !failed ? `已生成 ${preview.value.length} 个账号，确认后创建` : `共 ${preview.value.length} 个，成功 ${success} 个，失败 ${failed} 个` })

onMounted(async () => { roles.value = await roleSelectUse(); form.type = roles.value[0]?.roleId || null; await loadBatches() })
watch(activeTab, value => { if (value === 'history') loadBatches() })

function randomPassword(length) { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'; const bytes = new Uint32Array(length); crypto.getRandomValues(bytes); return Array.from(bytes, value => chars[value % chars.length]).join('') }
function validateForm() { if (!form.batchName.trim()) return '请输入批次名称'; if (!form.prefix.trim()) return '请输入邮箱前缀'; if (!/^[a-zA-Z0-9._-]+$/.test(form.prefix)) return '邮箱前缀只能包含字母、数字、点、横线和下划线'; if (!form.type) return '请选择权限身份'; if (form.passwordMode === 'fixed' && form.fixedPassword.length < 6) return '统一密码至少需要 6 位'; return '' }
function generatePreview() { const error = validateForm(); if (error) return ElMessage.warning(error); preview.value = Array.from({length: form.count}, (_, index) => { const number = String(form.start + index).padStart(form.padding, '0'); return {email: `${form.prefix}${form.separator}${number}${form.suffix}`.toLowerCase(), password: form.passwordMode === 'random' ? randomPassword(form.passwordLength) : form.fixedPassword, type: form.type, success: null, error: ''} }) }
async function createBatch() { creating.value = true; try { const data = await userBatchCreate({batchName: form.batchName.trim(), rule: {prefix: form.prefix, separator: form.separator, start: form.start, count: form.count, padding: form.padding, suffix: form.suffix}, list: preview.value.map(({email, password, type}) => ({email, password, type}))}); const resultMap = new Map(data.results.map(i => [i.email, i])); preview.value = preview.value.map(i => ({...i, ...resultMap.get(i.email)})); ElMessage.success(`批次创建完成：成功 ${data.successCount} 个，失败 ${data.failedCount} 个`); await loadBatches() } finally { creating.value = false } }

function batchParams() { return {...batchQuery, startDate: batchDates.value?.[0] || '', endDate: batchDates.value?.[1] || ''} }
async function loadBatches() { batchLoading.value = true; try { const data = await userBatchList(batchParams()); batches.value = data.list; batchTotal.value = data.total; if (selectedBatch.value && !data.list.some(i => i.batchId === selectedBatch.value.batchId)) { selectedBatch.value = null; batchItems.value = []; itemTotal.value = 0 } } finally { batchLoading.value = false } }
function searchBatches() { batchQuery.page = 1; loadBatches() }
function changeBatchPage(page) { batchQuery.page = page; loadBatches() }
function resetBatchFilters() { Object.assign(batchQuery, {keyword: '', domain: '', resultStatus: '', page: 1}); batchDates.value = []; loadBatches() }
async function selectBatch(batch) { if (!batch) return; selectedBatch.value = batch; Object.assign(itemQuery, {email: '', status: '', page: 1}); await loadItems() }
async function loadItems() { if (!selectedBatch.value) return; itemsLoading.value = true; try { const data = await userBatchItems({batchId: selectedBatch.value.batchId, ...itemQuery}); batchItems.value = data.list; itemTotal.value = data.total } finally { itemsLoading.value = false } }
function searchItems() { itemQuery.page = 1; loadItems() }
function changeItemPage(page) { itemQuery.page = page; loadItems() }
function refreshCurrent() { activeTab.value === 'history' ? loadBatches() : generatePreview() }
function compactRule(rule = {}) { return `${rule.prefix || '手动'} · ${rule.suffix || '未知域名'}` }
function formatRule(rule = {}) { if (!rule.prefix) return '手动批次'; return `${rule.prefix}${rule.separator || ''}${String(rule.start || 0).padStart(rule.padding || 1, '0')}…${rule.suffix || ''}，共 ${rule.count || 0} 个` }
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"` }
function downloadCsv(filename, headers, rows) { const content = '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n'); const url = URL.createObjectURL(new Blob([content], {type: 'text/csv;charset=utf-8'})); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url) }
function exportCurrent() { downloadCsv(`${form.batchName || '批量账号'}.csv`, ['邮箱', '密码', '状态', '说明'], preview.value.map(i => [i.email, i.password, i.success === true ? '成功' : i.success === false ? '失败' : '待创建', i.error])) }
async function exportFiltered() { exporting.value = true; try { const data = await userBatchItems({batchId: selectedBatch.value.batchId, email: itemQuery.email, status: itemQuery.status, export: '1'}); downloadCsv(`${selectedBatch.value.name}-筛选结果.csv`, ['邮箱', '状态', '说明', '创建时间'], data.list.map(i => [i.email, i.status ? '成功' : '失败', i.error, i.createTime])); ElMessage.success(`已导出 ${data.list.length} 条记录`) } finally { exporting.value = false } }
</script>

<style scoped lang="scss">
.batch-page { height: 100%; overflow: auto; padding: 18px 22px 30px; box-sizing: border-box; }
.page-toolbar, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h2, h3 { margin: 0; letter-spacing: 0; }.page-toolbar p, .section-heading span { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
.rule-section, .preview-section, .batch-list, .batch-detail { border-top: 1px solid var(--el-border-color); padding-top: 18px; }
.rule-grid { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 0 16px; }.rule-grid :deep(.el-input-number), .rule-grid :deep(.el-select) { width: 100%; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 18px; }.preview-section { margin-top: 4px; }.section-heading { margin-bottom: 14px; }
.history-filters { display: grid; grid-template-columns: minmax(190px, 1fr) 180px 150px minmax(280px, 1.25fr) auto auto; gap: 10px; align-items: center; padding: 4px 0 16px; }
.history-filters :deep(.el-date-editor) { width: 100%; }.summary-strip { min-height: 34px; display: flex; align-items: center; gap: 24px; color: var(--el-text-color-secondary); font-size: 13px; }
.history-layout { display: grid; grid-template-columns: minmax(390px, .85fr) minmax(520px, 1.15fr); gap: 22px; }.batch-name { font-weight: 600; }.muted { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 3px; }
.pagination { justify-content: center; margin-top: 14px; }.detail-content { min-height: 480px; }.detail-stats { display: flex; gap: 20px; padding: 10px 12px; margin-bottom: 12px; background: var(--el-fill-color-light); border-radius: 6px; font-size: 13px; }
.item-filters { display: grid; grid-template-columns: minmax(220px, 1fr) 150px auto; gap: 10px; margin-bottom: 12px; }.detail-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
.success-text { color: var(--el-color-success); }.failed-text { color: var(--el-color-danger); }
@media (max-width: 1200px) { .rule-grid { grid-template-columns: repeat(2, minmax(150px, 1fr)); }.history-filters { grid-template-columns: 1fr 1fr 1fr; }.history-layout { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .batch-page { padding: 14px; }.rule-grid, .history-filters, .item-filters { grid-template-columns: 1fr; }.page-toolbar, .section-heading { align-items: flex-start; flex-wrap: wrap; }.detail-heading { flex-direction: column; }.history-layout { display: block; }.batch-detail { margin-top: 22px; }.batch-list :deep(.el-table) { height: 320px !important; }.batch-detail :deep(.el-table) { height: 360px !important; }.detail-footer { align-items: flex-start; gap: 8px; flex-direction: column; }.summary-strip { align-items: flex-start; flex-direction: column; gap: 4px; padding: 8px 0; } }
</style>
