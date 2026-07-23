import http from '@/axios/index.js'

export function accountList(accountId, size, lastSort) {
    return http.get('/account/list', {params: {accountId, size, lastSort}});
}

export function accountAdd(email,token) {
    return http.post('/account/add', {email,token})
}

export function accountSetName(accountId,name) {
    return http.put('/account/setName', {name,accountId})
}

export function accountDelete(accountId) {
    return http.delete('/account/delete', {params: {accountId}})
}

export function accountDeletedList() {
    return http.get('/account/deletedList')
}

export function accountRestore(accountId) {
    return http.put('/account/restore', {accountId})
}

export function accountSetAllReceive(accountId) {
    return http.put('/account/setAllReceive', {accountId})
}

export function accountSetAsTop(accountId) {
    return http.put('/account/setAsTop', {accountId})
}
