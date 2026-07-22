<template>
  <div class="batch-page">
    <div class="page-toolbar">
      <div><h2>批量创建</h2><p>创建收件箱或独立账户，并按分组持续管理。</p></div>
      <el-button circle title="刷新" @click="refreshCurrent"><Icon icon="ion:reload" /></el-button>
    </div>

    <el-tabs v-model="activeTab">
      <el-tab-pane label="创建" name="create">
        <section class="mode-section">
          <div class="mode-label">创建类型</div>
          <el-segmented v-model="form.mode" :options="modeOptions" @change="clearPreview" />
          <div class="mode-facts">
            <span><Icon :icon="form.mode === 'inbox' ? 'solar:inbox-outline' : 'solar:user-id-outline'" />{{ form.mode === 'inbox' ? '归属当前账号' : '每个账户独立' }}</span>
            <span><Icon icon="solar:login-2-outline" />{{ form.mode === 'inbox' ? '不能独立登录' : '可以独立登录' }}</span>
            <span><Icon icon="solar:key-outline" />{{ form.mode === 'inbox' ? '无需密码' : '创建后导出密码' }}</span>
          </div>
        </section>

        <section class="rule-section">
          <el-form label-position="top" class="rule-grid">
            <el-form-item :label="form.mode === 'inbox' ? '收件箱分组' : '批次名称'"><el-input v-model="form.batchName" maxlength="40" :placeholder="form.mode === 'inbox' ? '例如：采购账号 A 组' : '例如：独立用户 A 组'" /></el-form-item>
            <el-form-item label="分类"><el-input v-model="form.category" maxlength="30" placeholder="例如：采购、营销、测试" /></el-form-item>
            <el-form-item label="邮箱域名"><el-select v-model="form.suffix"><el-option v-for="domain in settingStore.domainList" :key="domain" :label="domain" :value="domain" /></el-select></el-form-item>
            <el-form-item label="邮箱前缀"><el-input v-model="form.prefix" maxlength="30" placeholder="user" /></el-form-item>
            <el-form-item label="分隔符"><el-select v-model="form.separator"><el-option label="无" value="" /><el-option label="短横线 -" value="-" /><el-option label="下划线 _" value="_" /><el-option label="点号 ." value="." /></el-select></el-form-item>
            <el-form-item label="起始编号"><el-input-number v-model="form.start" :min="0" :max="999999" controls-position="right" /></el-form-item>
            <el-form-item label="创建数量"><el-input-number v-model="form.count" :min="1" :max="500" controls-position="right" /></el-form-item>
            <el-form-item label="编号位数"><el-input-number v-model="form.padding" :min="1" :max="8" controls-position="right" /></el-form-item>
            <el-form-item v-if="form.mode === 'user'" label="权限身份"><el-select v-model="form.type"><el-option v-for="role in roles" :key="role.roleId" :label="role.name" :value="role.roleId" /></el-select></el-form-item>
            <el-form-item v-if="form.mode === 'user'" label="密码规则"><el-segmented v-model="form.passwordMode" :options="passwordModes" /></el-form-item>
            <el-form-item v-if="form.mode === 'user' && form.passwordMode === 'random'" label="密码长度"><el-input-number v-model="form.passwordLength" :min="8" :max="32" controls-position="right" /></el-form-item>
            <el-form-item v-if="form.mode === 'user' && form.passwordMode === 'fixed'" label="统一密码"><el-input v-model="form.fixedPassword" type="password" show-password maxlength="64" /></el-form-item>
            <el-form-item label="备注"><el-input v-model="form.note" maxlength="200" placeholder="选填，记录用途或负责人" /></el-form-item>
          </el-form>
          <div class="create-policy">
            <el-checkbox v-model="form.stopOnConflict">发现重复或已删除地址时停止整个批次</el-checkbox>
            <span class="muted">创建时服务端会再次复检，网络重试不会覆盖已有地址。</span>
          </div>
          <div class="actions">
            <el-button :loading="checking" @click="generatePreview"><Icon icon="solar:shield-check-outline" />检测并预览</el-button>
            <el-button type="primary" :loading="creating" :disabled="!canCreate" @click="createBatch"><Icon icon="fluent:people-add-24-regular" />{{ previewCreated ? '本批次已创建' : `创建 ${availableCount} 个` }}</el-button>
          </div>
        </section>

        <section v-if="preview.length" class="preview-section">
          <div class="section-heading"><div><h3>创建预览</h3><span>可创建 {{ availableCount }}，冲突 {{ conflictCount }}</span></div><el-button @click="exportCurrent"><Icon icon="solar:download-minimalistic-outline" />导出本次结果</el-button></div>
          <el-table :data="preview" height="380" stripe>
            <el-table-column type="index" width="58" label="#" /><el-table-column prop="email" label="邮箱" min-width="240" />
            <el-table-column v-if="form.mode === 'user'" prop="password" label="密码" min-width="145" />
            <el-table-column label="检测结果" width="160"><template #default="scope"><el-tag :type="statusType(scope.row.status)">{{ scope.row.label }}</el-tag></template></el-table-column>
            <el-table-column prop="error" label="创建结果" min-width="140" />
          </el-table>
        </section>
      </el-tab-pane>

      <el-tab-pane label="收件箱分组" name="groups">
        <div class="group-toolbar">
          <el-input v-model="groupKeyword" clearable placeholder="搜索分组" @keyup.enter="loadGroups"><template #prefix><Icon icon="iconoir:search" /></template></el-input>
          <el-switch v-model="showDeletedGroups" inline-prompt active-text="回收站" inactive-text="当前" @change="loadGroups" />
        </div>
        <div class="group-layout">
          <section class="group-tree-panel">
            <el-tree :data="groupTree" node-key="groupId" highlight-current :expand-on-click-node="false" default-expand-all @node-click="selectGroup">
              <template #default="{data}"><div class="tree-node"><Icon :icon="data.isDel ? 'solar:trash-bin-trash-outline' : 'solar:folder-with-files-outline'" /><span>{{ data.name }}</span><el-tag size="small" type="info">{{ data.inboxCount }}</el-tag><Icon v-if="data.protected" icon="solar:lock-keyhole-outline" /></div></template>
            </el-tree>
            <el-empty v-if="!groupTree.length" :description="showDeletedGroups ? '回收站为空' : '尚未创建批量收件箱'" :image-size="70" />
          </section>
          <section class="group-detail">
            <template v-if="selectedGroup">
              <div class="section-heading group-heading">
                <div><h3>{{ selectedGroup.name }}</h3><span>{{ selectedGroup.inboxCount }} 个收件箱 · {{ selectedGroup.emailCount }} 封邮件 · {{ selectedGroup.unreadCount }} 封未读</span></div>
                <div class="group-actions">
                  <el-button @click="exportGroup"><Icon icon="solar:download-minimalistic-outline" />导出</el-button>
                  <el-button v-if="!selectedGroup.isDel" @click="toggleGroupProtection"><Icon :icon="selectedGroup.protected ? 'solar:lock-keyhole-unlocked-outline' : 'solar:lock-keyhole-outline'" />{{ selectedGroup.protected ? '解除保护' : '保护分组' }}</el-button>
                  <el-button v-if="selectedGroup.isDel" type="success" @click="restoreGroup"><Icon icon="solar:restart-outline" />批量恢复</el-button>
                  <el-button v-else type="danger" :disabled="!!selectedGroup.protected" @click="removeGroup"><Icon icon="solar:trash-bin-trash-outline" />删除</el-button>
                </div>
              </div>
              <div class="member-filter"><el-input v-model="memberQuery.keyword" clearable placeholder="搜索组内收件箱" @keyup.enter="searchMembers" /><el-button @click="searchMembers">搜索</el-button></div>
              <el-table :data="groupMembers" height="430" stripe v-loading="membersLoading">
                <el-table-column prop="email" label="收件箱" min-width="240" /><el-table-column prop="emailCount" label="邮件" width="85" /><el-table-column prop="unreadCount" label="未读" width="85" /><el-table-column prop="latestEmailTime" label="最近收件" min-width="160" /><el-table-column label="状态" width="90"><template #default="scope"><el-tag :type="scope.row.isDel ? 'info' : 'success'">{{ scope.row.isDel ? '已删除' : '正常' }}</el-tag></template></el-table-column>
              </el-table>
              <div class="detail-footer"><span class="muted">共 {{ memberTotal }} 个收件箱</span><el-pagination background small layout="prev, pager, next" :current-page="memberQuery.page" :page-size="memberQuery.size" :total="memberTotal" @current-change="changeMemberPage" /></div>
            </template>
            <el-empty v-else description="从左侧选择一个收件箱分组" />
          </section>
        </div>
      </el-tab-pane>

      <el-tab-pane label="批次记录" name="history">
        <section class="history-filters">
          <el-input v-model="batchQuery.keyword" clearable placeholder="批次名或邮箱前缀" @keyup.enter="searchBatches" />
          <el-select v-model="batchQuery.mode" clearable placeholder="全部类型"><el-option label="收件箱" value="inbox" /><el-option label="独立账户" value="user" /></el-select>
          <el-select v-model="batchQuery.domain" clearable placeholder="全部域名"><el-option v-for="domain in settingStore.domainList" :key="domain" :label="domain" :value="domain" /></el-select>
          <el-select v-model="batchQuery.resultStatus" clearable placeholder="全部结果"><el-option label="全部成功" value="success" /><el-option label="部分失败" value="partial" /><el-option label="全部失败" value="failed" /></el-select>
          <el-button type="primary" @click="searchBatches">筛选</el-button><el-button @click="resetBatchFilters">重置</el-button>
        </section>
        <el-table :data="batches" height="520" v-loading="batchLoading" @row-click="selectBatch">
          <el-table-column prop="name" label="批次" min-width="190" /><el-table-column label="类型" width="105"><template #default="scope"><el-tag :type="scope.row.rule.mode === 'inbox' ? 'success' : 'warning'">{{ scope.row.rule.mode === 'inbox' ? '收件箱' : '独立账户' }}</el-tag></template></el-table-column><el-table-column label="规则" min-width="230"><template #default="scope">{{ formatRule(scope.row.rule) }}</template></el-table-column><el-table-column prop="successCount" label="成功" width="80" /><el-table-column prop="failedCount" label="失败" width="80" /><el-table-column prop="createTime" label="创建时间" min-width="165" />
        </el-table>
        <el-pagination class="pagination" background layout="prev, pager, next" :current-page="batchQuery.page" :page-size="batchQuery.size" :total="batchTotal" @current-change="changeBatchPage" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import {computed, onMounted, reactive, ref} from 'vue'
