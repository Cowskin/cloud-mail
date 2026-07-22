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
