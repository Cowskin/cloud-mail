import http from '@/axios/index.js';

export const cardProtectionStatus = () => http.get('/setting/cardProtection/status', { noMsg: true });
export const cardProtectionUpdate = params => http.put('/setting/cardProtection/update', params, { noMsg: true });
export const giftWebhookStatus = () => http.get('/setting/giftWebhook/status', { noMsg: true });
export const giftWebhookUpdate = params => http.put('/setting/giftWebhook/update', params, { noMsg: true });

export function settingSet(setting) {
    return http.put('/setting/set', setting)
}

export function settingQuery() {
    return http.get('/setting/query')
}

export function websiteConfig() {
    return http.get('/setting/websiteConfig')
}

export function setBackground(background) {
    return http.put('/setting/setBackground',{background})
}

export function deleteBackground() {
    return http.delete('/setting/deleteBackground')
}

export function setBlackList(params) {
    return http.put('/setting/setBlacklist', params)
}