import {Icon} from '@iconify/vue'
import {roleSelectUse} from '@/request/role.js'
import {inboxGroupDelete, inboxGroupList, inboxGroupMembers, inboxGroupProtect, inboxGroupRestore, userBatchCreate, userBatchList, userBatchPrecheck} from '@/request/user-batch.js'
import {useSettingStore} from '@/store/setting.js'

defineOptions({name: 'user-batch'})
const settingStore = useSettingStore()
const activeTab = ref('create'), roles = ref([]), preview = ref([]), checking = ref(false), creating = ref(false), previewCreated = ref(false)
const requestId = ref('')
const modeOptions = [{label: '收件箱（默认）', value: 'inbox'}, {label: '独立账户', value: 'user'}]
const passwordModes = [{label: '随机密码', value: 'random'}, {label: '统一密码', value: 'fixed'}]
const form = reactive({mode: 'inbox', batchName: '', category: '', note: '', suffix: settingStore.domainList[0], prefix: 'user', separator: '', start: 1, count: 100, padding: 3, type: null, passwordMode: 'random', passwordLength: 12, fixedPassword: '', stopOnConflict: true})
const availableCount = computed(() => preview.value.filter(item => item.status === 'available').length)
const conflictCount = computed(() => preview.value.length - availableCount.value)
const canCreate = computed(() => preview.value.length && !previewCreated.value && availableCount.value && (!form.stopOnConflict || conflictCount.value === 0))

