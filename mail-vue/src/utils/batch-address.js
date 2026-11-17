export const addressModes = [
    {label: '顺序编号', value: 'sequence'},
    {label: '随机字符', value: 'random'},
    {label: '编号 + 随机', value: 'sequenceRandom'},
]

export const characterSets = [
    {label: '小写字母 + 数字', value: 'alphanumeric'},
    {label: '小写字母', value: 'letters'},
    {label: '纯数字', value: 'digits'},
]

export function randomAlphabet(rule) {
    const alphabet = {alphanumeric: 'abcdefghijklmnopqrstuvwxyz0123456789', letters: 'abcdefghijklmnopqrstuvwxyz', digits: '0123456789'}[rule.randomCharset]
    return alphabet && rule.excludeAmbiguous ? alphabet.replace(/[01ilo]/g, '') : alphabet
}

const usesSequence = rule => rule.addressMode !== 'random'
export const usesRandom = rule => ['random', 'sequenceRandom'].includes(rule.addressMode)

function localPart(rule, index, token = '') {
    const prefix = String(rule.prefix || '').toLowerCase()
    const number = String(rule.start + index).padStart(rule.padding, '0')
    const variable = rule.addressMode === 'random' ? token : rule.addressMode === 'sequenceRandom' ? `${number}${rule.separator}${token}` : number
    return `${prefix}${prefix ? rule.separator : ''}${variable}`
}

export function validateAddressRule(rule) {
    if (!addressModes.some(item => item.value === (rule.addressMode || 'sequence'))) return '请选择邮箱命名方式'
    if (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 500) return '创建数量需为 1–500 的整数'
    if (typeof rule.suffix !== 'string' || !/^@([a-z0-9-]+\.)+[a-z]{2,}$/i.test(rule.suffix)) return '请选择邮箱域名'
    if (!['', '-', '_', '.'].includes(rule.separator)) return '请选择有效的分隔符'
    if (rule.prefix && !/^[a-z0-9._-]+$/i.test(rule.prefix)) return '邮箱前缀只支持字母、数字、点号、短横线和下划线'
    if (!rule.prefix && !usesRandom(rule)) return '请输入邮箱前缀'
    if (usesSequence(rule) && (!Number.isInteger(rule.start) || rule.start < 0 || rule.start > 999999 || !Number.isInteger(rule.padding) || rule.padding < 1 || rule.padding > 8)) return '起始编号需为 0–999999，编号位数需为 1–8 的整数'
    if (usesRandom(rule)) {
        if (!randomAlphabet(rule)) return '请选择随机字符类型'
        if (!Number.isInteger(rule.randomLength) || rule.randomLength < 4 || rule.randomLength > 32) return '随机长度需为 4–32 的整数'
        if (rule.addressMode === 'random' && randomAlphabet(rule).length ** rule.randomLength < rule.count) return '随机组合不足，请增加随机长度或减少创建数量'
    }
    const longest = localPart(rule, rule.count - 1, 'a'.repeat(usesRandom(rule) ? rule.randomLength : 0))
    if (longest.length > 64) return '邮箱 @ 前最多 64 个字符，请缩短前缀或随机长度'
    if (longest.startsWith('.') || longest.endsWith('.') || longest.includes('..')) return '邮箱前缀与分隔符组合不能以点号开头、结尾或出现连续点号'
    return ''
}

// Rejection sampling avoids modulo bias for alphabets whose size does not divide 256.
function randomToken(length, alphabet, fillRandom) {
    const limit = 256 - (256 % alphabet.length)
    let token = ''
    for (let round = 0; token.length < length && round < 128; round++) {
        const bytes = new Uint8Array(Math.max(32, (length - token.length) * 2))
        fillRandom(bytes)
        for (const byte of bytes) {
            if (byte < limit) token += alphabet[byte % alphabet.length]
            if (token.length === length) break
        }
    }
    if (token.length !== length) throw new Error('随机字符生成失败，请重新检测')
    return token
}

export function generateBatchAddresses(rule, fillRandom = bytes => crypto.getRandomValues(bytes)) {
    const error = validateAddressRule(rule)
    if (error) throw new Error(error)
    const seen = new Set(), emails = []
    const alphabet = randomAlphabet(rule)
    for (let index = 0; index < rule.count; index++) {
        let email
        for (let attempt = 0; attempt < 100; attempt++) {
            const token = usesRandom(rule) ? randomToken(rule.randomLength, alphabet, fillRandom) : ''
            email = `${localPart(rule, index, token)}${rule.suffix}`.toLowerCase()
            if (!seen.has(email)) break
        }
        if (seen.has(email)) throw new Error('随机地址重复过多，请增加随机长度后重新检测')
        seen.add(email)
        emails.push(email)
    }
    return emails
}

export function addressExample(rule) {
    if (validateAddressRule(rule)) return ''
    const alphabet = randomAlphabet(rule)
    const token = usesRandom(rule) ? Array.from({length: rule.randomLength}, (_, index) => alphabet[(index * 7 + 3) % alphabet.length]).join('') : ''
    return `${localPart(rule, 0, token)}${rule.suffix}`.toLowerCase()
}

export function formatAddressRule(rule = {}) {
    const prefix = `${rule.prefix || ''}${rule.prefix ? rule.separator || '' : ''}`
    const number = String(rule.start || 0).padStart(rule.padding || 1, '0')
    const random = `${rule.randomLength || 8}位随机${({alphanumeric: '字母数字', letters: '字母', digits: '数字'})[rule.randomCharset] || '字符'}`
    const variable = rule.addressMode === 'random' ? `[${random}]` : rule.addressMode === 'sequenceRandom' ? `${number}${rule.separator || ''}[${random}]` : `${number}…`
    return `${prefix}${variable}${rule.suffix || ''}，${rule.count || 0} 个`
}
