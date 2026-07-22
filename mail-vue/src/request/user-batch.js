import http from '@/axios/index.js'

export function userBatchCreate(data) {
    return http.post('/userBatch/create', data)
}

export function userBatchList(keyword = '') {
    return http.get('/userBatch/list', {params: {keyword}})
}

export function userBatchItems(params) {
    return http.get('/userBatch/items', {params})
}