const groups = ref([]), groupKeyword = ref(''), showDeletedGroups = ref(false), selectedGroup = ref(null), groupMembers = ref([]), memberTotal = ref(0), membersLoading = ref(false)
const memberQuery = reactive({keyword: '', page: 1, size: 50})
const groupTree = computed(() => groups.value)
const batches = ref([]), batchTotal = ref(0), batchLoading = ref(false)
const batchQuery = reactive({keyword: '', mode: '', domain: '', resultStatus: '', page: 1, size: 20})

onMounted(async () => { roles.value = await roleSelectUse(); form.type = roles.value[0]?.roleId || null; await Promise.all([loadGroups(), loadBatches()]) })

function randomPassword(length) { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'; const bytes = new Uint32Array(length); crypto.getRandomValues(bytes); return Array.from(bytes, value => chars[value % chars.length]).join('') }
function validateForm() { if (!form.batchName.trim()) return '请输入名称'; if (!form.prefix.trim() || !/^[a-zA-Z0-9._-]+$/.test(form.prefix)) return '邮箱前缀格式不正确'; if (form.mode === 'user' && !form.type) return '请选择权限身份'; if (form.mode === 'user' && form.passwordMode === 'fixed' && form.fixedPassword.length < 6) return '统一密码至少需要 6 位'; return '' }
function clearPreview() { preview.value = []; previewCreated.value = false; requestId.value = '' }
async function generatePreview() { const error = validateForm(); if (error) return ElMessage.warning(error); checking.value = true; previewCreated.value = false; requestId.value = crypto.randomUUID(); try { const candidates = Array.from({length: form.count}, (_, index) => { const number = String(form.start + index).padStart(form.padding, '0'); return {email: `${form.prefix}${form.separator}${number}${form.suffix}`.toLowerCase(), password: form.mode === 'user' ? (form.passwordMode === 'random' ? randomPassword(form.passwordLength) : form.fixedPassword) : '', type: form.mode === 'user' ? form.type : 0} }); const checked = await userBatchPrecheck(candidates.map(item => item.email)); preview.value = candidates.map((item, index) => ({...item, ...checked.results[index], error: ''})) } finally { checking.value = false } }
async function createBatch() { const confirmed = await ElMessageBox.confirm(`将创建 ${availableCount.value} 个${form.mode === 'inbox' ? '收件箱' : '独立账户'}。`, `确认创建“${form.batchName.trim()}”`, {confirmButtonText: '确认创建', cancelButtonText: '取消', type: 'warning'}).then(() => true).catch(() => false); if (!confirmed) return; creating.value = true; try { const rows = form.stopOnConflict ? preview.value : preview.value.filter(item => item.status === 'available'); const data = await userBatchCreate({requestId: requestId.value, stopOnConflict: form.stopOnConflict, mode: form.mode, batchName: form.batchName.trim(), rule: {prefix: form.prefix, separator: form.separator, start: form.start, count: rows.length, padding: form.padding, suffix: form.suffix, category: form.category.trim(), note: form.note.trim()}, list: rows.map(({email, password, type}) => ({email, password, type}))}); const resultMap = new Map(data.results.map(item => [item.email, item])); preview.value = preview.value.map(item => resultMap.has(item.email) ? {...item, ...resultMap.get(item.email), label: resultMap.get(item.email).success ? '创建成功' : '创建失败'} : item); previewCreated.value = true; ElMessage.success(`创建完成：成功 ${data.successCount} 个，失败 ${data.failedCount} 个`); await Promise.all([loadGroups(), loadBatches()]) } finally { creating.value = false } }
function statusType(status) { return status === 'available' ? 'success' : status === 'deleted' ? 'warning' : status === 'invalid' ? 'danger' : 'info' }

async function loadGroups() { groups.value = await inboxGroupList({keyword: groupKeyword.value, deleted: showDeletedGroups.value ? '1' : '0'}); if (selectedGroup.value && !groups.value.some(item => item.groupId === selectedGroup.value.groupId)) { selectedGroup.value = null; groupMembers.value = []; memberTotal.value = 0 } }
async function selectGroup(group) { selectedGroup.value = group; Object.assign(memberQuery, {keyword: '', page: 1}); await loadMembers() }
async function loadMembers() { if (!selectedGroup.value) return; membersLoading.value = true; try { const data = await inboxGroupMembers({groupId: selectedGroup.value.groupId, ...memberQuery}); groupMembers.value = data.list; memberTotal.value = data.total } finally { membersLoading.value = false } }
function searchMembers() { memberQuery.page = 1; loadMembers() }
function changeMemberPage(page) { memberQuery.page = page; loadMembers() }
async function toggleGroupProtection() { const next = !selectedGroup.value.protected; await inboxGroupProtect({groupId: selectedGroup.value.groupId, protected: next}); selectedGroup.value.protected = next; await loadGroups(); ElMessage.success(next ? '分组已保护' : '已解除保护') }
async function removeGroup() { let confirmName = ''; if (selectedGroup.value.emailCount > 0) { const answer = await ElMessageBox.prompt(`组内有 ${selectedGroup.value.emailCount} 封邮件。输入完整组名后移入回收站。`, '高风险删除', {confirmButtonText: '移入回收站', cancelButtonText: '取消', inputPlaceholder: selectedGroup.value.name, inputValidator: value => value === selectedGroup.value.name || '组名不匹配'}).catch(() => null); if (!answer) return; confirmName = answer.value } else { const ok = await ElMessageBox.confirm(`将 ${selectedGroup.value.inboxCount} 个收件箱移入回收站，可批量恢复。`, '确认删除分组', {confirmButtonText: '移入回收站', cancelButtonText: '取消', type: 'warning'}).then(() => true).catch(() => false); if (!ok) return } await inboxGroupDelete({groupId: selectedGroup.value.groupId, confirmName, deleteInboxes: true}); selectedGroup.value = null; await loadGroups(); ElMessage.success('分组和收件箱已移入回收站') }
async function restoreGroup() { await inboxGroupRestore(selectedGroup.value.groupId); selectedGroup.value = null; await loadGroups(); ElMessage.success('分组及随组删除的收件箱已恢复') }
function exportGroup() { downloadCsv(`${selectedGroup.value.name}-收件箱.csv`, ['邮箱', '邮件数', '未读数', '最近收件', '状态'], groupMembers.value.map(item => [item.email, item.emailCount, item.unreadCount, item.latestEmailTime, item.isDel ? '已删除' : '正常'])) }

async function loadBatches() { batchLoading.value = true; try { const data = await userBatchList(batchQuery); batches.value = data.list; batchTotal.value = data.total } finally { batchLoading.value = false } }
function searchBatches() { batchQuery.page = 1; loadBatches() }
function resetBatchFilters() { Object.assign(batchQuery, {keyword: '', mode: '', domain: '', resultStatus: '', page: 1}); loadBatches() }
function changeBatchPage(page) { batchQuery.page = page; loadBatches() }
function selectBatch() {}
function formatRule(rule = {}) { return `${rule.prefix || ''}${rule.separator || ''}${String(rule.start || 0).padStart(rule.padding || 1, '0')}…${rule.suffix || ''}，${rule.count || 0} 个` }
function refreshCurrent() { if (activeTab.value === 'groups') loadGroups(); else if (activeTab.value === 'history') loadBatches(); else generatePreview() }
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"` }
function downloadCsv(filename, headers, rows) { const content = '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n'); const url = URL.createObjectURL(new Blob([content], {type: 'text/csv;charset=utf-8'})); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url) }
function exportCurrent() { const headers = form.mode === 'user' ? ['邮箱', '密码', '状态', '说明'] : ['邮箱', '状态', '说明']; const rows = preview.value.map(item => form.mode === 'user' ? [item.email, item.password, item.label, item.error] : [item.email, item.label, item.error]); downloadCsv(`${form.batchName || '批量创建'}.csv`, headers, rows) }
</script>

