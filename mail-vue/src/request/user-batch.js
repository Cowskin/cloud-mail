import http from '@/axios/index.js'

export function userBatchCreate(data) {
    return http.post('/userBatch/create', data)
}

export function userBatchList(params = {}) {
    return http.get('/userBatch/list', {params})
}

export function userBatchItems(params) {
    return http.get('/userBatch/items', {params})
}

export function userBatchUpdate(data) {
    return http.put('/userBatch/update', data)
}

export function userBatchDelete(batchId) {
    return http.delete('/userBatch/delete', {params: {batchId}})
}

export function userBatchPrecheck(emails) {
    return http.post('/userBatch/precheck', {emails})
}

export function inboxGroupList(params = {}) {
    return http.get('/inboxGroup/list', {params})
}

export function inboxGroupMembers(params) {
    return http.get('/inboxGroup/members', {params})
}

export function inboxGroupProtect(data) {
    return http.put('/inboxGroup/protect', data)
}

export function inboxGroupDelete(data) {
    return http.delete('/inboxGroup/delete', {data})
}

export function inboxGroupRestore(groupId) {
    return http.put('/inboxGroup/restore', {groupId})
}