<style scoped lang="scss">
.batch-page { height: 100%; overflow: auto; padding: 18px 22px 30px; box-sizing: border-box; }.page-toolbar,.section-heading { display:flex; align-items:center; justify-content:space-between; gap:16px } h2,h3 { margin:0; letter-spacing:0 }.page-toolbar p,.section-heading span { margin:5px 0 0; color:var(--el-text-color-secondary); font-size:13px }
.mode-section { display:flex; align-items:center; gap:18px; padding:8px 0 18px; flex-wrap:wrap }.mode-label { font-weight:600 }.mode-facts { display:flex; gap:18px; color:var(--el-text-color-regular); font-size:13px }.mode-facts span { display:flex; align-items:center; gap:5px }.rule-section,.preview-section,.group-tree-panel,.group-detail { border-top:1px solid var(--el-border-color); padding-top:18px }.rule-grid { display:grid; grid-template-columns:repeat(4,minmax(150px,1fr)); gap:0 16px }.rule-grid :deep(.el-input-number),.rule-grid :deep(.el-select) { width:100% }.create-policy { display:flex; align-items:center; gap:14px; flex-wrap:wrap }.actions { display:flex; justify-content:flex-end; gap:10px; margin:14px 0 18px }.preview-section { margin-top:4px }.section-heading { margin-bottom:14px }.muted { color:var(--el-text-color-secondary); font-size:12px }
.group-toolbar { display:flex; gap:12px; align-items:center; padding:4px 0 16px }.group-toolbar .el-input { max-width:300px }.group-layout { display:grid; grid-template-columns:minmax(280px,.55fr) minmax(620px,1.45fr); gap:22px }.group-tree-panel { min-height:540px }.tree-node { display:flex; align-items:center; gap:8px; width:100%; min-width:0 }.tree-node span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap }.group-actions { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end }.member-filter { display:grid; grid-template-columns:minmax(220px,1fr) auto; gap:10px; margin-bottom:12px }.detail-footer { display:flex; justify-content:space-between; align-items:center; margin-top:12px }
.history-filters { display:grid; grid-template-columns:minmax(200px,1fr) 150px 180px 150px auto auto; gap:10px; padding:4px 0 16px }.pagination { justify-content:center; margin-top:14px }
@media(max-width:1200px){.rule-grid{grid-template-columns:repeat(2,minmax(150px,1fr))}.group-layout{grid-template-columns:1fr}.history-filters{grid-template-columns:repeat(3,1fr)}}
@media(max-width:600px){.batch-page{padding:14px}.rule-grid,.history-filters,.member-filter{grid-template-columns:1fr}.page-toolbar,.section-heading{align-items:flex-start;flex-wrap:wrap}.mode-facts{flex-direction:column;gap:6px}.group-layout{display:block}.group-detail{margin-top:20px}.group-actions{justify-content:flex-start}.detail-footer{flex-direction:column;align-items:flex-start;gap:8px}.group-toolbar{align-items:flex-start;flex-direction:column}.group-toolbar .el-input{max-width:none;width:100%}}
</style>
